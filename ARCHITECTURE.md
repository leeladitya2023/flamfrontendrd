# Architecture

## Goals

- Smooth multi-user drawing with **live** stroke sync
- Server-authoritative history for **global undo/redo**
- Clear separation: canvas rendering vs networking vs room state
- Defendable trade-offs in a live interview

## High-level diagram

```
┌──────────────┐  stroke:start/point/end   ┌─────────────────────┐
│  Client A    │ ─────────────────────────►│  Socket.io Server   │
│  Canvas + UI │ ◄─────────────────────────│  RoomManager        │
└──────────────┘  broadcast + room:state   │  DrawingState       │
┌──────────────┐                           │  (history/redo)     │
│  Client B    │ ◄─────────────────────────│                     │
└──────────────┘                           └─────────────────────┘
```

## Data flow (drawing)

1. User presses pointer on overlay canvas.
2. **Client-side prediction:** local stroke is painted immediately.
3. Client emits `stroke:start`, then many `stroke:point`, then `stroke:end`.
4. Server stores an in-progress stroke; on `stroke:end` it **commits** to `history` and clears `redoStack`.
5. Server broadcasts to the room:
   - live points to *others* during the stroke
   - `stroke:committed` to *everyone* when finished
6. Remote clients paint live previews, then treat the stroke as committed.

Coordinates are **normalized 0..1** relative to the canvas CSS box so different viewport sizes stay aligned.

## WebSocket / Socket.io protocol

### Client → Server

| Event | Payload | Purpose |
|-------|---------|---------|
| `room:join` | `{ roomId, userName? }` | Enter a room; receive full state |
| `cursor:move` | `{ x, y }` | Presence cursor (throttled on client) |
| `stroke:start` | `{ strokeId, tool, color, width, x, y }` | Begin live stroke |
| `stroke:point` | `{ strokeId, x, y }` | Append point |
| `stroke:end` | `{ strokeId }` | Commit stroke into history |
| `history:undo` | `{}` | Global undo |
| `history:redo` | `{}` | Global redo |

### Server → Client

| Event | Purpose |
|-------|---------|
| `room:state` | Late-joiner / reconnect full sync |
| `user:joined` / `user:left` | Presence |
| `cursor:update` | Remote cursors |
| `stroke:start` / `stroke:point` | Live remote drawing |
| `stroke:committed` | Finalize stroke |
| `stroke:abandoned` | Drop mid-stroke on disconnect |
| `history:updated` | After undo/redo (and undo flags after commit) |
| `error` | Validation / join failures |

Event names live in `shared/protocol.ts` so client and server cannot drift.

## Undo / redo strategy

Server holds two stacks per room:

- `history: Stroke[]` — committed strokes (oldest → newest)
- `redoStack: Stroke[]` — strokes removed by undo

**Undo:** `pop` history → `push` redo → broadcast full `strokes` → every client clears and **replays**.

**Redo:** opposite.

**New stroke after undo:** `redoStack` is cleared (standard editor semantics).

**Global meaning:** undo removes the chronologically last committed stroke in the room, even if another user drew it. That matches the assignment’s “global undo/redo” requirement. Per-user undo is a product alternative, not what we implemented.

In-progress (live) strokes are **not** in `history` until `stroke:end`, so undo does not fight mid-stroke point streams.

## Conflict resolution

Freehand strokes compose; they do not merge pixels.

- Simultaneous drawing → both strokes kept; order = server receive / commit order.
- Overlap → later stroke paints on top when replayed.
- Simultaneous undo → serialized by the Node event loop; each undo pops one op.
- Disconnect mid-stroke → abandon in-progress stroke; committed history stays.

This is intentionally simpler than CRDT/OT. For freehand drawing in a take-home, an **operation log** is the right complexity / clarity trade-off.

## Performance decisions

| Decision | Why |
|----------|-----|
| Stream points, not PNG frames | Bandwidth + latency |
| Stroke-level ops | Natural undo unit |
| Local immediate draw | Hides RTT (client-side prediction) |
| Normalized coordinates | Cross-device alignment |
| Cursor throttle via `requestAnimationFrame` | Avoid socket floods |
| Full replay on undo | Correctness first; easy to explain |
| In-memory rooms | Enough for demo; document Redis for scale |
| Two canvases (board + overlay) | Cursors without dirtying stroke pixels every move |
| `devicePixelRatio` resize | Sharp lines on retina |

### Possible next optimizations

- Offscreen bitmap cache of settled history; rebuild only on undo
- Point batching (`points[]` every 16–32ms) under heavy load
- Path simplification (Ramer–Douglas–Peucker) for long strokes
- Redis + Socket.io adapter for multi-instance fan-out

## Why Socket.io

Native WebSockets are a raw duplex pipe. This app needs:

- named events
- rooms
- reconnect

Socket.io provides those. We still own the protocol, history model, and canvas. In interview terms: “Socket.io for transport reliability / rooms; custom application protocol on top.”

## Module responsibilities

### Client

- `canvas.ts` — pointer capture, paint, cursors, DPR
- `socket.ts` — Socket.io wrapper
- `state.ts` — UI mirror of room state
- `main.ts` — DOM wiring, shortcuts, toasts

### Server

- `server.ts` — HTTP static + Socket.io handlers
- `rooms.ts` — room registry, users, color assignment
- `drawing-state.ts` — history / redo / in-progress strokes

### Shared

- `protocol.ts` — types + event constants + user color palette

## Scaling sketch (interview)

For ~1000 concurrent users:

1. Sticky sessions or Redis adapter so room broadcasts reach all nodes
2. Cap points/sec per socket; batch points
3. Shard rooms across instances
4. Persist strokes (Postgres/S3) if sessions must survive restarts
5. CDN for static client assets; WS only for events
6. Metrics: room size, event rate, p95 emit latency, reconnect rate

## Security notes (current scope)

- No auth (per assignment FAQ)
- Hex-only colors to avoid CSS/script injection via color strings
- Room ids truncated/normalized
- Stroke width clamped
