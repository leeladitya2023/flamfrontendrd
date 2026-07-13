import { io, Socket } from "socket.io-client";
import {
  Events,
  type HistoryUpdatedPayload,
  type RoomState,
  type Stroke,
  type Tool,
  type User,
} from "../shared/protocol.js";

/**
 * SocketClient — thin wrapper around Socket.io.
 *
 * Why wrap: keeps event names / payloads in one place and lets main.ts
 * stay focused on UI wiring. Also makes reconnect UX easier to attach.
 */

export interface SocketHandlers {
  onRoomState: (state: RoomState) => void;
  onUserJoined: (user: User) => void;
  onUserLeft: (userId: string) => void;
  onCursorUpdate: (userId: string, x: number, y: number) => void;
  onStrokeStart: (payload: {
    strokeId: string;
    userId: string;
    tool: Tool;
    color: string;
    width: number;
    x: number;
    y: number;
  }) => void;
  onStrokePoint: (strokeId: string, userId: string, x: number, y: number) => void;
  onStrokeCommitted: (stroke: Stroke) => void;
  onStrokeAbandoned: (strokeId: string) => void;
  onHistoryUpdated: (payload: HistoryUpdatedPayload) => void;
  onError: (message: string) => void;
  onConnectionChange: (connected: boolean) => void;
}

export class SocketClient {
  private socket: Socket;
  private handlers: SocketHandlers;

  constructor(handlers: SocketHandlers) {
    this.handlers = handlers;

    // Same-origin connection — Express serves client and Socket.io on one port.
    this.socket = io({
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
    });

    this.socket.on("connect", () => {
      this.handlers.onConnectionChange(true);
    });

    this.socket.on("disconnect", () => {
      this.handlers.onConnectionChange(false);
    });

    this.socket.on(Events.ROOM_STATE, (state: RoomState) => {
      this.handlers.onRoomState(state);
    });

    this.socket.on(Events.USER_JOINED, (payload: { user: User }) => {
      this.handlers.onUserJoined(payload.user);
    });

    this.socket.on(Events.USER_LEFT, (payload: { userId: string }) => {
      this.handlers.onUserLeft(payload.userId);
    });

    this.socket.on(
      Events.CURSOR_UPDATE,
      (payload: { userId: string; x: number; y: number }) => {
        this.handlers.onCursorUpdate(payload.userId, payload.x, payload.y);
      }
    );

    this.socket.on(Events.STROKE_START_BROADCAST, (payload) => {
      this.handlers.onStrokeStart(payload);
    });

    this.socket.on(
      Events.STROKE_POINT_BROADCAST,
      (payload: { strokeId: string; userId: string; x: number; y: number }) => {
        this.handlers.onStrokePoint(
          payload.strokeId,
          payload.userId,
          payload.x,
          payload.y
        );
      }
    );

    this.socket.on(Events.STROKE_COMMITTED, (payload: { stroke: Stroke }) => {
      this.handlers.onStrokeCommitted(payload.stroke);
    });

    this.socket.on(Events.STROKE_ABANDONED, (payload: { strokeId: string }) => {
      this.handlers.onStrokeAbandoned(payload.strokeId);
    });

    this.socket.on(Events.HISTORY_UPDATED, (payload: HistoryUpdatedPayload) => {
      this.handlers.onHistoryUpdated(payload);
    });

    this.socket.on(Events.ERROR, (payload: { message: string }) => {
      this.handlers.onError(payload.message);
    });
  }

  joinRoom(roomId: string, userName?: string): void {
    this.socket.emit(Events.ROOM_JOIN, { roomId, userName });
  }

  moveCursor(x: number, y: number): void {
    this.socket.emit(Events.CURSOR_MOVE, { x, y });
  }

  strokeStart(payload: {
    strokeId: string;
    tool: Tool;
    color: string;
    width: number;
    x: number;
    y: number;
  }): void {
    this.socket.emit(Events.STROKE_START, payload);
  }

  strokePoint(strokeId: string, x: number, y: number): void {
    this.socket.emit(Events.STROKE_POINT, { strokeId, x, y });
  }

  strokeEnd(strokeId: string): void {
    this.socket.emit(Events.STROKE_END, { strokeId });
  }

  undo(): void {
    this.socket.emit(Events.HISTORY_UNDO);
  }

  redo(): void {
    this.socket.emit(Events.HISTORY_REDO);
  }

  /** After reconnect, caller should joinRoom again to resync state. */
  onReconnect(cb: () => void): void {
    this.socket.io.on("reconnect", cb);
  }
}
