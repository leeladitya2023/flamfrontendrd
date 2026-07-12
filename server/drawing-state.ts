import type { Stroke } from "../shared/protocol.js";

/**
 * DrawingState — server-side operation log for one room.
 *
 * Shared `history` is what everyone sees on the canvas.
 * Undo/redo is **per user**: each writer can only remove/restore their own strokes.
 *
 * Mental model:
 *   history     = all committed strokes (oldest → newest)
 *   redoByUser  = Map<userId, Stroke[]> — that user's personal redo stack
 *
 * Undo for user U: remove U's most recent stroke from history (not necessarily
 * the last stroke in the room), push it onto U's redo stack.
 */
export class DrawingState {
  private history: Stroke[] = [];
  private redoByUser = new Map<string, Stroke[]>();

  /** In-progress strokes keyed by strokeId (not yet in history). */
  private inProgress = new Map<string, Stroke>();

  getStrokes(): Stroke[] {
    return this.history.map((s) => ({
      ...s,
      points: s.points.map((p) => ({ ...p })),
    }));
  }

  canUndo(userId: string): boolean {
    return this.history.some((s) => s.userId === userId);
  }

  canRedo(userId: string): boolean {
    return (this.redoByUser.get(userId)?.length ?? 0) > 0;
  }

  startStroke(stroke: Stroke): Stroke {
    this.inProgress.set(stroke.id, stroke);
    return stroke;
  }

  addPoint(strokeId: string, x: number, y: number): Stroke | null {
    const stroke = this.inProgress.get(strokeId);
    if (!stroke) return null;
    stroke.points.push({ x, y });
    return stroke;
  }

  /**
   * Commit stroke into shared history.
   * Clears only THIS user's redo stack (classic editor rule, scoped per writer).
   */
  endStroke(strokeId: string): Stroke | null {
    const stroke = this.inProgress.get(strokeId);
    if (!stroke) return null;

    this.inProgress.delete(strokeId);
    this.history.push(stroke);
    this.redoByUser.set(stroke.userId, []);
    return stroke;
  }

  abandonStroke(strokeId: string): boolean {
    return this.inProgress.delete(strokeId);
  }

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
   * Per-user undo: remove this user's latest committed stroke.
   * Other users' strokes are left untouched.
   */
  undo(userId: string): Stroke | null {
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].userId !== userId) continue;
      const [stroke] = this.history.splice(i, 1);
      const stack = this.redoByUser.get(userId) ?? [];
      stack.push(stroke);
      this.redoByUser.set(userId, stack);
      return stroke;
    }
    return null;
  }

  /**
   * Per-user redo: restore this user's most recently undone stroke
   * to the end of shared history.
   */
  redo(userId: string): Stroke | null {
    const stack = this.redoByUser.get(userId);
    if (!stack || stack.length === 0) return null;
    const stroke = stack.pop()!;
    this.history.push(stroke);
    return stroke;
  }

  /** Drop redo memory when a user leaves (optional cleanup). */
  clearUserRedo(userId: string): void {
    this.redoByUser.delete(userId);
  }
}
