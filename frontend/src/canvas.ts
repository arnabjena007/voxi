import { MAX_POINTS_PER_BATCH, type ClientMsg, type Point, type ServerMsg } from "./proto";

const LOGICAL_WIDTH = 960;
const LOGICAL_HEIGHT = 600;
const VELOCITY_FACTOR = 0.04;
const WIDTH_SMOOTHING = 0.55;
const MIN_WIDTH_FACTOR = 0.4;
const MAX_WIDTH_FACTOR = 1.4;
const JITTER_BUFFER_MS = 50;
const BATCH_INTERVAL_MS = 16;
const I8_MAX = 127;
const I8_MIN = -128;

const ERASER_COLOR = 0xffffff;

interface StrokeRender {
  color: string;
  baseWidth: number;
  isEraser: boolean;
  prevX: number;
  prevY: number;
  drawnX: number;
  drawnY: number;
  prevT: number;
  width: number;
}

interface LocalStroke {
  strokeId: number;
  originX: number;
  originY: number;
  lastX: number;
  lastY: number;
  lastT: number;
  color: number;
  baseWidth: number;
  pending: Point[];
  allPoints: Point[]; // every emitted delta for later resize replays
  render: StrokeRender;
  pointerId: number;
}

interface RemotePointBuffered {
  absX: number;
  absY: number;
  dt: number;
  arrivedAt: number;
  finished: boolean;
}

interface RemoteStroke {
  player: number;
  strokeId: number;
  buffered: RemotePointBuffered[];
  render: StrokeRender | null;
  finished: boolean;
  origin: [number, number];
  color: number;
  baseWidth: number;
  lastAbsX: number;
  lastAbsY: number;
  allPoints: Point[]; // every received delta, for resize replays
}

interface CompletedRecord {
  origin: [number, number];
  color: number;
  width: number;
  points: Point[];
  // "local" = this client drew it (and, if accepted by server, the server
  // echoes it through the snapshot path, not the stroke handler);
  // "remote" = received from another player via TrackSubscribed / snapshot.
  // Used by clearLocal() to wipe only this client's own doodles while
  // preserving the drawer's strokes during a guessing round.
  source: "local" | "remote";
}

export class DrawingSurface {
  private ctx: CanvasRenderingContext2D;
  private nextStrokeId = 1;
  private localStrokes = new Map<number, LocalStroke>();
  private remoteStrokes = new Map<string, RemoteStroke>();
  private youId: number | null = null;
  private sendBatched: ((msg: ClientMsg) => void) | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private currentColor = 0x2d3436;
  private currentWidth = 4;
  private dpr = 1;
  private cssWidth = 0;
  private cssHeight = 0;
  private completedStrokes: CompletedRecord[] = [];

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d canvas context unavailable");
    this.ctx = ctx;

    canvas.style.touchAction = "none";
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerEnd);
    canvas.addEventListener("pointercancel", this.onPointerEnd);
    canvas.addEventListener("pointerleave", this.onPointerEnd);

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas);
    this.resize();
    window.addEventListener("resize", () => this.resize());

    requestAnimationFrame(this.drainJitterBuffer);
  }

  attachSender(send: (msg: ClientMsg) => void): void {
    this.sendBatched = send;
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = setInterval(this.flushPending, BATCH_INTERVAL_MS);
  }

  setYouId(id: number): void {
    this.youId = id;
  }

  setColor(rgb: number): void {
    this.currentColor = rgb & 0xffffff;
  }

  setWidth(width: number): void {
    this.currentWidth = Math.max(1, Math.min(255, Math.round(width)));
  }

  clear(): void {
    this.completedStrokes = [];
    this.remoteStrokes.clear();
    this.repaint();
  }

  // Wipe only strokes this client drew locally. Used when a non-drawer hits
  // Clear during a Drawing round: the shared canvas (drawer's strokes) must
  // stay intact, but their own local doodles vanish.
  clearLocal(): void {
    this.completedStrokes = this.completedStrokes.filter(
      (s) => s.source !== "local",
    );
    this.repaint();
  }

  private repaint(): void {
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.restore();
    this.applyTransform();
    for (const rec of this.completedStrokes) {
      this.paintRecord(rec);
    }
  }

  private paintRecord(rec: CompletedRecord): void {
    if (rec.points.length === 0) return;
    const render = newRender(
      rgbToCss(rec.color),
      rec.width,
      rec.origin[0],
      rec.origin[1],
      rec.color === ERASER_COLOR,
    );
    let curX = rec.origin[0];
    let curY = rec.origin[1];
    let curT = 0;
    for (const p of rec.points) {
      curX += p.dx;
      curY += p.dy;
      curT += p.dt;
      drawSegment(this.ctx, render, curX, curY, curT);
    }
    finishStrokeAt(this.ctx, render, curX, curY);
  }

  handleStrokeMessage(
    player: number,
    strokeId: number,
    origin: [number, number],
    color: number,
    width: number,
    points: Point[],
    finished: boolean,
  ): void {
    if (this.youId !== null && player === this.youId) return;

    const key = `${player}/${strokeId}`;
    let stroke = this.remoteStrokes.get(key);
    if (!stroke) {
      stroke = {
        player,
        strokeId,
        buffered: [],
        render: null,
        finished: false,
        origin,
        color,
        baseWidth: width,
        lastAbsX: origin[0],
        lastAbsY: origin[1],
        allPoints: [],
      };
      this.remoteStrokes.set(key, stroke);
    }

    const now = performance.now();
    for (const p of points) {
      stroke.lastAbsX += p.dx;
      stroke.lastAbsY += p.dy;
      stroke.allPoints.push(p);
      stroke.buffered.push({
        absX: stroke.lastAbsX,
        absY: stroke.lastAbsY,
        dt: p.dt,
        arrivedAt: now,
        finished: false,
      });
    }
    if (finished) {
      const last = stroke.buffered[stroke.buffered.length - 1];
      if (last) last.finished = true;
      else stroke.finished = true;
    }
  }

  applySnapshot(msg: ServerMsg & { kind: "Welcome" }): void {
    this.completedStrokes = msg.snapshot.completed.map((s) => ({
      origin: s.origin,
      color: s.color,
      width: s.width,
      points: s.points,
      source: "remote",
    }));
    this.remoteStrokes.clear();
    this.repaint();
  }

  private drainJitterBuffer = (): void => {
    const now = performance.now();
    for (const [key, stroke] of this.remoteStrokes) {
      while (stroke.buffered.length > 0) {
        const head = stroke.buffered[0];
        if (now - head.arrivedAt < JITTER_BUFFER_MS) break;
        stroke.buffered.shift();
        this.applyRemotePoint(stroke, head);
      }
      if (stroke.finished && stroke.buffered.length === 0) {
        if (stroke.render) {
          finishStrokeAt(this.ctx, stroke.render, stroke.lastAbsX, stroke.lastAbsY);
        }
        this.completedStrokes.push({
          origin: stroke.origin,
          color: stroke.color,
          width: stroke.baseWidth,
          points: stroke.allPoints,
          source: "remote",
        });
        this.remoteStrokes.delete(key);
      }
    }
    requestAnimationFrame(this.drainJitterBuffer);
  };

  private applyRemotePoint(stroke: RemoteStroke, p: RemotePointBuffered): void {
    if (!stroke.render) {
      stroke.render = newRender(
        rgbToCss(stroke.color),
        stroke.baseWidth,
        stroke.origin[0],
        stroke.origin[1],
        stroke.color === ERASER_COLOR,
      );
    }
    drawSegment(this.ctx, stroke.render, p.absX, p.absY, stroke.render.prevT + p.dt);
    if (p.finished) {
      stroke.finished = true;
      finishStrokeAt(this.ctx, stroke.render, p.absX, p.absY);
    }
  }

  private onPointerDown = (ev: PointerEvent): void => {
    if (!ev.isPrimary) return;
    if (this.localStrokes.has(ev.pointerId)) return;
    this.canvas.setPointerCapture(ev.pointerId);
    const { x, y } = this.toLogical(ev);
    const t = performance.now();
    const strokeId = this.nextStrokeId++;
    const color = this.currentColor;
    const width = this.currentWidth;
    const stroke: LocalStroke = {
      strokeId,
      originX: x,
      originY: y,
      lastX: x,
      lastY: y,
      lastT: t,
      color,
      baseWidth: width,
      pending: [],
      allPoints: [],
      render: newRender(rgbToCss(color), width, x, y, color === ERASER_COLOR),
      pointerId: ev.pointerId,
    };
    this.localStrokes.set(ev.pointerId, stroke);
  };

  private onPointerMove = (ev: PointerEvent): void => {
    const stroke = this.localStrokes.get(ev.pointerId);
    if (!stroke) return;
    const coalesced =
      typeof ev.getCoalescedEvents === "function" ? ev.getCoalescedEvents() : [];
    const events = coalesced.length > 0 ? coalesced : [ev];
    for (const e of events) {
      const { x, y } = this.toLogical(e);
      this.consumeLocalPoint(stroke, x, y);
    }
  };

  private onPointerEnd = (ev: PointerEvent): void => {
    const stroke = this.localStrokes.get(ev.pointerId);
    if (!stroke) return;
    this.localStrokes.delete(ev.pointerId);

    if (this.sendBatched) {
      // Chunk to respect MAX_POINTS_PER_BATCH on the wire. The last chunk
      // carries finished=true; preceding chunks (if any) are unfinished.
      while (stroke.pending.length > MAX_POINTS_PER_BATCH) {
        const batch = stroke.pending.splice(0, MAX_POINTS_PER_BATCH);
        this.sendBatched({
          kind: "Stroke",
          stroke_id: stroke.strokeId,
          origin: [Math.round(stroke.originX), Math.round(stroke.originY)],
          color: stroke.color,
          width: stroke.baseWidth,
          points: batch,
          finished: false,
        });
      }
      this.sendBatched({
        kind: "Stroke",
        stroke_id: stroke.strokeId,
        origin: [Math.round(stroke.originX), Math.round(stroke.originY)],
        color: stroke.color,
        width: stroke.baseWidth,
        points: stroke.pending,
        finished: true,
      });
      stroke.pending = [];
    }

    finishStrokeAt(this.ctx, stroke.render, stroke.lastX, stroke.lastY);
    this.completedStrokes.push({
      origin: [Math.round(stroke.originX), Math.round(stroke.originY)],
      color: stroke.color,
      width: stroke.baseWidth,
      points: stroke.allPoints,
      source: "local",
    });
  };

  private consumeLocalPoint(stroke: LocalStroke, x: number, y: number): void {
    const t = performance.now();
    let dx = Math.round(x - stroke.lastX);
    let dy = Math.round(y - stroke.lastY);
    const dt = Math.min(255, Math.max(0, Math.round(t - stroke.lastT)));
    if (dx === 0 && dy === 0 && stroke.pending.length > 0) return;
    dx = clamp(dx, I8_MIN, I8_MAX);
    dy = clamp(dy, I8_MIN, I8_MAX);

    const absX = stroke.lastX + dx;
    const absY = stroke.lastY + dy;

    const point: Point = { dx, dy, dt, pressure: 0 };
    stroke.pending.push(point);
    stroke.allPoints.push(point);
    drawSegment(this.ctx, stroke.render, absX, absY, stroke.render.prevT + dt);

    stroke.lastX = absX;
    stroke.lastY = absY;
    stroke.lastT = t;
  }

  private flushPending = (): void => {
    if (!this.sendBatched) return;
    for (const stroke of this.localStrokes.values()) {
      while (stroke.pending.length > 0) {
        const batch = stroke.pending.splice(0, MAX_POINTS_PER_BATCH);
        this.sendBatched({
          kind: "Stroke",
          stroke_id: stroke.strokeId,
          origin: [Math.round(stroke.originX), Math.round(stroke.originY)],
          color: stroke.color,
          width: stroke.baseWidth,
          points: batch,
          finished: false,
        });
      }
    }
  };

  private toLogical(ev: { clientX: number; clientY: number }): {
    x: number;
    y: number;
  } {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * LOGICAL_WIDTH;
    const y = ((ev.clientY - rect.top) / rect.height) * LOGICAL_HEIGHT;
    return { x, y };
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    this.dpr = window.devicePixelRatio || 1;
    if (rect.width === this.cssWidth && rect.height === this.cssHeight) return;
    this.cssWidth = rect.width;
    this.cssHeight = rect.height;
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
    this.applyTransform();
    this.repaint();
  }

  private applyTransform(): void {
    // Map logical 960x600 space onto the DPI-scaled backing store, preserving
    // aspect ratio with letterbox if the viewport aspect differs.
    const scale = Math.min(
      this.canvas.width / LOGICAL_WIDTH,
      this.canvas.height / LOGICAL_HEIGHT,
    );
    const offsetX = (this.canvas.width - LOGICAL_WIDTH * scale) / 2;
    const offsetY = (this.canvas.height - LOGICAL_HEIGHT * scale) / 2;
    this.ctx.setTransform(scale, 0, 0, scale, offsetX, offsetY);
    this.ctx.lineCap = "round";
    this.ctx.lineJoin = "round";
    this.ctx.imageSmoothingEnabled = true;
  }

}

function newRender(
  color: string,
  baseWidth: number,
  originX: number,
  originY: number,
  isEraser: boolean,
): StrokeRender {
  return {
    color,
    baseWidth,
    isEraser,
    prevX: originX,
    prevY: originY,
    drawnX: originX,
    drawnY: originY,
    prevT: 0,
    width: baseWidth,
  };
}

function drawSegment(
  ctx: CanvasRenderingContext2D,
  render: StrokeRender,
  x: number,
  y: number,
  t: number,
): void {
  const dt = Math.max(1, t - render.prevT);
  const dist = Math.hypot(x - render.prevX, y - render.prevY);
  const speed = dist / dt;
  const factor = clamp(
    1 / (1 + speed * VELOCITY_FACTOR),
    MIN_WIDTH_FACTOR,
    MAX_WIDTH_FACTOR,
  );
  const target = render.baseWidth * factor;
  // Eraser holds a constant width so its boundary stays predictable.
  if (render.isEraser) {
    render.width = render.baseWidth;
  } else {
    render.width = render.width * WIDTH_SMOOTHING + target * (1 - WIDTH_SMOOTHING);
  }

  const midX = (render.prevX + x) / 2;
  const midY = (render.prevY + y) / 2;

  ctx.save();
  ctx.globalCompositeOperation = render.isEraser ? "destination-out" : "source-over";
  ctx.beginPath();
  ctx.moveTo(render.drawnX, render.drawnY);
  ctx.quadraticCurveTo(render.prevX, render.prevY, midX, midY);
  ctx.lineWidth = render.width;
  ctx.strokeStyle = render.color;
  ctx.stroke();
  ctx.restore();

  render.drawnX = midX;
  render.drawnY = midY;
  render.prevX = x;
  render.prevY = y;
  render.prevT = t;
}

function finishStrokeAt(
  ctx: CanvasRenderingContext2D,
  render: StrokeRender,
  x: number,
  y: number,
): void {
  if (render.drawnX === x && render.drawnY === y) return;
  ctx.save();
  ctx.globalCompositeOperation = render.isEraser ? "destination-out" : "source-over";
  ctx.beginPath();
  ctx.moveTo(render.drawnX, render.drawnY);
  ctx.lineTo(x, y);
  ctx.lineWidth = render.width;
  ctx.strokeStyle = render.color;
  ctx.stroke();
  ctx.restore();
  render.drawnX = x;
  render.drawnY = y;
}

function rgbToCss(rgb: number): string {
  const r = (rgb >> 16) & 0xff;
  const g = (rgb >> 8) & 0xff;
  const b = rgb & 0xff;
  return `rgb(${r}, ${g}, ${b})`;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
