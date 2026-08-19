import {
  decodeServerMsg,
  encodeClientMsg,
  type ClientMsg,
  type ServerMsg,
} from "./proto";

type HelloMsg = Extract<ClientMsg, { kind: "Hello" }>;

export type ConnState =
  | { kind: "connecting" }
  | { kind: "open" }
  | { kind: "reconnecting"; attempt: number }
  | { kind: "closed"; reason: string };

export interface ConnOptions {
  url: string;
  hello: () => HelloMsg;
  onMessage: (msg: ServerMsg) => void;
  onState?: (state: ConnState) => void;
}

const MAX_BACKOFF_MS = 8000;
const MIN_BACKOFF_MS = 250;

export class Conn {
  private socket: WebSocket | null = null;
  private opts: ConnOptions;
  private lastSeq: number | null = null;
  private attempt = 0;
  private closed = false;
  private outbox: Uint8Array<ArrayBuffer>[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: ConnOptions) {
    this.opts = opts;
    this.open();
  }

  send(msg: ClientMsg): void {
    const bytes = encodeClientMsg(msg);
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(bytes);
    } else {
      this.outbox.push(bytes);
    }
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.socket) this.socket.close();
    this.report({ kind: "closed", reason: "manual" });
  }

  private open(): void {
    this.report({ kind: this.attempt === 0 ? "connecting" : "reconnecting", attempt: this.attempt });
    const ws = new WebSocket(this.opts.url);
    ws.binaryType = "arraybuffer";
    this.socket = ws;

    ws.onopen = () => {
      this.attempt = 0;
      const hello = this.opts.hello();
      if (this.lastSeq !== null) {
        hello.hello.resume_from = this.lastSeq;
      }
      ws.send(encodeClientMsg(hello));
      for (const queued of this.outbox.splice(0)) ws.send(queued);
      this.report({ kind: "open" });
    };

    ws.onmessage = (ev) => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      let msg: ServerMsg;
      try {
        msg = decodeServerMsg(new Uint8Array(ev.data));
      } catch (e) {
        console.error("decode failed", e);
        return;
      }
      this.trackSeq(msg);
      this.opts.onMessage(msg);
    };

    ws.onerror = () => {
      // onclose will follow with details
    };

    ws.onclose = (ev) => {
      this.socket = null;
      if (this.closed) return;
      if (ev.code === 1008 || ev.code === 1011) {
        this.closed = true;
        this.report({ kind: "closed", reason: `server close ${ev.code}` });
        return;
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    this.attempt += 1;
    const delay = Math.min(
      MAX_BACKOFF_MS,
      MIN_BACKOFF_MS * Math.pow(2, this.attempt - 1),
    );
    this.report({ kind: "reconnecting", attempt: this.attempt });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) this.open();
    }, delay);
  }

  private trackSeq(msg: ServerMsg): void {
    switch (msg.kind) {
      case "Welcome":
      case "Stroke":
      case "Chat":
      case "Guess":
      case "Presence":
      case "Game":
      case "Voice":
        this.lastSeq = msg.seq;
        return;
      case "Resume":
        for (const e of msg.events) this.trackSeq(e);
        return;
      case "Bye":
        if (msg.reason !== "Reconnect") {
          this.closed = true;
          this.report({ kind: "closed", reason: `bye:${msg.reason}` });
        }
        return;
      case "Ping":
        // We don't reply explicitly; axum handles ws-level ping/pong.
        return;
    }
  }

  private report(state: ConnState): void {
    if (this.opts.onState) this.opts.onState(state);
  }
}
