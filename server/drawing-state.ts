import type { Stroke } from "../shared/protocol.js";

/**
 * DrawingState — server-side operation log for one room.
 *
 * Purpose: Own the shared stroke history and undo/redo stacks.
 * Why server-side: Clients can disconnect or cheat; the server is source of truth.
 *
 * Mental model:
 *   history  = strokes currently on the canvas (oldest → newest)
 *   redoStack = strokes removed by undo (newest undone is on top)
 *
 * Complexity:
 *   undo/redo: O(1) stack ops + O(n) broadcast of strokes (n = history length)
 *   Space: O(total points across all strokes)
 */
export class DrawingState {
  private history: Stroke[] = [];
  private redoStack: Stroke[] = [];

  /** In-progress strokes keyed by strokeId (not yet in history). */
  private inProgress = new Map<string, Stroke>();

  getStrokes(): Stroke[] {
    return [...this.history];
  }

  canUndo(): boolean {
    return this.history.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * Begin a live stroke. Not undoable until endStroke commits it.
   */
  startStroke(stroke: Stroke): Stroke {
    this.inProgress.set(stroke.id, stroke);
    return stroke;
  }

  /**
   * Append a point to an in-progress stroke.
   * Returns null if strokeId is unknown (stale / wrong room).
   */
  addPoint(strokeId: string, x: number, y: number): Stroke | null {
    const stroke = this.inProgress.get(strokeId);
    if (!stroke) return null;
    stroke.points.push({ x, y });
    return stroke;
  }

  /**
   * Commit stroke into shared history. Clears redo stack (classic editor rule:
   * new work after undo invalidates the redo path).
   */
  endStroke(strokeId: string): Stroke | null {
    const stroke = this.inProgress.get(strokeId);
    if (!stroke) return null;

    this.inProgress.delete(strokeId);

    // Ignore empty / single-point accidental clicks as committed ops if desired.
    // We keep them — a click-dot is a valid mark.
    this.history.push(stroke);
    this.redoStack = [];
    return stroke;
  }

  /**
   * Drop an unfinished stroke (e.g. user disconnected mid-draw).
   */
  abandonStroke(strokeId: string): boolean {
    return this.inProgress.delete(strokeId);
  }

  /** Abandon every in-progress stroke owned by a leaving user. */
  abandonUserStrokes(userId: string): string[] {
    const abandoned: string[] = [];
    for (const [id, stroke] of this.inProgress) {
      if (stroke.userId === userId) {
        this.inProgress.delete(id);
        abandoned.push(id);
      }
    }
    return abandoned;
  }

  /**
   * Global undo: remove the last committed stroke from history.
   * Returns the undone stroke, or null if nothing to undo.
   */
  undo(): Stroke | null {
    const stroke = this.history.pop();
    if (!stroke) return null;
    this.redoStack.push(stroke);
    return stroke;
  }

  /**
   * Global redo: re-apply the most recently undone stroke.
   */
  redo(): Stroke | null {
    const stroke = this.redoStack.pop();
    if (!stroke) return null;
    this.history.push(stroke);
    return stroke;
  }

  getInProgressByUser(userId: string): Stroke[] {
    return [...this.inProgress.values()].filter((s) => s.userId === userId);
  }
}
