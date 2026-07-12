import { CanvasController } from "./canvas.js";
import { SocketClient } from "./socket.js";
import { ClientState } from "./state.js";
import type { Tool, User } from "../shared/protocol.js";

/**
 * main.ts — application bootstrap and UI wiring.
 *
 * Flow:
 *  1. Show join gate (name required)
 *  2. Connect socket + join room
 *  3. Unlock canvas after ROOM_STATE
 *  4. Local draw → optimistic paint + socket; undo/redo via server history
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

const NAME_KEY = "flam-canvas-name";
const ROOM_KEY = "flam-canvas-room";

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
}

function init(): void {
  const params = new URLSearchParams(window.location.search);
  const queryRoom = params.get("room");
  const queryName = params.get("name");

  const state = new ClientState();
  let activeRoomId = queryRoom || sessionStorage.getItem(ROOM_KEY) || "lobby";
  let activeUserName = queryName || sessionStorage.getItem(NAME_KEY) || "";
  let hasJoined = false;

  const joinGate = $("join-gate");
  const joinForm = $("join-form") as HTMLFormElement;
  const joinName = $("join-name") as HTMLInputElement;
  const joinRoom = $("join-room") as HTMLInputElement;
  const appShell = $("app-shell");

  joinName.value = activeUserName;
  joinRoom.value = activeRoomId;
  joinName.focus();

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

  roomLabel.textContent = activeRoomId;

  let socket!: SocketClient;

  const canvas = new CanvasController(canvasEl, overlayEl, {
    onStrokeStart: (info) => {
      if (!hasJoined) return;
      socket.strokeStart(info);
    },
    onStrokePoint: (info) => {
      if (!hasJoined) return;
      socket.strokePoint(info.strokeId, info.x, info.y);
    },
    onStrokeEnd: (info) => {
      if (!hasJoined) return;
      socket.strokeEnd(info.strokeId);
    },
    onCursorMove: (point) => {
      if (!hasJoined) return;
      socket.moveCursor(point.x, point.y);
    },
  });

  canvas.setReady(false);

  socket = new SocketClient({
    onConnectionChange: (connected) => {
      state.connected = connected;
      statusEl.textContent = connected ? "Connected" : "Reconnecting…";
      statusEl.dataset.state = connected ? "ok" : "warn";
    },

    onRoomState: (payload) => {
      hasJoined = true;
      state.resetFromRoom(payload);
      activeRoomId = payload.roomId;
      activeUserName = payload.you.name;
      roomLabel.textContent = payload.roomId;
      canvas.setStrokes(payload.strokes);
      canvas.setUsersForCursors(payload.users, payload.you.id);
      canvas.setReady(true);
      unlockApp();
      renderUsers();
      renderHistoryButtons();
      showToast(`Joined “${payload.roomId}” as ${payload.you.name}`);
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
      // New commit invalidates redo and enables undo — update UI immediately
      // even before HISTORY_UPDATED arrives.
      state.canUndo = true;
      state.canRedo = false;
      canvas.commitStroke(stroke);
      renderHistoryButtons();
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

  socket.onReconnect(() => {
    if (!activeUserName) return;
    hasJoined = false;
    canvas.setReady(false);
    socket.joinRoom(activeRoomId, activeUserName);
  });

  joinForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = joinName.value.trim();
    const room = (joinRoom.value.trim() || "lobby").slice(0, 64);
    if (!name) {
      showToast("Please enter your name", true);
      joinName.focus();
      return;
    }

    activeUserName = name.slice(0, 24);
    activeRoomId = room;
    sessionStorage.setItem(NAME_KEY, activeUserName);
    sessionStorage.setItem(ROOM_KEY, activeRoomId);

    const url = new URL(window.location.href);
    url.searchParams.set("room", activeRoomId);
    url.searchParams.set("name", activeUserName);
    window.history.replaceState({}, "", url);

    roomLabel.textContent = activeRoomId;
    statusEl.textContent = "Joining…";
    statusEl.dataset.state = "warn";
    socket.joinRoom(activeRoomId, activeUserName);
  });

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

  undoBtn.addEventListener("click", () => {
    if (!hasJoined || !state.canUndo) return;
    socket.undo();
  });
  redoBtn.addEventListener("click", () => {
    if (!hasJoined || !state.canRedo) return;
    socket.redo();
  });

  window.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable)
    ) {
      return;
    }

    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key.toLowerCase() === "z" && !e.shiftKey) {
      e.preventDefault();
      if (hasJoined && state.canUndo) socket.undo();
    } else if (
      meta &&
      (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))
    ) {
      e.preventDefault();
      if (hasJoined && state.canRedo) socket.redo();
    } else if (e.key.toLowerCase() === "b") {
      selectTool("brush");
    } else if (e.key.toLowerCase() === "e") {
      selectTool("eraser");
    }
  });

  function unlockApp(): void {
    joinGate.classList.add("is-hidden");
    appShell.classList.remove("is-locked");
    appShell.removeAttribute("aria-hidden");
  }

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
