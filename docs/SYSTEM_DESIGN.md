# System design notes (OT + offline merge)

This doc exists to make the **conflict handling rules explicit**.

## Data model

We represent edits as operations:

- `ins(pos, text)` at a specific character offset
- `del(pos, len)` deleting a range

Each op is tagged with:

- `baseRev`: the server revision the client used as a base
- `clientId` + `seq`: together create a globally unique `opId = clientId:seq`

Server maintains:

- `text` (current snapshot)
- `rev` (monotonic revision)
- `ops[]` (append-only op-log; op index `i` corresponds to revision `i+1`)

## OT transform rules (the merge strategy)

All convergence comes from one function:

- `transformAgainst(a, b)` = transform op **a** so it can be applied **after** op **b**.

### 1) Insert vs insert (same position rule)

If two inserts are concurrent and at the same position:

- `insA(pos=5, "X")`
- `insB(pos=5, "Y")`

We need a deterministic ordering, otherwise different clients might apply them in different orders.

**Rule**: order by `(clientId, seq)`:

- if `(A.clientId, A.seq) < (B.clientId, B.seq)` then A is considered “before” B
- B is shifted right by `len("X")`

So if A sorts before B:

- `transformAgainst(B, A)` becomes `ins(pos=6, "Y")`

This rule is implemented in `packages/shared/src/ot.ts` as `defaultTieBreak()`.

### 2) Insert vs delete

Let `b = del(b.pos, b.len)` define a deleted interval `[b.pos, b.pos+b.len)`.

Transforming an insert `a = ins(a.pos, a.text)` against `b`:

- if `a.pos <= b.pos` → unchanged
- if `a.pos >= b.pos+b.len` → shift left by `b.len`
- if `a.pos` is inside the deleted interval → clamp to `b.pos`

### 3) Delete vs insert

Transforming a delete `a = del(a.pos, a.len)` against an insert `b = ins(b.pos, b.text)`:

- if `a.pos >= b.pos` → shift right by `len(b.text)`
- else unchanged

### 4) Delete vs delete (overlap)

Two deletes may overlap.

- if `a` is entirely before `b` → unchanged
- if `a` is entirely after `b` → shift left by `b.len`
- if overlap → remove the intersection so characters are deleted once
- if `a.len` becomes `0` → treated as no-op

## Server-side merge (rebase)

When the server receives an op `op` with `baseRev`:

1. take all server ops since `baseRev`: `opsSince = ops[baseRev:]`
2. rebase the op across them:
   - `rebased = transformAgainst(op, opsSince[0])`
   - then `transformAgainst(rebased, opsSince[1])`, etc.
3. apply `rebased` to the current server text
4. append `rebased` to the op-log and increment `rev`

This is implemented by `rebaseOp()` in `packages/shared/src/ot.ts` and used by `apps/server/src/docs.service.ts`.

## Offline merge on reconnect

Client keeps a queue:

- `outstanding`: the one op that has been sent but not acked
- `buffer`: ops typed while outstanding exists

On reconnect:

1. client sends `join { docId, knownRev }`
2. server sends `snapshot` and any missing ops since `knownRev`
3. client transforms remote ops through `(outstanding + buffer)`
4. client sends `outstanding` again if needed

### Why ops don’t duplicate after restart

Server persists `ops[]` in `apps/server/data/<docId>.json`.

On startup/load, the server rebuilds a dedupe map from persisted ops:

- if an op with the same `opId` is received again (common after reconnect), it is treated as already applied.

This prevents “character multiplication” when clients retry after disconnects.

