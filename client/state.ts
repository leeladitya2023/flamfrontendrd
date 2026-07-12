import type { Stroke, User } from "../shared/protocol.js";

/**
 * ClientState — local mirror of server room state for UI rendering.
 *
 * Not a full Redux store: vanilla assignment, keep it a simple mutable object
 * with explicit update helpers. Canvas keeps drawing buffers separately.
 */
export class ClientState {
  roomId = "lobby";
  self: User | null = null;
  users: User[] = [];
  strokes: Stroke[] = [];
  canUndo = false;
  canRedo = false;
  connected = false;

  resetFromRoom(payload: {
    roomId: string;
    you: User;
    users: User[];
    strokes: Stroke[];
    canUndo: boolean;
    canRedo: boolean;
  }): void {
    this.roomId = payload.roomId;
    this.self = payload.you;
    this.users = payload.users;
    this.strokes = payload.strokes;
    this.canUndo = payload.canUndo;
    this.canRedo = payload.canRedo;
  }

  addUser(user: User): void {
    if (this.users.some((u) => u.id === user.id)) return;
    this.users = [...this.users, user];
  }

  removeUser(userId: string): void {
    this.users = this.users.filter((u) => u.id !== userId);
  }

  setHistory(strokes: Stroke[], canUndo: boolean, canRedo: boolean): void {
    this.strokes = strokes;
    this.canUndo = canUndo;
    this.canRedo = canRedo;
  }

  upsertStroke(stroke: Stroke): void {
    const idx = this.strokes.findIndex((s) => s.id === stroke.id);
    if (idx >= 0) {
      this.strokes = this.strokes.slice();
      this.strokes[idx] = stroke;
    } else {
      this.strokes = [...this.strokes, stroke];
    }
  }
}
