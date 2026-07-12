import type { Point, Stroke, Tool, User } from "../shared/protocol.js";

/**
 * CanvasController — owns the HTML5 Canvas and all drawing.
 *
 * Responsibility:
 *  - Capture pointer events and turn them into normalized stroke points
 *  - Paint committed strokes + live (local & remote) strokes
 *  - Show remote cursors
 *  - Handle devicePixelRatio so lines stay sharp on retina screens
 *
 * Why not a drawing library: assignment requires raw Canvas API skill.
 */

export interface StrokeStartInfo {
  strokeId: string;
  tool: Tool;
  color: string;
  width: number;
  x: number;
  y: number;
}

export type StrokePointInfo = { strokeId: string; x: number; y: number };
export type StrokeEndInfo = { strokeId: string };

export interface CanvasCallbacks {
  onStrokeStart: (info: StrokeStartInfo) => void;
  onStrokePoint: (info: StrokePointInfo) => void;
  onStrokeEnd: (info: StrokeEndInfo) => void;
  onCursorMove: (point: Point) => void;
}

export class CanvasController {
  private canvas: HTMLCanvasElement;
  private overlay: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private overlayCtx: CanvasRenderingContext2D;
  private callbacks: CanvasCallbacks;

  private tool: Tool = "brush";
  private color = "#111111";
  private width = 4;

  private strokes: Stroke[] = [];
  private localLive: Stroke | null = null;
  private remoteLive = new Map<string, Stroke>();
  private cursors = new Map<string, { user: User; x: number; y: number }>();

  private drawing = false;
  /** Block drawing until the user has joined a room (avoids ghost local strokes). */
  private ready = false;
  private dpr = 1;
  private cursorRaf: number | null = null;
  private pendingCursor: Point | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    overlay: HTMLCanvasElement,
    callbacks: CanvasCallbacks
  ) {
    const ctx = canvas.getContext("2d");
    const overlayCtx = overlay.getContext("2d");
    if (!ctx || !overlayCtx) {
      throw new Error("Canvas 2D context unavailable");
    }

    this.canvas = canvas;
    this.overlay = overlay;
    this.ctx = ctx;
    this.overlayCtx = overlayCtx;
    this.callbacks = callbacks;

    this.resize();
    window.addEventListener("resize", () => this.resize());

    this.bindPointer();
  }

  setTool(tool: Tool): void {
    this.tool = tool;
  }

  setColor(color: string): void {
    this.color = color;
  }

  setWidth(width: number): void {
    this.width = width;
  }

  getTool(): Tool {
    return this.tool;
  }

  setReady(ready: boolean): void {
    this.ready = ready;
    if (!ready && this.drawing) {
      this.drawing = false;
      this.localLive = null;
      this.redrawAll();
    }
  }

  /**
   * Replace committed history and redraw.
   * Called on join sync and after global undo/redo.
   *
   * Important: when not mid-stroke, clear localLive so undo/redo from the
   * server is not hidden by a stale optimistic stroke still on screen.
   */
  setStrokes(strokes: Stroke[]): void {
    this.strokes = strokes.map((s) => ({
      ...s,
      points: s.points.map((p) => ({ ...p })),
    }));

    const ids = new Set(strokes.map((s) => s.id));
    for (const id of [...this.remoteLive.keys()]) {
      if (ids.has(id)) this.remoteLive.delete(id);
    }

    if (!this.drawing) {
      this.localLive = null;
    } else if (this.localLive && ids.has(this.localLive.id)) {
      this.localLive = null;
      this.drawing = false;
    }

    this.redrawAll();
  }

  /** Add a newly committed stroke without full history replace (fast path). */
  commitStroke(stroke: Stroke): void {
    if (this.strokes.some((s) => s.id === stroke.id)) return;
    this.strokes.push(stroke);
    this.remoteLive.delete(stroke.id);
    if (this.localLive?.id === stroke.id) this.localLive = null;
    this.redrawAll();
  }

  startRemoteStroke(info: {
    strokeId: string;
    userId: string;
    tool: Tool;
    color: string;
    width: number;
    x: number;
    y: number;
  }): void {
    this.remoteLive.set(info.strokeId, {
      id: info.strokeId,
      userId: info.userId,
      tool: info.tool,
      color: info.color,
      width: info.width,
      points: [{ x: info.x, y: info.y }],
      createdAt: Date.now(),
    });
    this.redrawAll();
  }

  addRemotePoint(strokeId: string, x: number, y: number): void {
    const stroke = this.remoteLive.get(strokeId);
    if (!stroke) return;
    stroke.points.push({ x, y });
    this.redrawAll();
  }

  abandonRemoteStroke(strokeId: string): void {
    this.remoteLive.delete(strokeId);
    this.redrawAll();
  }

  updateCursor(user: User, x: number, y: number): void {
    this.cursors.set(user.id, { user, x, y });
    this.paintOverlay();
  }

  removeCursor(userId: string): void {
    this.cursors.delete(userId);
    this.paintOverlay();
  }

  setUsersForCursors(users: User[], selfId: string): void {
    const keep = new Set(users.map((u) => u.id));
    for (const id of this.cursors.keys()) {
      if (!keep.has(id) || id === selfId) this.cursors.delete(id);
    }
    this.paintOverlay();
  }

  /** Resize backing store for sharp rendering on HiDPI displays. */
  resize(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;

    const rect = parent.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;

    for (const el of [this.canvas, this.overlay]) {
      el.width = Math.max(1, Math.floor(rect.width * this.dpr));
      el.height = Math.max(1, Math.floor(rect.height * this.dpr));
      el.style.width = `${rect.width}px`;
      el.style.height = `${rect.height}px`;
    }

    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.overlayCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.redrawAll();
  }

  private bindPointer(): void {
    // Pointer events cover mouse + touch + pen (bonus: mobile touch).
    this.overlay.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    this.overlay.addEventListener("pointermove", (e) => this.onPointerMove(e));
    this.overlay.addEventListener("pointerup", (e) => this.onPointerUp(e));
    this.overlay.addEventListener("pointercancel", (e) => this.onPointerUp(e));
    this.overlay.addEventListener("pointerleave", (e) => {
      if (this.drawing) this.onPointerUp(e);
    });
  }

  private onPointerDown(e: PointerEvent): void {
    if (!this.ready) return;
    e.preventDefault();
    this.overlay.setPointerCapture(e.pointerId);

    const { x, y } = this.normalize(e);
    const strokeId = crypto.randomUUID();

    this.drawing = true;
    this.localLive = {
      id: strokeId,
      userId: "local",
      tool: this.tool,
      color: this.color,
      width: this.width,
      points: [{ x, y }],
      createdAt: Date.now(),
    };

    // Client-side prediction: paint immediately, don't wait for server RTT.
    this.redrawAll();

    this.callbacks.onStrokeStart({
      strokeId,
      tool: this.tool,
      color: this.color,
      width: this.width,
      x,
      y,
    });
  }

  private onPointerMove(e: PointerEvent): void {
    const { x, y } = this.normalize(e);

    // Throttle cursor emits via rAF so we don't flood the socket.
    this.pendingCursor = { x, y };
    if (this.cursorRaf == null) {
      this.cursorRaf = requestAnimationFrame(() => {
        this.cursorRaf = null;
        if (this.pendingCursor) {
          this.callbacks.onCursorMove(this.pendingCursor);
        }
      });
    }

    if (!this.drawing || !this.localLive) return;
    e.preventDefault();

    this.localLive.points.push({ x, y });
    this.redrawAll();
    this.callbacks.onStrokePoint({ strokeId: this.localLive.id, x, y });
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.drawing || !this.localLive) return;
    e.preventDefault();

    const strokeId = this.localLive.id;
    this.drawing = false;
    // Keep localLive until server commits — avoids flicker.
    this.callbacks.onStrokeEnd({ strokeId });

    try {
      this.overlay.releasePointerCapture(e.pointerId);
    } catch {
      // Already released — safe to ignore.
    }
  }

  /**
   * Convert pointer event → normalized 0..1 coords relative to canvas box.
   * Why normalize: different window sizes must share the same logical space.
   */
  private normalize(e: PointerEvent): Point {
    const rect = this.overlay.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    return {
      x: clamp01(x),
      y: clamp01(y),
    };
  }

  private redrawAll(): void {
    const { width, height } = this.cssSize();
    this.ctx.clearRect(0, 0, width, height);

    // Soft paper background grain via CSS; canvas stays transparent/clear.
    for (const stroke of this.strokes) {
      this.paintStroke(this.ctx, stroke, width, height);
    }
    for (const stroke of this.remoteLive.values()) {
      this.paintStroke(this.ctx, stroke, width, height);
    }
    if (this.localLive) {
      this.paintStroke(this.ctx, this.localLive, width, height);
    }

    this.paintOverlay();
  }

  private paintOverlay(): void {
    const { width, height } = this.cssSize();
    this.overlayCtx.clearRect(0, 0, width, height);

    for (const { user, x, y } of this.cursors.values()) {
      const px = x * width;
      const py = y * height;

      this.overlayCtx.beginPath();
      this.overlayCtx.fillStyle = user.color;
      this.overlayCtx.arc(px, py, 5, 0, Math.PI * 2);
      this.overlayCtx.fill();

      this.overlayCtx.font = "600 11px 'Segoe UI', system-ui, sans-serif";
      this.overlayCtx.fillStyle = user.color;
      this.overlayCtx.fillText(user.name, px + 8, py - 8);
    }
  }

  /**
   * Draw one stroke as a continuous path.
   * Eraser uses destination-out to punch through existing pixels.
   */
  private paintStroke(
    ctx: CanvasRenderingContext2D,
    stroke: Stroke,
    width: number,
    height: number
  ): void {
    if (stroke.points.length === 0) return;

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = stroke.width;

    if (stroke.tool === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "rgba(0,0,0,1)";
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = stroke.color;
    }

    ctx.beginPath();
    const first = stroke.points[0];
    ctx.moveTo(first.x * width, first.y * height);

    if (stroke.points.length === 1) {
      // Dot for a single click.
      ctx.lineTo(first.x * width + 0.01, first.y * height);
    } else {
      for (let i = 1; i < stroke.points.length; i++) {
        const p = stroke.points[i];
        ctx.lineTo(p.x * width, p.y * height);
      }
    }

    ctx.stroke();
    ctx.restore();
  }

  private cssSize(): { width: number; height: number } {
    return {
      width: this.canvas.clientWidth,
      height: this.canvas.clientHeight,
    };
  }
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}
