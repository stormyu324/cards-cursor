// 联机房间的 WebSocket 连接，断线后自动重连。
export function connectRoom(url, hello, handlers) {
  let ws = null;
  let closed = false;
  let tries = 0;

  function open() {
    handlers.status("connecting");
    ws = new WebSocket(url);
    ws.onopen = () => {
      tries = 0;
      ws.send(JSON.stringify({ t: "hello", ...hello }));
      handlers.status("open");
    };
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.t === "error") {
        if (msg.fatal) closed = true;
        handlers.error(msg.error, Boolean(msg.fatal));
      } else if (msg.t === "state") handlers.state(msg);
    };
    ws.onclose = (event) => {
      if (closed) return;
      if (event.code === 4001) {
        closed = true;
        handlers.error("已在别的窗口打开这个房间", true);
        return;
      }
      handlers.status("closed");
      setTimeout(open, Math.min(5000, 500 * 2 ** tries));
      tries += 1;
    };
  }

  open();
  return {
    send(msg) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    close() {
      closed = true;
      ws.close();
    },
  };
}
