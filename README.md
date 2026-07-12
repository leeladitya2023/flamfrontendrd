# Flam Canvas — Real-Time Collaborative Drawing

Multi-user drawing board built with **vanilla TypeScript**, **HTML5 Canvas**, **Node.js**, and **Socket.io**.

Multiple people draw on the same canvas at once. Strokes sync **while drawing** (not after mouse-up). Includes remote cursors, presence, global undo/redo, and rooms.

## Quick start

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000).

### Test with multiple users

1. Tab A: `http://localhost:3000/?room=demo&name=Ada`
2. Tab B: `http://localhost:3000/?room=demo&name=Sam`
3. Draw in either tab — the other should show strokes live and labeled cursors.
4. Press **Ctrl+Z** / **Ctrl+Y** (or Undo/Redo buttons) — history is **global** for the room.

Same `room` query param = same canvas. Different room ids are isolated.

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
- Global undo/redo (shared operation log on the server)
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

Set `PORT` if needed. Build client assets as part of start (`npm start` already builds).

Examples: Render, Railway, Fly.io, or a VPS with Node 18+.

For a static host + separate WS server, serve `client/` and point the Socket.io client URL at your API origin.

## Time spent

~1 focused implementation pass (core realtime + global undo + docs). Polish / deploy / metrics as follow-ups.

## License

MIT
