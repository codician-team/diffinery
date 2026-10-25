// The web terminal (phase 4): xterm.js on a WebSocket to the shell in the person's sandbox.
// Loaded only on the terminal page, which renders <div id="dfy-terminal" data-socket="/o/r/terminals/<id>/socket">.
// Terminal bytes travel as binary frames both ways; resizes and pings are JSON text frames.
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

const el = document.getElementById("dfy-terminal");
const statusEl = document.getElementById("dfy-terminal-status");
if (el?.dataset.socket) {
  const css = getComputedStyle(document.body);
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: css.getPropertyValue("--mono").trim() || "ui-monospace, Menlo, monospace",
    fontSize: 13,
    scrollback: 5000,
    allowProposedApi: false,
    theme: { background: "#111113", foreground: "#ededed", cursor: "#ededed", selectionBackground: "#3b4b6b" },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);
  fit.fit();

  const encoder = new TextEncoder();
  let ws: WebSocket | null = null;
  let tries = 0;
  let stopped = false;
  const say = (text: string, tone: "" | "ok" | "warn" = "") => {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.dataset.tone = tone;
  };
  const send = (data: string) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(encoder.encode(data));
  };
  const resize = () => {
    fit.fit();
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
  };

  const connect = () => {
    const url = `${location.protocol === "https:" ? "wss://" : "ws://"}${location.host}${el.dataset.socket}?cols=${term.cols}&rows=${term.rows}`;
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    ws = socket;
    say("Connecting…");
    socket.onopen = () => {
      tries = 0;
      say("Connected", "ok");
      term.reset();
      term.focus();
    };
    socket.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) term.write(new Uint8Array(e.data));
    };
    socket.onclose = (e) => {
      if (ws !== socket) return;
      ws = null;
      if (e.code === 4000) {
        stopped = true;
        say("This terminal is open in another tab. Reload to use it here.", "warn");
        return;
      }
      if (e.reason === "terminal ended" || e.code === 4404) {
        stopped = true;
        say("The terminal ended.", "warn");
        setTimeout(() => location.reload(), 1500);
        return;
      }
      if (e.reason === "the shell exited") {
        say("The shell exited. Starting a new one…");
        setTimeout(connect, 500);
        return;
      }
      if (stopped || tries >= 8) {
        say("Disconnected. Reload the page to try again.", "warn");
        return;
      }
      const wait = Math.min(15_000, 500 * 2 ** tries++);
      say(`Disconnected. Reconnecting in ${Math.round(wait / 1000)} s…`, "warn");
      setTimeout(connect, wait);
    };
  };

  term.onData(send);
  term.onBinary((data) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(Uint8Array.from(data, (c) => c.charCodeAt(0)));
  });
  new ResizeObserver(() => resize()).observe(el);
  setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
  }, 25_000);
  // Toolbar buttons type a command into the shell, as if the person typed it.
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-terminal-type]")) {
    b.addEventListener("click", () => {
      send(`${b.dataset.terminalType}\r`);
      term.focus();
    });
  }
  connect();
}
