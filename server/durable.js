// Cloudflare 上的联机入口：每个房间号对应一个 Durable Object，持有牌局并向各玩家推送各自能看到的局面。
import { DurableObject } from "cloudflare:workers";
import { IDLE_MS, Room } from "./room.js";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export class DdzRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sockets = new Map();
    this.timer = null;
    this.room = new Room();
    ctx.blockConcurrencyWhile(async () => {
      this.room = new Room(await ctx.storage.get("room"));
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/claim")) {
      const now = Date.now();
      if (this.sockets.size || this.room.taken(now)) return json({ ok: false });
      this.room.claim(now);
      await this.ctx.storage.put("room", this.room.snapshot());
      return json({ ok: true });
    }
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    this.sockets.set(server, null);
    server.addEventListener("message", (event) => this.onMessage(server, event.data));
    server.addEventListener("close", () => this.onClose(server));
    server.addEventListener("error", () => this.onClose(server));
    return new Response(null, { status: 101, webSocket: client });
  }

  reject(ws, error) {
    ws.send(JSON.stringify({ t: "error", error, fatal: true }));
    this.sockets.delete(ws);
    ws.close(4000, "rejected");
  }

  onMessage(ws, data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    const now = Date.now();
    let pid = this.sockets.get(ws);

    if (msg.t === "hello") {
      if (pid || typeof msg.pid !== "string" || !/^[\w-]{8,64}$/.test(msg.pid)) return;
      const res = this.room.join(msg.pid, msg.name, now);
      if (!res.ok) return this.reject(ws, res.error);
      // A second tab from the same player replaces the first.
      for (const [other, otherPid] of this.sockets) {
        if (other !== ws && otherPid === msg.pid) {
          this.sockets.delete(other);
          other.close(4001, "replaced");
        }
      }
      this.sockets.set(ws, msg.pid);
      return this.sync();
    }
    if (!pid) return;

    let res = { ok: true };
    if (msg.t === "start" || msg.t === "again") res = this.room.start(pid, now);
    else if (msg.t === "bid") res = this.room.bid(pid, msg.bid, now);
    else if (msg.t === "play") res = this.room.play(pid, msg.ids, now);
    else if (msg.t === "pass") res = this.room.play(pid, null, now);
    else if (msg.t === "leave") {
      this.room.leave(pid);
      this.sockets.delete(ws);
      ws.close(1000, "left");
    } else return;

    if (!res.ok) ws.send(JSON.stringify({ t: "error", error: res.error }));
    else this.sync();
  }

  onClose(ws) {
    if (!this.sockets.has(ws)) return;
    const pid = this.sockets.get(ws);
    this.sockets.delete(ws);
    if (pid) this.room.drop(pid);
    this.sync();
    if (!this.sockets.size) this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
  }

  sync() {
    const now = Date.now();
    for (const [ws, pid] of this.sockets) {
      if (!pid) continue;
      try {
        ws.send(JSON.stringify(this.room.view(pid, now)));
      } catch {
        /* the close handler cleans up */
      }
    }
    this.ctx.storage.put("room", this.room.snapshot());
    clearTimeout(this.timer);
    // With nobody connected the game simply waits.
    const wait = this.sockets.size ? this.room.nextAuto(now) : null;
    if (wait !== null) {
      this.timer = setTimeout(() => {
        this.room.auto(Date.now());
        this.sync();
      }, wait);
    }
  }

  async alarm() {
    if (this.sockets.size) return;
    await this.ctx.storage.deleteAll();
    this.room = new Room();
  }
}

// Handles everything under <game>/api/. `path` is the part after "api/".
export async function handleApi(request, env, path) {
  const rooms = env.DDZ_ROOMS;
  if (path === "create" && request.method === "POST") {
    for (let i = 0; i < 12; i += 1) {
      const code = String(1000 + Math.floor(Math.random() * 9000));
      const res = await rooms.get(rooms.idFromName(code)).fetch("https://room/claim");
      if ((await res.json()).ok) return json({ code });
    }
    return json({ error: "房间已满，请稍后再试" }, 503);
  }
  const match = /^room\/(\d{4})\/ws$/.exec(path);
  if (match) return rooms.get(rooms.idFromName(match[1])).fetch(request);
  return json({ error: "not found" }, 404);
}
