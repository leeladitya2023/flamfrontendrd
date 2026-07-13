/**
 * Shared protocol between client and server.
 * One source of truth for event names and payload shapes —
 * prevents client/server drift (a common interview failure mode).
 */

/** Normalized point: x and y are 0..1 relative to the canvas CSS box. */
export interface Point {
  x: number;
  y: number;
}

export type Tool =
  | "brush"
  | "pencil"
  | "pen"
  | "eraser"
  | "line"
  | "rect"
  | "circle";

/** Freehand tools stream many points; shape tools keep [start, end]. */
export const SHAPE_TOOLS: ReadonlySet<Tool> = new Set(["line", "rect", "circle"]);
export const FREEHAND_TOOLS: ReadonlySet<Tool> = new Set([
  "brush",
  "pencil",
  "pen",
  "eraser",
]);

export function isTool(value: unknown): value is Tool {
  return (
    value === "brush" ||
    value === "pencil" ||
    value === "pen" ||
    value === "eraser" ||
    value === "line" ||
    value === "rect" ||
    value === "circle"
  );
}

export function isShapeTool(tool: Tool): boolean {
  return SHAPE_TOOLS.has(tool);
}

/** A committed stroke — one undoable operation in shared history. */
export interface Stroke {
  id: string;
  userId: string;
  tool: Tool;
  color: string;
  width: number;
  points: Point[];
  createdAt: number;
}

export interface User {
  id: string;
  name: string;
  /** Stable accent color assigned by the server for cursors / presence. */
  color: string;
  cursor: Point | null;
}

/** Full room snapshot sent on join (late-joiner sync). */
export interface RoomState {
  roomId: string;
  you: User;
  users: User[];
  strokes: Stroke[];
  canUndo: boolean;
  canRedo: boolean;
}

/** Socket event names — use these constants everywhere instead of magic strings. */
export const Events = {
  // Client → Server
  ROOM_JOIN: "room:join",
  CURSOR_MOVE: "cursor:move",
  STROKE_START: "stroke:start",
  STROKE_POINT: "stroke:point",
  STROKE_END: "stroke:end",
  HISTORY_UNDO: "history:undo",
  HISTORY_REDO: "history:redo",

  // Server → Client
  ROOM_STATE: "room:state",
  USER_JOINED: "user:joined",
  USER_LEFT: "user:left",
  CURSOR_UPDATE: "cursor:update",
  STROKE_START_BROADCAST: "stroke:start",
  STROKE_POINT_BROADCAST: "stroke:point",
  STROKE_COMMITTED: "stroke:committed",
  STROKE_ABANDONED: "stroke:abandoned",
  HISTORY_UPDATED: "history:updated",
  ERROR: "error",
} as const;

export interface RoomJoinPayload {
  roomId: string;
  userName?: string;
}

export interface CursorMovePayload {
  x: number;
  y: number;
}

export interface StrokeStartPayload {
  strokeId: string;
  tool: Tool;
  color: string;
  width: number;
  x: number;
  y: number;
}

export interface StrokePointPayload {
  strokeId: string;
  x: number;
  y: number;
}

export interface StrokeEndPayload {
  strokeId: string;
}

export interface HistoryUpdatedPayload {
  strokes: Stroke[];
  canUndo: boolean;
  canRedo: boolean;
}

export interface ErrorPayload {
  message: string;
}

/** Palette used to assign distinct colors to users in a room. */
export const USER_COLORS = [
  "#E63946",
  "#2A9D8F",
  "#E9C46A",
  "#9B5DE5",
  "#00BBF9",
  "#F15BB5",
  "#FEE440",
  "#00F5D4",
] as const;
