import { CanvasController } from "./canvas.js";
import { SocketClient } from "./socket.js";
import { ClientState } from "./state.js";
import type { Tool, User } from "../shared/protocol.js";

/**
 * main.ts — application bootstrap and UI wiring.
 *
 * Render flow:
 *  1. Read room/name from URL (?room=demo&name=Ada)
 *  2. Create canvas + socket
 *  3. Join room → server sends ROOM_STATE → paint history + presence
 *  4. Local pointer events → optimistic draw + socket emit
 *  5. Remote events → update canvas + sidebar
 */

const BRUSH_COLORS = [
  "#111111",
  "#E63946",
  "#2A9D8F",
  "#457B9D",
  "#F4A261",
  "#9B5DE5",
  "#FFFFFF",
];

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
}

function init(): void {
  const params = new URLSearchParams(window.location.search);
  const roomId = params.get("room") || "lobby";
  const userName = params.get("name") || undefined;

  const state = new ClientState();

  const canvasEl = $("board") as HTMLCanvasElement;
  const overlayEl = $("overlay") as HTMLCanvasElement;
  const usersEl = $("users");
  const statusEl = $("status");
  const roomLabel = $("room-label");
  const undoBtn = $("undo") as HTMLButtonElement;
  const redoBtn = $("redo") as HTMLButtonElement;
  const widthInput = $("width") as HTMLInputElement;
  const widthValue = $("width-value");
  const toastEl = $("toast");

  roomLabel.textContent = roomId;

  let socket!: SocketClient;

  const canvas = new CanvasController(canvasEl, overlayEl, {
    onStrokeStart: (info) => socket.strokeStart(info),
    onStrokePoint: (info) => socket.strokePoint(info.strokeId, info.x, info.y),
    onStrokeEnd: (info) => socket.strokeEnd(info.strokeId),
    onCursorMove: (point) => socket.moveCursor(point.x, point.y),
  });

  socket = new SocketClient({
    onConnectionChange: (connected) => {
      state.connected = connected;
      statusEl.textContent = connected ? "Connected" : "Reconnecting…";
      statusEl.dataset.state = connected ? "ok" : "warn";
    },

    onRoomState: (payload) => {
      state.resetFromRoom(payload);
      canvas.setStrokes(payload.strokes);
      canvas.setUsersForCursors(payload.users, payload.you.id);
      renderUsers();
      renderHistoryButtons();
      showToast(`Joined room “${payload.roomId}” as ${payload.you.name}`);
    },

    onUserJoined: (user) => {
      state.addUser(user);
      renderUsers();
      showToast(`${user.name} joined`);
    },

    onUserLeft: (userId) => {
      const leaving = state.users.find((u) => u.id === userId);
      state.removeUser(userId);
      canvas.removeCursor(userId);
      renderUsers();
      if (leaving) showToast(`${leaving.name} left`);
    },

    onCursorUpdate: (userId, x, y) => {
      if (state.self?.id === userId) return;
      const user = state.users.find((u) => u.id === userId);
      if (!user) return;
      canvas.updateCursor(user, x, y);
    },

    onStrokeStart: (payload) => {
      if (payload.userId === state.self?.id) return;
      canvas.startRemoteStroke(payload);
    },

    onStrokePoint: (strokeId, userId, x, y) => {
      if (userId === state.self?.id) return;
      canvas.addRemotePoint(strokeId, x, y);
    },

    onStrokeCommitted: (stroke) => {
      state.upsertStroke(stroke);
      canvas.commitStroke(stroke);
    },

    onStrokeAbandoned: (strokeId) => {
      canvas.abandonRemoteStroke(strokeId);
    },

    onHistoryUpdated: (payload) => {
      state.setHistory(payload.strokes, payload.canUndo, payload.canRedo);
      canvas.setStrokes(payload.strokes);
      renderHistoryButtons();
    },

    onError: (message) => showToast(message, true),
  });

  // Re-join after reconnect so we get a fresh ROOM_STATE (source of truth).
  socket.onReconnect(() => {
    socket.joinRoom(state.roomId || roomId, state.self?.name || userName);
  });

  socket.joinRoom(roomId, userName);

  // --- Toolbar ---
  document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tool = btn.dataset.tool as Tool;
      canvas.setTool(tool);
      document.querySelectorAll("[data-tool]").forEach((b) => {
        b.classList.toggle("is-active", b === btn);
      });
    });
  });

  const swatches = $("swatches");
  for (const hex of BRUSH_COLORS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "swatch";
    btn.style.background = hex;
    btn.title = hex;
    btn.setAttribute("aria-label", `Color ${hex}`);
    if (hex === "#111111") btn.classList.add("is-active");
    if (hex === "#FFFFFF") btn.classList.add("is-light");
    btn.addEventListener("click", () => {
      canvas.setColor(hex);
      swatches.querySelectorAll(".swatch").forEach((s) => s.classList.remove("is-active"));
      btn.classList.add("is-active");
    });
    swatches.appendChild(btn);
  }

  widthInput.addEventListener("input", () => {
    const value = Number(widthInput.value);
    canvas.setWidth(value);
    widthValue.textContent = `${value}px`;
  });

  undoBtn.addEventListener("click", () => socket.undo());
  redoBtn.addEventListener("click", () => socket.redo());

  window.addEventListener("keydown", (e) => {
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key.toLowerCase() === "z" && !e.shiftKey) {
      e.preventDefault();
      socket.undo();
    } else if (meta && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
      e.preventDefault();
      socket.redo();
    } else if (e.key.toLowerCase() === "b") {
      selectTool("brush");
    } else if (e.key.toLowerCase() === "e") {
      selectTool("eraser");
    }
  });

  function selectTool(tool: Tool): void {
    canvas.setTool(tool);
    document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.tool === tool);
    });
  }

  function renderUsers(): void {
    usersEl.innerHTML = "";
    for (const user of state.users) {
      usersEl.appendChild(userRow(user, user.id === state.self?.id));
    }
    $("online-count").textContent = String(state.users.length);
  }

  function renderHistoryButtons(): void {
    undoBtn.disabled = !state.canUndo;
    redoBtn.disabled = !state.canRedo;
  }

  let toastTimer: number | undefined;
  function showToast(message: string, isError = false): void {
    toastEl.textContent = message;
    toastEl.dataset.tone = isError ? "error" : "info";
    toastEl.classList.add("is-visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toastEl.classList.remove("is-visible");
    }, 2400);
  }
}

function userRow(user: User, isSelf: boolean): HTMLElement {
  const li = document.createElement("li");
  li.className = "user-row";
  li.innerHTML = `
    <span class="user-dot" style="background:${user.color}"></span>
    <span class="user-name">${escapeHtml(user.name)}${isSelf ? " (you)" : ""}</span>
  `;
  return li;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

init();
