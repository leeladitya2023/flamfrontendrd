# Flam Canvas — Real-Time Collaborative Drawing

Multi-user drawing board built with **vanilla TypeScript**, **HTML5 Canvas**, **Node.js**, and **Socket.io**.

Multiple people draw on the same canvas at once. Strokes sync **while drawing** (not after mouse-up). Includes remote cursors, presence, **per-user undo/redo**, and rooms.

## Live demo

**https://flam-collaborative-canvas-6imm.onrender.com/**

Multi-user test (open two tabs):

- [Room demo as Ada](https://flam-collaborative-canvas-6imm.onrender.com/?room=demo&name=Ada)
- [Room demo as Sam](https://flam-collaborative-canvas-6imm.onrender.com/?room=demo&name=Sam)

> Free Render instances sleep after ~15 minutes idle — the first load may take about a minute to wake.

## Quick start

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000).

### Test with multiple users

1. Open the app and enter your **name** (and optional room) on the join screen
2. Open a second tab, enter a different name, same room
3. Draw in either tab — strokes and cursors sync live
4. Press **Ctrl+Z** / **Ctrl+Y** (or Undo/Redo) — each person undoes **only their own** strokes

Same room name = same canvas. Different rooms are isolated.

## Scripts

| Command | What it does |
|---------|----------------|
| `npm start` | Bundle client + run server |
| `npm run dev` | Bundle client + run server with reload |
| `npm run build:client` | Bundle `client/main.ts` → `client/dist/main.js` |
| `npm run typecheck` | TypeScript check (no emit) |

## Features

- Brush + eraser, colors, stroke width
- Live stroke streaming (`stroke:start` / `stroke:point` / `stroke:end`)
- Remote cursor indicators
- Online user list with assigned colors
- Per-user undo/redo (each writer can only undo their own strokes)
- Rooms via `?room=`
- Touch / pen via Pointer Events
- HiDPI canvas (`devicePixelRatio`)
- Reconnect + re-join for state resync

## Stack

- **Client:** TypeScript, Canvas API, Socket.io client (no React/Vue, no drawing libs)
- **Server:** Express, Socket.io, in-memory room state
- **Shared:** `shared/protocol.ts` event names + types

## Project structure

```
collaborative-canvas/
├── client/           # UI + canvas + socket client
├── server/           # Express + Socket.io + room/history logic
├── shared/           # Protocol types shared by both sides
├── package.json
├── README.md
└── ARCHITECTURE.md
```

## Known limitations

- State is **in-memory** — restarting the server clears drawings
- Single Node process — not horizontally scaled (no Redis pub/sub yet)
- Full canvas replay on undo/redo — fine for typical session sizes; would need bitmap caching at very large histories
- No auth — anyone with the room link can join
- Color sanitization allows hex only

## Deploy

### Render (recommended for Socket.io)

**Deployed at:** [https://flam-collaborative-canvas-6imm.onrender.com/](https://flam-collaborative-canvas-6imm.onrender.com/)

This app needs a **long-running Node server** (WebSockets). Static hosts like plain Vercel won’t work well.

**One-click Blueprint deploy:**

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/leeladitya2023/flamfrontendrd)

Or manually:

1. Go to [Render Dashboard](https://dashboard.render.com/) → **New** → **Web Service**
2. Connect `leeladitya2023/flamfrontendrd`
3. Settings:
   - **Build:** `npm install && npm run build`
   - **Start:** `npm start`
   - **Health check:** `/health`
   - **Instance:** Free
4. Deploy — URL will look like `https://flam-collaborative-canvas.onrender.com`

Free tier note: the service sleeps after ~15 minutes idle; first request may take ~1 minute to wake. Socket reconnect is already handled.

### Local tunnel (quick share while PC is on)

```bash
npm start
# in another terminal, with ngrok installed:
ngrok http 3000
```

## Time spent

~1 focused implementation pass (core realtime + global undo + docs). Polish / deploy / metrics as follow-ups.

## License

MIT
