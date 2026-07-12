import { v4 as uuidv4 } from "uuid";
import {
  USER_COLORS,
  type Stroke,
  type User,
  type Tool,
} from "../shared/protocol.js";
import { DrawingState } from "./drawing-state.js";

/**
 * Room — one isolated collaborative canvas session.
 *
 * Responsibility: map socket users ↔ presence + drawing state.
 * Scalability note: today this is in-memory Map. For many rooms / multi-instance
 * deploys, move Room state to Redis and sticky-session or pub/sub.
 */
export class Room {
  readonly id: string;
  readonly drawing = new DrawingState();
  private users = new Map<string, User>();
  private colorIndex = 0;

  constructor(id: string) {
    this.id = id;
  }

  addUser(name?: string): User {
    const user: User = {
      id: uuidv4(),
      name: name?.trim() || `Artist ${this.users.size + 1}`,
      color: USER_COLORS[this.colorIndex % USER_COLORS.length],
      cursor: null,
    };
    this.colorIndex += 1;
    this.users.set(user.id, user);
    return user;
  }

  removeUser(userId: string): User | undefined {
    const user = this.users.get(userId);
    this.users.delete(userId);
    return user;
  }

  getUser(userId: string): User | undefined {
    return this.users.get(userId);
  }

  getUsers(): User[] {
    return [...this.users.values()];
  }

  setCursor(userId: string, x: number, y: number): void {
    const user = this.users.get(userId);
    if (!user) return;
    user.cursor = { x, y };
  }

  startStroke(
    userId: string,
    strokeId: string,
    tool: Tool,
    color: string,
    width: number,
    x: number,
    y: number
  ): Stroke | null {
    if (!this.users.has(userId)) return null;
    return this.drawing.startStroke({
      id: strokeId,
      userId,
      tool,
      color,
      width: clampWidth(width),
      points: [{ x: clamp01(x), y: clamp01(y) }],
      createdAt: Date.now(),
    });
  }

  addPoint(strokeId: string, x: number, y: number): Stroke | null {
    return this.drawing.addPoint(strokeId, clamp01(x), clamp01(y));
  }

  endStroke(strokeId: string): Stroke | null {
    return this.drawing.endStroke(strokeId);
  }
}

/**
 * RoomManager — factory + registry for rooms.
 *
 * Why separate from Room: server can look up rooms by id without knowing
 * DrawingState internals (separation of concerns).
 */
export class RoomManager {
  private rooms = new Map<string, Room>();

  getOrCreate(roomId: string): Room {
    const id = normalizeRoomId(roomId);
    let room = this.rooms.get(id);
    if (!room) {
      room = new Room(id);
      this.rooms.set(id, room);
    }
    return room;
  }

  get(roomId: string): Room | undefined {
    return this.rooms.get(normalizeRoomId(roomId));
  }

  /**
   * Drop empty rooms to avoid unbounded memory growth in long-running servers.
   */
  cleanupIfEmpty(roomId: string): void {
    const id = normalizeRoomId(roomId);
    const room = this.rooms.get(id);
    if (room && room.getUsers().length === 0) {
      this.rooms.delete(id);
    }
  }
}

function normalizeRoomId(roomId: string): string {
  const trimmed = roomId.trim().slice(0, 64);
  return trimmed || "lobby";
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function clampWidth(width: number): number {
  if (Number.isNaN(width)) return 4;
  return Math.min(48, Math.max(1, width));
}
