import express from "express";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import { Server } from "socket.io";
import {
  Events,
  type CursorMovePayload,
  type HistoryUpdatedPayload,
  type RoomJoinPayload,
  type StrokeEndPayload,
  type StrokePointPayload,
  type StrokeStartPayload,
} from "../shared/protocol.js";
import { RoomManager } from "./rooms.js";

/**
 * HTTP + Socket.io entrypoint.
 *
 * Flow:
 *  1. Express serves the static client (HTML/CSS/bundled JS)
 *  2. Socket.io attaches to the same HTTP server (one port — easy deploy)
 *  3. Each socket joins a room; drawing events fan out to that room only
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const clientDir = path.join(rootDir, "client");

const PORT = Number(process.env.PORT) || 3000;

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  // CORS open for local multi-tab / demo; tighten in production behind same origin.
  cors: { origin: true },
});

const rooms = new RoomManager();

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.use(express.static(clientDir));

// Only fall back to index for the app shell — do not steal /socket.io/* traffic.
app.get(["/", "/index.html"], (_req, res) => {
  res.sendFile(path.join(clientDir, "index.html"));
});

/** Per-socket session metadata we attach after join. */
interface SocketData {
  userId?: string;
  roomId?: string;
}

io.on("connection", (socket) => {
  const data = socket.data as SocketData;

  socket.on(Events.ROOM_JOIN, (payload: RoomJoinPayload) => {
    try {
      const displayName = typeof payload?.userName === "string" ? payload.userName.trim() : "";
      if (!displayName) {
        socket.emit(Events.ERROR, { message: "Please enter your name to join" });
        return;
      }

      const roomId = payload?.roomId || "lobby";
      const room = rooms.getOrCreate(roomId);

      // Re-join / reconnect: drop this socket's previous presence so we don't
      // leak "Artist N" ghosts and inflate the online count.
      if (data.userId && data.roomId) {
        const previousRoom = rooms.get(data.roomId);
        if (previousRoom) {
          const abandoned = previousRoom.drawing.abandonUserStrokes(data.userId);
          for (const strokeId of abandoned) {
            socket.to(previousRoom.id).emit(Events.STROKE_ABANDONED, { strokeId });
          }
          const left = previousRoom.removeUser(data.userId);
          if (left) {
            socket.to(previousRoom.id).emit(Events.USER_LEFT, { userId: left.id });
          }
          if (data.roomId !== room.id) {
            rooms.cleanupIfEmpty(data.roomId);
          }
        }
        socket.leave(data.roomId);
      }

      const user = room.addUser(displayName);

      data.userId = user.id;
      data.roomId = room.id;
      socket.join(room.id);

      // Late-joiner sync: full state in one message.
      socket.emit(Events.ROOM_STATE, {
        roomId: room.id,
        you: user,
        users: room.getUsers(),
        strokes: room.drawing.getStrokes(),
        canUndo: room.drawing.canUndo(),
        canRedo: room.drawing.canRedo(),
      });

      socket.to(room.id).emit(Events.USER_JOINED, { user });
    } catch (err) {
      console.error("room:join failed", err);
      socket.emit(Events.ERROR, { message: "Failed to join room" });
    }
  });

  socket.on(Events.CURSOR_MOVE, (payload: CursorMovePayload) => {
    const room = getSocketRoom(data);
    if (!room || !data.userId) return;
    if (!isFiniteNumber(payload?.x) || !isFiniteNumber(payload?.y)) return;

    room.setCursor(data.userId, payload.x, payload.y);
    socket.to(room.id).emit(Events.CURSOR_UPDATE, {
      userId: data.userId,
      x: payload.x,
      y: payload.y,
    });
  });

  socket.on(Events.STROKE_START, (payload: StrokeStartPayload) => {
    const room = getSocketRoom(data);
    if (!room || !data.userId) return;
    if (!payload?.strokeId) return;

    const stroke = room.startStroke(
      data.userId,
      payload.strokeId,
      payload.tool === "eraser" ? "eraser" : "brush",
      sanitizeColor(payload.color),
      payload.width,
      payload.x,
      payload.y
    );
    if (!stroke) return;

    socket.to(room.id).emit(Events.STROKE_START_BROADCAST, {
      strokeId: stroke.id,
      userId: stroke.userId,
      tool: stroke.tool,
      color: stroke.color,
      width: stroke.width,
      x: stroke.points[0].x,
      y: stroke.points[0].y,
    });
  });

  socket.on(Events.STROKE_POINT, (payload: StrokePointPayload) => {
    const room = getSocketRoom(data);
    if (!room || !data.userId) return;
    if (!payload?.strokeId) return;

    const stroke = room.addPoint(payload.strokeId, payload.x, payload.y);
    if (!stroke || stroke.userId !== data.userId) return;

    socket.to(room.id).emit(Events.STROKE_POINT_BROADCAST, {
      strokeId: payload.strokeId,
      userId: data.userId,
      x: payload.x,
      y: payload.y,
    });
  });

  socket.on(Events.STROKE_END, (payload: StrokeEndPayload) => {
    const room = getSocketRoom(data);
    if (!room || !data.userId) return;
    if (!payload?.strokeId) return;

    const stroke = room.endStroke(payload.strokeId);
    if (!stroke || stroke.userId !== data.userId) return;

    // Tell everyone (including sender) the stroke is committed —
    // sender uses this to confirm; others finalize remote preview.
    io.to(room.id).emit(Events.STROKE_COMMITTED, { stroke });

    const historyPayload: HistoryUpdatedPayload = {
      strokes: room.drawing.getStrokes(),
      canUndo: room.drawing.canUndo(),
      canRedo: room.drawing.canRedo(),
    };
    // Lightweight flag update; strokes already known via STROKE_COMMITTED.
    // We still send canUndo/canRedo so toolbar stays in sync.
    io.to(room.id).emit(Events.HISTORY_UPDATED, historyPayload);
  });

  socket.on(Events.HISTORY_UNDO, () => {
    const room = getSocketRoom(data);
    if (!room) return;

    const undone = room.drawing.undo();
    if (!undone) return;

    broadcastHistory(room.id, room);
  });

  socket.on(Events.HISTORY_REDO, () => {
    const room = getSocketRoom(data);
    if (!room) return;

    const redone = room.drawing.redo();
    if (!redone) return;

    broadcastHistory(room.id, room);
  });

  socket.on("disconnect", () => {
    const room = getSocketRoom(data);
    if (!room || !data.userId) return;

    const abandoned = room.drawing.abandonUserStrokes(data.userId);
    for (const strokeId of abandoned) {
      socket.to(room.id).emit(Events.STROKE_ABANDONED, { strokeId });
    }

    const left = room.removeUser(data.userId);
    if (left) {
      socket.to(room.id).emit(Events.USER_LEFT, { userId: left.id });
    }

    rooms.cleanupIfEmpty(room.id);
  });
});

function getSocketRoom(data: SocketData) {
  if (!data.roomId) return undefined;
  return rooms.get(data.roomId);
}

function broadcastHistory(roomId: string, room: { drawing: { getStrokes: () => unknown; canUndo: () => boolean; canRedo: () => boolean } }) {
  const payload: HistoryUpdatedPayload = {
    strokes: room.drawing.getStrokes() as HistoryUpdatedPayload["strokes"],
    canUndo: room.drawing.canUndo(),
    canRedo: room.drawing.canRedo(),
  };
  io.to(roomId).emit(Events.HISTORY_UPDATED, payload);
}

function isFiniteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/** Allow hex colors only — blocks CSS injection via color strings. */
function sanitizeColor(color: unknown): string {
  if (typeof color === "string" && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color)) {
    return color;
  }
  return "#111111";
}

httpServer.listen(PORT, () => {
  console.log(`Collaborative canvas running at http://localhost:${PORT}`);
  console.log(`Open two browser tabs to test multi-user drawing.`);
});
