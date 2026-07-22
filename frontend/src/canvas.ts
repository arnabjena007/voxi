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
// Hard cap on per-side history. A round of skribble rarely hits double
// digits in strokes; 50 is plenty to undo back through a whole round, and
// bounded so a runaway scribbler can't grow the array forever.
const UNDO_STACK_CAP = 50;

const ERASER_COLOR = 0xffffff;
// Width-0 is the paint-bucket sentinel: a width-0 "stroke" is a flood fill at
// its origin (no points). Mirrors palette.ts FILL_WIDTH.
const FILL_WIDTH = 0;

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
  // Used by undo/redo to identify and remove specific strokes. For local
  // strokes this is the stroke_id we sent on the wire (or would have for
  // non-drawer doodles). For remote strokes it's the originator's id.
  player: number;
  strokeId: number;
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
  private activeToolId = "pencil";
  private dpr = 1;
  private cssWidth = 0;
  private cssHeight = 0;
  private completedStrokes: CompletedRecord[] = [];
  // Local undo/redo history for THIS client's own strokes only. Newest at
  // the end of undoStack. A new stroke clears redoStack. Cleared on
  // resetHistory() at round / clear boundaries.
  private undoStack: CompletedRecord[] = [];
  private redoStack: CompletedRecord[] = [];
  // Fires whenever undo/redo availability changes (new stroke, undo, redo,
  // reset, snapshot, etc.). main.ts uses this to re-render the toolbar
  // buttons without polling.
  private historyListener: (() => void) | null = null;

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
    this.refreshCursor();
  }

  setWidth(width: number): void {
    // Width 0 is the fill sentinel and must pass through unclamped; real brush
    // widths clamp to >= 1.
    this.currentWidth =
      width === FILL_WIDTH ? FILL_WIDTH : Math.max(1, Math.min(255, Math.round(width)));
  }

  // Tells the canvas which tool is active so it can show the matching cursor
  // (a colour-tinted paint bucket for fill, an eraser for erase, else a
  // crosshair). Called by the toolbar / mobile panel on tool changes.
  setActiveTool(id: string): void {
    this.activeToolId = id;
    this.refreshCursor();
  }

  private refreshCursor(): void {
    this.canvas.style.cursor = cursorFor(this.activeToolId, this.currentColor);
  }

  // Subscribe to history-changed events (undo/redo availability flipped).
  // Just one slot; the latest caller wins. Fires after each mutation.
  setHistoryListener(fn: () => void): void {
    this.historyListener = fn;
  }

  private notifyHistory(): void {
    this.historyListener?.();
  }

  clear(): void {
    this.completedStrokes = [];
    this.undoStack = [];
    this.redoStack = [];
    this.remoteStrokes.clear();
    this.repaint();
    this.notifyHistory();
  }

  // Wipe only strokes this client drew locally. Used when a non-drawer hits
  // Clear during a Drawing round: the shared canvas (drawer's strokes) must
  // stay intact, but their own local doodles vanish.
  clearLocal(): void {
    this.completedStrokes = this.completedStrokes.filter(
      (s) => s.source !== "local",
    );
    // Clearing makes the prior history meaningless.
    this.undoStack = [];
    this.redoStack = [];
    this.repaint();
    this.notifyHistory();
  }

  // A read-only copy of completed strokes, for exporting an image or building
  // a per-round gallery. Pass a player id to keep only that player's strokes
  // (e.g. the drawer's, so a guesser's own doodles don't leak in). Points are
  // shared by reference (read-only).
  snapshot(filterPlayer?: number): DrawingRecord[] {
    const recs =
      filterPlayer == null
        ? this.completedStrokes
        : this.completedStrokes.filter((s) => s.player === filterPlayer);
    return recs.map((s) => ({
      origin: s.origin,
      color: s.color,
      width: s.width,
      points: s.points,
    }));
  }

  // Animate the current drawing being re-drawn from a blank canvas ("watch how
  // they drew it"). Resolves when the replay finishes; the canvas settles back
  // to the full picture.
  replay(durationMs = 2600, filterPlayer?: number): Promise<void> {
    const records = this.snapshot(filterPlayer);
    const totalPoints = Math.max(
      1,
      records.reduce((n, r) => n + r.points.length, 0),
    );
    return new Promise((resolve) => {
      const start = performance.now();
      const tick = (): void => {
        const frac = Math.min(1, (performance.now() - start) / durationMs);
        const target = Math.floor(frac * totalPoints);
        this.ctx.save();
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.restore();
        this.applyTransform();
        let drawn = 0;
        for (const rec of records) {
          if (drawn >= target) continue; // animation front not reached yet
          if (rec.width === FILL_WIDTH) {
            floodFill(this.ctx, this.canvas.width, this.canvas.height, rec.origin[0], rec.origin[1], rec.color);
            continue;
          }
          if (rec.points.length === 0) continue;
          const isEraser = rec.color === ERASER_COLOR;
          const render = newRender(
            rgbToCss(rec.color),
            rec.width,
            rec.origin[0],
            rec.origin[1],
            isEraser,
          );
          let curX = rec.origin[0];
          let curY = rec.origin[1];
          let curT = 0;
          let drewAny = false;
          for (const p of rec.points) {
            if (drawn >= target) break;
            curX += p.dx;
            curY += p.dy;
            curT += p.dt;
            drawSegment(this.ctx, render, curX, curY, curT);
            drawn++;
            drewAny = true;
          }
          if (drewAny && drawn < target) finishStrokeAt(this.ctx, render, curX, curY);
        }
        if (frac < 1) {
          requestAnimationFrame(tick);
        } else {
          this.repaint();
          resolve();
        }
      };
      requestAnimationFrame(tick);
    });
  }

  // True if there's an undoable local stroke. Used to enable/disable the
  // toolbar button without exposing the stack itself.
  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  // Peek the next-to-undo stroke without popping. main.ts uses this to
  // decide whether a drawer's undo needs a server round trip or can stay
  // local (e.g. non-drawer doodles during a Drawing round).
  peekUndo(): CompletedRecord | null {
    return this.undoStack[this.undoStack.length - 1] ?? null;
  }

  // Local-only undo: pop the most recent of our strokes from the canvas
  // and push it onto redoStack. Caller (main.ts) is responsible for
  // routing this through the server when the stroke is shared (drawer in
  // Drawing, anyone in Lobby) -- in those cases the server's
  // StrokeRemoved broadcast does the actual canvas removal via
  // applyStrokeRemoved, and undoLocal isn't called.
  undoLocal(): CompletedRecord | null {
    const top = this.undoStack.pop();
    if (!top) return null;
    // Remove the matching record from completedStrokes (newest match wins).
    for (let i = this.completedStrokes.length - 1; i >= 0; i--) {
      const s = this.completedStrokes[i];
      if (s.strokeId === top.strokeId && s.player === top.player) {
        this.completedStrokes.splice(i, 1);
        break;
      }
    }
    this.redoStack.push(top);
    if (this.redoStack.length > UNDO_STACK_CAP) this.redoStack.shift();
    this.repaint();
    this.notifyHistory();
    return top;
  }

  // Peek/pop for redo. The caller emits a fresh Stroke message when the
  // stroke is shared (so other clients see it), then calls redoLocalApply
  // to actually paint it back; for purely local strokes they call
  // redoLocalApply directly which re-pushes onto completedStrokes.
  popRedo(): CompletedRecord | null {
    return this.redoStack.pop() ?? null;
  }

  // Re-push a previously-undone stroke into completedStrokes (with a new
  // strokeId so the server treats it as a fresh emission) and put it on
  // top of the undo stack. Used for the local half of a redo.
  redoLocalApply(record: CompletedRecord, newStrokeId: number): void {
    const replayed: CompletedRecord = { ...record, strokeId: newStrokeId };
    this.completedStrokes.push(replayed);
    this.undoStack.push(replayed);
    if (this.undoStack.length > UNDO_STACK_CAP) this.undoStack.shift();
    this.repaint();
    this.notifyHistory();
  }

  // Server told us a stroke (ours or someone else's) just got undone:
  // drop it from completedStrokes + any in-progress entry and repaint.
  // If it was ours, also prune the matching record from undoStack so a
  // local "undo" doesn't try to remove it twice.
  applyStrokeRemoved(player: number, strokeId: number): void {
    for (let i = this.completedStrokes.length - 1; i >= 0; i--) {
      const s = this.completedStrokes[i];
      if (s.player === player && s.strokeId === strokeId) {
        this.completedStrokes.splice(i, 1);
        break;
      }
    }
    const inProgressKey = `${player}/${strokeId}`;
    this.remoteStrokes.delete(inProgressKey);
    for (let i = this.undoStack.length - 1; i >= 0; i--) {
      const s = this.undoStack[i];
      if (s.player === player && s.strokeId === strokeId) {
        this.undoStack.splice(i, 1);
        break;
      }
    }
    this.repaint();
    this.notifyHistory();
  }

  // Drop both stacks. Called by main.ts at round boundaries so a fresh
  // round starts with a clean history.
  resetHistory(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.notifyHistory();
  }

  // Allocate a stroke id for the redo path (which needs a fresh id on the
  // wire) without going through the normal pointer-input pipeline.
  allocateStrokeId(): number {
    return this.nextStrokeId++;
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
    paintRecordTo(this.ctx, rec, false);
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
      player: s.player,
      strokeId: s.stroke_id,
    }));
    // Snapshots are authoritative state; the undo history we'd built up so
    // far doesn't apply to a fresh reload, so drop both stacks too.
    this.undoStack = [];
    this.redoStack = [];
    this.remoteStrokes.clear();
    this.repaint();
    this.notifyHistory();
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
        const record: CompletedRecord = {
          origin: stroke.origin,
          color: stroke.color,
          width: stroke.baseWidth,
          points: stroke.allPoints,
          source: "remote",
          player: stroke.player,
          strokeId: stroke.strokeId,
        };
        this.completedStrokes.push(record);
        // A fill has no live segments (no points), so nothing was drawn as it
        // "arrived" -- paint it now that it's final.
        if (record.width === FILL_WIDTH) this.paintRecord(record);
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
    const { x, y } = this.toLogical(ev);
    // Fill tool (width-0 sentinel): a single click flood-fills at this point.
    // No pointer tracking -- it's one instantaneous op, recorded as a width-0
    // stroke so it shares ordering / undo / snapshot / gallery with strokes.
    if (this.currentWidth === FILL_WIDTH) {
      this.doFill(x, y);
      return;
    }
    this.canvas.setPointerCapture(ev.pointerId);
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
    const record: CompletedRecord = {
      origin: [Math.round(stroke.originX), Math.round(stroke.originY)],
      color: stroke.color,
      width: stroke.baseWidth,
      points: stroke.allPoints,
      source: "local",
      player: this.youId ?? 0,
      strokeId: stroke.strokeId,
    };
    this.completedStrokes.push(record);
    // Drawing forward invalidates the redo branch; track this as the new
    // top of the undo stack (newest = last). Cap so a frantic scribbler
    // doesn't grow the array unbounded.
    this.undoStack.push(record);
    if (this.undoStack.length > UNDO_STACK_CAP) this.undoStack.shift();
    this.redoStack = [];
    this.notifyHistory();
  };

  // Paint-bucket: flood-fill the canvas at a logical (960x600) point with the
  // current colour, then record + broadcast it as a width-0, no-points stroke
  // so it slots into the shared ordered draw list like any other stroke.
  private doFill(x: number, y: number): void {
    const color = this.currentColor;
    const ox = Math.round(x);
    const oy = Math.round(y);
    const strokeId = this.nextStrokeId++;
    // Paint locally right away for responsiveness.
    floodFill(this.ctx, this.canvas.width, this.canvas.height, ox, oy, color);
    if (this.sendBatched) {
      this.sendBatched({
        kind: "Stroke",
        stroke_id: strokeId,
        origin: [ox, oy],
        color,
        width: FILL_WIDTH,
        points: [],
        finished: true,
      });
    }
    const record: CompletedRecord = {
      origin: [ox, oy],
      color,
      width: FILL_WIDTH,
      points: [],
      source: "local",
      player: this.youId ?? 0,
      strokeId,
    };
    this.completedStrokes.push(record);
    this.undoStack.push(record);
    if (this.undoStack.length > UNDO_STACK_CAP) this.undoStack.shift();
    this.redoStack = [];
    this.notifyHistory();
  }

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

// Minimal shape of a finished stroke, for off-canvas rendering (share/gallery).
export interface DrawingRecord {
  origin: [number, number];
  color: number;
  width: number;
  points: Point[];
}

// Render a set of completed strokes onto an arbitrary canvas, white-backed by
// default. Maps the logical 960x600 space onto the target, preserving aspect.
// Eraser strokes are painted as white (not destination-out) so the exported
// image keeps a solid background. Used by the shareable card + gallery thumbs.
export function renderDrawing(
  target: HTMLCanvasElement,
  records: DrawingRecord[],
  opts: { background?: string } = {},
): void {
  const ctx = target.getContext("2d");
  if (!ctx) return;
  const W = target.width;
  const H = target.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = opts.background ?? "#ffffff";
  ctx.fillRect(0, 0, W, H);
  const scale = Math.min(W / LOGICAL_WIDTH, H / LOGICAL_HEIGHT);
  const offX = (W - LOGICAL_WIDTH * scale) / 2;
  const offY = (H - LOGICAL_HEIGHT * scale) / 2;
  ctx.setTransform(scale, 0, 0, scale, offX, offY);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.imageSmoothingEnabled = true;
  for (const rec of records) paintRecordTo(ctx, rec, true);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

// Animate a drawing onto an arbitrary white-backed canvas, stroke by stroke,
// over `durationMs`. Resolves when finished. Used by the game-over replay.
export function replayDrawing(
  target: HTMLCanvasElement,
  records: DrawingRecord[],
  durationMs = 2200,
  shouldCancel?: () => boolean,
): Promise<void> {
  return new Promise((resolve) => {
    const ctx = target.getContext("2d");
    if (!ctx) {
      resolve();
      return;
    }
    const W = target.width;
    const H = target.height;
    const scale = Math.min(W / LOGICAL_WIDTH, H / LOGICAL_HEIGHT);
    const offX = (W - LOGICAL_WIDTH * scale) / 2;
    const offY = (H - LOGICAL_HEIGHT * scale) / 2;
    const totalPoints = Math.max(
      1,
      records.reduce((n, r) => n + r.points.length, 0),
    );
    const setup = (): void => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, W, H);
      ctx.setTransform(scale, 0, 0, scale, offX, offY);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.imageSmoothingEnabled = true;
    };
    const start = performance.now();
    const tick = (): void => {
      if (shouldCancel?.()) {
        resolve();
        return;
      }
      const frac = Math.min(1, (performance.now() - start) / durationMs);
      const targetN = Math.floor(frac * totalPoints);
      setup();
      let drawn = 0;
      for (const rec of records) {
        if (drawn >= targetN) continue; // animation front not reached yet
        // Fills are instantaneous: paint the whole fill once the front reaches
        // its slot (it carries no points, so it doesn't advance `drawn`).
        if (rec.width === FILL_WIDTH) {
          floodFill(ctx, W, H, rec.origin[0], rec.origin[1], rec.color);
          continue;
        }
        if (rec.points.length === 0) continue;
        const isEraser = rec.color === ERASER_COLOR;
        const render = newRender(
          isEraser ? "#ffffff" : rgbToCss(rec.color),
          rec.width,
          rec.origin[0],
          rec.origin[1],
          false,
        );
        let curX = rec.origin[0];
        let curY = rec.origin[1];
        let curT = 0;
        let drew = false;
        for (const p of rec.points) {
          if (drawn >= targetN) break;
          curX += p.dx;
          curY += p.dy;
          curT += p.dt;
          drawSegment(ctx, render, curX, curY, curT);
          drawn++;
          drew = true;
        }
        if (drew && drawn < targetN) finishStrokeAt(ctx, render, curX, curY);
      }
      if (frac < 1) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
}

// Flood-fill the region contiguous with the logical (960x600) seed point,
// replacing it with `rgb`. Works in device pixels (getImageData/putImageData
// ignore the transform); the seed is mapped through the ctx's current transform
// so it's correct for the live canvas and for gallery/replay targets alike.
// A small colour tolerance absorbs anti-aliased stroke edges. Because the whole
// ordered draw list is repainted in order, a fill always samples the pixels of
// the strokes that precede it.
function floodFill(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  logicalX: number,
  logicalY: number,
  rgb: number,
): void {
  if (W <= 0 || H <= 0) return;
  const m = ctx.getTransform();
  const sx = Math.round(m.a * logicalX + m.c * logicalY + m.e);
  const sy = Math.round(m.b * logicalX + m.d * logicalY + m.f);
  if (sx < 0 || sy < 0 || sx >= W || sy >= H) return;

  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const p0 = (sy * W + sx) * 4;
  const tr = d[p0], tg = d[p0 + 1], tb = d[p0 + 2], ta = d[p0 + 3];
  const fr = (rgb >> 16) & 0xff, fg = (rgb >> 8) & 0xff, fb = rgb & 0xff;
  // Already the fill colour? Nothing to do (also avoids a pointless full pass).
  if (tr === fr && tg === fg && tb === fb && ta === 255) return;

  const TOL = 48 * 48; // squared RGBA distance; absorbs anti-aliasing
  const visited = new Uint8Array(W * H);
  const matchesTarget = (i: number): boolean => {
    if (visited[i]) return false;
    const p = i * 4;
    const dr = d[p] - tr, dg = d[p + 1] - tg, db = d[p + 2] - tb, da = d[p + 3] - ta;
    return dr * dr + dg * dg + db * db + da * da <= TOL;
  };
  const pushRun = (x0: number, x1: number, y: number): void => {
    if (y < 0 || y >= H) return;
    const row = y * W;
    let inRun = false;
    for (let x = x0; x <= x1; x++) {
      if (matchesTarget(row + x)) {
        if (!inRun) { stack.push(x, y); inRun = true; }
      } else {
        inRun = false;
      }
    }
  };
  // Span-based scanline fill: each stack entry seeds one contiguous row run.
  const stack: number[] = [sx, sy];
  while (stack.length) {
    const y = stack.pop() as number;
    const x = stack.pop() as number;
    const row = y * W;
    if (visited[row + x]) continue;
    let xl = x;
    while (xl >= 0 && matchesTarget(row + xl)) xl--;
    xl++;
    let xr = x;
    while (xr < W && matchesTarget(row + xr)) xr++;
    xr--;
    for (let i = xl; i <= xr; i++) {
      const p = (row + i) * 4;
      d[p] = fr; d[p + 1] = fg; d[p + 2] = fb; d[p + 3] = 255;
      visited[row + i] = 1;
    }
    pushRun(xl, xr, y - 1);
    pushRun(xl, xr, y + 1);
  }
  ctx.putImageData(img, 0, 0);
}

function paintRecordTo(
  ctx: CanvasRenderingContext2D,
  rec: DrawingRecord,
  eraserAsWhite: boolean,
): void {
  // Fill op (width-0 sentinel): flood-fill at the origin. Must run before the
  // empty-points guard, since a fill carries no points.
  if (rec.width === FILL_WIDTH) {
    floodFill(ctx, ctx.canvas.width, ctx.canvas.height, rec.origin[0], rec.origin[1], rec.color);
    return;
  }
  if (rec.points.length === 0) return;
  const isEraser = rec.color === ERASER_COLOR;
  const color = isEraser && eraserAsWhite ? "#ffffff" : rgbToCss(rec.color);
  const render = newRender(
    color,
    rec.width,
    rec.origin[0],
    rec.origin[1],
    isEraser && !eraserAsWhite,
  );
  let curX = rec.origin[0];
  let curY = rec.origin[1];
  let curT = 0;
  for (const p of rec.points) {
    curX += p.dx;
    curY += p.dy;
    curT += p.dt;
    drawSegment(ctx, render, curX, curY, curT);
  }
  finishStrokeAt(ctx, render, curX, curY);
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

// CSS `cursor` value for the active tool: a paint bucket tinted with the
// selected colour for fill, an eraser for erase, else the plain crosshair.
// The SVGs are inlined as data-URI cursors with a sensible hotspot.
function cursorFor(toolId: string, rgb: number): string {
  if (toolId === "fill") {
    const c = rgbToCss(rgb);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">` +
      `<g transform="rotate(-28 16 16)">` +
      `<path d="M9 9h12v10a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2z" fill="${c}" stroke="#3a3a3a" stroke-width="1.6"/>` +
      `<ellipse cx="15" cy="9" rx="6" ry="2.3" fill="#ffffff" stroke="#3a3a3a" stroke-width="1.6"/>` +
      `<path d="M9 12q-5 1-4 6" fill="none" stroke="#3a3a3a" stroke-width="1.6" stroke-linecap="round"/>` +
      `</g>` +
      `<path d="M6 24l-1.6 4" stroke="${c}" stroke-width="2.6" stroke-linecap="round"/>` +
      `</svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 5 28, crosshair`;
  }
  if (toolId === "eraser") {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 30 30">` +
      `<g transform="rotate(-40 15 15)">` +
      `<rect x="5" y="11" width="19" height="9" rx="2" fill="#fde2ea" stroke="#3a3a3a" stroke-width="1.6"/>` +
      `<rect x="5" y="11" width="7.5" height="9" rx="2" fill="#f2a4b0" stroke="#3a3a3a" stroke-width="1.6"/>` +
      `</g>` +
      `</svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 8 22, crosshair`;
  }
  return "crosshair";
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
