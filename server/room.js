// 联机房间的规则层：座位、发牌、出牌校验、电脑补位。不依赖任何运行环境，方便测试。
import { applyBid, applyPlay, createGame } from "../js/engine.js";
import { aiBid, aiChoose } from "../js/ai.js";

export const AI_DELAY = 900;
export const AWAY_DELAY = 1500;
export const TURN_LIMIT = 40000;
export const IDLE_MS = 3 * 60 * 60 * 1000;
const CLAIM_GRACE = 60 * 1000;

// The engine writes its log from seat 0's point of view.
const SEAT_NAMES = ["你", "下家", "上家"];

export function cleanName(raw) {
  const name = String(raw ?? "")
    .replace(/[<>&"'`\s]/g, "")
    .slice(0, 8);
  return name || "玩家";
}

export class Room {
  constructor(snapshot) {
    this.seats = [null, null, null];
    this.host = null;
    this.game = null;
    this.scores = [0, 0, 0];
    this.deals = 0;
    this.turnAt = 0;
    this.event = null;
    this.seq = 0;
    this.claimed = false;
    this.touched = 0;
    if (snapshot) {
      Object.assign(this, structuredClone(snapshot));
      // Nobody is connected right after a restore.
      for (const seat of this.seats) if (seat) seat.online = false;
    }
  }

  snapshot() {
    const { seats, host, game, scores, deals, turnAt, event, seq, claimed, touched } = this;
    return { seats, host, game, scores, deals, turnAt, event, seq, claimed, touched };
  }

  taken(now) {
    if (!this.claimed) return false;
    const limit = this.seats.some(Boolean) ? IDLE_MS : CLAIM_GRACE;
    return now - this.touched < limit;
  }

  claim(now) {
    Object.assign(this, new Room());
    this.claimed = true;
    this.touched = now;
  }

  seatOf(pid) {
    return this.seats.findIndex((seat) => seat && seat.pid === pid);
  }

  playing() {
    return Boolean(this.game) && this.game.phase !== "over";
  }

  fixHost() {
    if (this.seatOf(this.host) >= 0) return;
    const next = this.seats.find((seat) => seat && seat.online) || this.seats.find(Boolean);
    this.host = next ? next.pid : null;
  }

  join(pid, name, now) {
    if (!this.claimed) return { ok: false, error: "房间不存在" };
    let seat = this.seatOf(pid);
    if (seat < 0) {
      seat = this.seats.indexOf(null);
      if (seat < 0) return { ok: false, error: "房间已满" };
      this.seats[seat] = { pid, name: cleanName(name), online: true };
      // Someone taking over a computer seat mid-turn gets a full turn.
      if (this.playing() && this.game.turn === seat) this.turnAt = now;
    } else {
      this.seats[seat].online = true;
      this.seats[seat].name = cleanName(name);
    }
    this.fixHost();
    this.touched = now;
    return { ok: true, seat };
  }

  // Connection lost: keep the seat during a game so the player can come back.
  drop(pid) {
    const seat = this.seatOf(pid);
    if (seat < 0) return;
    if (this.game) this.seats[seat].online = false;
    else this.seats[seat] = null;
    this.fixHost();
  }

  leave(pid) {
    const seat = this.seatOf(pid);
    if (seat < 0) return;
    this.seats[seat] = null;
    this.fixHost();
  }

  start(pid, now, rng = Math.random) {
    if (this.seatOf(pid) < 0) return { ok: false, error: "你不在这个房间" };
    if (this.playing()) return { ok: false, error: "牌局进行中" };
    if (!this.game && pid !== this.host) return { ok: false, error: "等待房主开始" };
    this.seats = this.seats.map((seat) => (seat && seat.online ? seat : null));
    this.fixHost();
    this.deals += 1;
    this.game = createGame({ rng, scores: this.scores, dealId: this.deals });
    this.mark({ kind: "deal", seat: -1 }, now);
    return { ok: true };
  }

  mark(event, now) {
    this.seq += 1;
    this.event = { ...event, seq: this.seq };
    this.turnAt = now;
    this.touched = now;
    if (this.game.phase === "over") this.scores = [...this.game.scores];
  }

  applyBid(seat, bid, now, rng = Math.random) {
    if (!this.playing()) return { ok: false, error: "现在不是叫分" };
    const res = applyBid(this.game, seat, bid, rng);
    if (!res.ok) return { ok: false, error: res.error };
    this.game = res.state;
    this.mark({ kind: "bid", seat, bid }, now);
    return { ok: true };
  }

  applyPlay(seat, cards, now) {
    if (!this.playing()) return { ok: false, error: "现在不能出牌" };
    const res = applyPlay(this.game, seat, cards);
    if (!res.ok) return { ok: false, error: res.error };
    this.game = res.state;
    const entry = this.game.table[seat];
    this.mark({ kind: entry.kind, seat, type: entry.type }, now);
    return { ok: true };
  }

  bid(pid, bid, now, rng) {
    const seat = this.seatOf(pid);
    if (seat < 0) return { ok: false, error: "你不在这个房间" };
    return this.applyBid(seat, Number(bid), now, rng);
  }

  play(pid, ids, now) {
    const seat = this.seatOf(pid);
    if (seat < 0) return { ok: false, error: "你不在这个房间" };
    const cards = Array.isArray(ids) ? ids.slice(0, 20).map((id) => ({ id: String(id) })) : null;
    return this.applyPlay(seat, cards, now);
  }

  // How long until the computer should act for whoever's turn it is, or null.
  nextAuto(now) {
    if (!this.playing()) return null;
    const seat = this.seats[this.game.turn];
    const limit = !seat ? AI_DELAY : seat.online ? TURN_LIMIT : AWAY_DELAY;
    return Math.max(0, this.turnAt + limit - now);
  }

  auto(now, rng) {
    if (!this.playing()) return { ok: false };
    const game = this.game;
    const seat = game.turn;
    if (game.phase === "bid") return this.applyBid(seat, aiBid(game.hands[seat], game.bidMax), now, rng);
    return this.applyPlay(seat, aiChoose(game, seat), now);
  }

  // What one player is allowed to see, turned so that they sit at seat 0.
  view(pid, now) {
    const me = Math.max(0, this.seatOf(pid));
    const rot = (p) => (p < 0 ? p : (p - me + 3) % 3);
    const spin = (list) => {
      const out = [];
      list.forEach((value, p) => {
        out[rot(p)] = value;
      });
      return out;
    };
    const game = this.game;
    const turnSeat = this.playing() ? this.seats[game.turn] : null;
    return {
      t: "state",
      seats: this.seats.map(
        (seat) =>
          seat && { name: seat.name, online: seat.online, you: seat.pid === pid, host: seat.pid === this.host },
      ),
      host: this.host === pid,
      names: spin(this.seats.map((seat) => (seat ? { name: seat.name, online: seat.online } : null))),
      event: this.event && { ...this.event, seat: rot(this.event.seat) },
      turnLeft: turnSeat && turnSeat.online ? Math.max(0, this.turnAt + TURN_LIMIT - now) : null,
      game: game && {
        ...game,
        hands: spin(game.hands.map((hand, p) => (p === me || game.phase === "over" ? hand : hand.map(() => null)))),
        bottom: game.landlord < 0 ? [] : game.bottom,
        scores: spin(game.scores),
        bids: spin(game.bids),
        playedCount: spin(game.playedCount),
        roundScore: spin(game.roundScore),
        table: spin(game.table),
        turn: rot(game.turn),
        bidOwner: rot(game.bidOwner),
        landlord: rot(game.landlord),
        winner: rot(game.winner),
        lastPlay: game.lastPlay && { ...game.lastPlay, player: rot(game.lastPlay.player) },
        log: game.log.slice(-2).map((line) => {
          const seat = SEAT_NAMES.findIndex((name) => line.startsWith(`${name} `));
          return seat < 0 ? line : SEAT_NAMES[rot(seat)] + line.slice(SEAT_NAMES[seat].length);
        }),
      },
    };
  }
}
