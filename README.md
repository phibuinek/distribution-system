# Distributed Real-Time Sync (NestJS + NextJS)

Production-style assignment: a collaborative text editor with concurrent edits, conflict resolution, and offline sync.

## Architecture

- **`apps/server`**: NestJS API + WebSocket sync server
- **`apps/web`**: NextJS client (textarea editor) with OT, offline queue, and reconnect sync
- **`packages/shared`**: Shared OT (Operational Transformation) types + transform logic (**no prebuilt OT/CRDT libs**)

## Quick start

Install deps at repo root:

```bash
npm install
```

Run server:

```bash
npm run dev:server
```

Run web:

```bash
npm run dev:web
```

- **Web**: `http://localhost:3000/doc/demo`
- **API/WS**: `http://localhost:4000`

## How it works (high level)

- **Operation model**: plain-text **insert/delete** operations.
- **Concurrency**: server rebases incoming ops against the server op-log (OT transform).
- **Client correctness (Google-Docs-like shape)**:
  - `outstanding`: the single op that has been sent but not yet acked
  - `buffer`: ops typed while waiting for the outstanding ack
  - remote ops are transformed through `outstanding` + `buffer` to preserve user intention
- **Offline editing**:
  - client stores draft text and queued ops locally and re-sends on reconnect
  - if the server was restarted, the client rebuilds queued ops from **server snapshot → local draft**

## Conflict handling (explicit rules)

This project implements a **deterministic OT rule-set** (no CRDT/OT libraries).

- **Concurrent inserts at the same position**:
  - If two `ins` ops target the same `pos`, the system orders them deterministically by:
    1) `clientId` lexicographic
    2) then `seq` numeric
  - That ordering is used by the `transformAgainst()` function so every participant converges.

- **Insert vs delete**:
  - When transforming an `ins` against a `del`, the insert position shifts left if it is after the deleted range.
  - If the insert falls inside the deleted range, it is clamped to the start of the deleted range.

- **Delete vs delete overlap**:
  - Overlapping deletes are reduced so the intersection is removed once.
  - Deletes that become empty are treated as no-ops.

See `docs/SYSTEM_DESIGN.md` for concrete worked examples.

## Offline merge on reconnect (explicit)

Each op includes `baseRev` (the server revision the client believes it is editing).

- **Normal reconnect**:
  - client reconnects, sends `join { docId, knownRev }`
  - server responds with `snapshot` and `ops` since `knownRev`
  - client re-renders its view as: `serverBaseText + (outstanding + buffer)`
  - client re-sends the outstanding op (then drains buffer after acks)

- **Server restart / mismatch recovery**:
  - server persists `snapshot + op-log` in `apps/server/data/<docId>.json`
  - server dedupes ops by `opId` even after restart (rebuilds dedupe map from persisted op-log)
  - if the server rejects an op (or detects impossible baseRev), client forces a resync (`join` from rev 0)

## Persistence (server)

For demo stability, the server persists documents to:

- `apps/server/data/<docId>.json`

This prevents losing content/revision on server restart. For production, replace this with a DB (e.g. Postgres) and an append-only op log.

## Troubleshooting (Windows)

- **Port 3000 already in use**: stop the other process on port 3000, then rerun `npm run dev:web`.
- **`.next/trace` EPERM**: stop `dev:web`, delete `apps/web/.next`, then start again.

## Notes

- This implementation focuses on **correctness of merge** and **offline rebase** for plain-text with insert/delete operations.
- Cursor/selection “presence” is not implemented yet (can be added as a separate WS channel and transformed like ops).

