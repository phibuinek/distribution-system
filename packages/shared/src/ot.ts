import type { TextOp } from "./types";

/**
 * Operational Transformation (OT) engine for concurrent text editing.
 *
 * ## Conflict Resolution Rules
 *
 * Every operation carries a `baseRev` — the server revision it was produced
 * against.  When two clients produce operations concurrently (same baseRev),
 * the server rebases the later-arriving operation against every op committed
 * since that baseRev using `transformAgainst`.  The rules below are applied
 * deterministically so every client converges to the same final text regardless
 * of network arrival order.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  a \ b        │ ins(b)                        │ del(b)                  │
 * ├───────────────┼──────────────────────────────┼─────────────────────────┤
 * │ ins(a)        │ pos < b.pos  → unchanged       │ pos ≤ b.pos → unchanged │
 * │               │ pos > b.pos  → pos += b.len    │ pos ≥ b.end → pos -= b.len│
 * │               │ pos = b.pos  → TIEBREAK (↓)    │ pos inside  → text=""  │
 * │               │                               │   (delete wins; noop)   │
 * ├───────────────┼──────────────────────────────┼─────────────────────────┤
 * │ del(a)        │ b.pos ≤ a.pos → pos += b.len   │ entirely before → unchanged │
 * │               │ b.pos ≥ a.end → unchanged      │ entirely after  → pos -= b.len│
 * │               │ b.pos inside  → len += b.len   │ overlapping     → shrink len │
 * │               │   (expand to cover insert)     │ fully covered   → noop (len=0)│
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * ### Delete wins (Insert inside Delete range)
 * When an insert targets a position strictly inside a concurrent delete's range,
 * we apply "delete wins" semantics to guarantee convergence:
 *   - The delete expands its length to cover the inserted characters.
 *   - The insert becomes a no-op (empty text).
 * This is the only choice that produces identical final documents on all clients
 * when using single contiguous text operations.
 *
 * ### Tiebreak rule (Insert vs Insert at the SAME position)
 * When two inserts target the same position concurrently, we need a total
 * ordering to guarantee convergence.  Rule:
 *
 *   The operation whose clientId sorts lexicographically SMALLER goes first.
 *   On equal clientId (same client, different ops), lower seq goes first.
 *
 * Example: clientA ("t_000…") inserts "anh" at pos 0,
 *          clientB ("t_111…") inserts "khong biet" at pos 0 concurrently.
 *   → clientA < clientB lexicographically, so A's insert lands at pos 0.
 *   → B's insert is transformed to pos 3  ("anh".length).
 *   → Final text: "anhkhong biet"  (deterministic on all clients).
 *
 * ### Offline reconnect merge
 * When a client reconnects after being offline, it sends its queued ops with
 * the original `baseRev` from when it went offline.  The server rebases those
 * ops against every committed op since that baseRev — exactly the same OT
 * transformation as for online concurrent edits.  The client must NOT rebase
 * against the snapshot text it receives on reconnect; it must use its
 * pre-offline base so the server can do the correct relative transformation.
 */

export function applyOp(text: string, op: TextOp): string {
  if (op.kind === "ins") {
    if (op.pos < 0 || op.pos > text.length) return text;
    return text.slice(0, op.pos) + op.text + text.slice(op.pos);
  }
  if (op.pos < 0 || op.pos > text.length) return text;
  const start = op.pos;
  const end = Math.min(text.length, op.pos + op.len);
  return text.slice(0, start) + text.slice(end);
}

type TieBreak = (a: TextOp, b: TextOp) => -1 | 1;

// A deterministic ordering for concurrent inserts at same position.
// Returns -1 if a should be considered "before" b.
export const defaultTieBreak: TieBreak = (a, b) => {
  if (a.clientId < b.clientId) return -1;
  if (a.clientId > b.clientId) return 1;
  return a.seq <= b.seq ? -1 : 1;
};

// Transform op "a" so it can be applied after op "b".
// Both operations are assumed to be based on the same document state originally.
export function transformAgainst(a: TextOp, b: TextOp, tieBreak: TieBreak = defaultTieBreak): TextOp {
  if (a.kind === "ins" && b.kind === "ins") {
    if (a.pos < b.pos) return a;
    if (a.pos > b.pos) return { ...a, pos: a.pos + b.text.length };
    // same position: deterministic ordering
    const before = tieBreak(a, b) === -1;
    return before ? a : { ...a, pos: a.pos + b.text.length };
  }

  if (a.kind === "ins" && b.kind === "del") {
    const bStart = b.pos;
    const bEnd = b.pos + b.len;
    if (a.pos <= bStart) return a;
    if (a.pos >= bEnd) return { ...a, pos: a.pos - b.len };
    // Inserting inside a deleted range: "delete wins".
    // The delete will expand (see del vs ins below) to cover our text, so our
    // insert must become a no-op to keep all clients convergent.
    // Returning an empty-text insert is safe: applyOp ignores it and isNoop
    // catches it so callers can drop it from queues.
    return { ...a, pos: bStart, text: "" };
  }

  if (a.kind === "del" && b.kind === "ins") {
    const aEnd = a.pos + a.len;
    const insLen = b.text.length;
    if (b.pos <= a.pos) {
      // Insert lands at or before our deletion start: shift the delete right.
      return { ...a, pos: a.pos + insLen };
    }
    if (b.pos >= aEnd) {
      // Insert lands at or after our deletion end: no change.
      return a;
    }
    // Insert lands strictly inside our deletion range: "delete wins".
    // Expand the delete to cover the newly inserted characters so that both
    // clients produce the same document after transformation.
    return { ...a, len: a.len + insLen };
  }

  if (a.kind !== "del" || b.kind !== "del") return a;

  // del vs del
  const aStart = a.pos;
  const aEnd = a.pos + a.len;
  const bStart = b.pos;
  const bEnd = b.pos + b.len;

  if (aEnd <= bStart) return a; // entirely before b
  if (aStart >= bEnd) return { ...a, pos: a.pos - b.len }; // entirely after b

  // overlap: remove intersection from a
  const overlapStart = Math.max(aStart, bStart);
  const overlapEnd = Math.min(aEnd, bEnd);
  const overlapLen = Math.max(0, overlapEnd - overlapStart);

  const newLen = a.len - overlapLen;
  const newPos = aStart > bStart ? a.pos - (overlapStart - bStart) : a.pos;

  // if fully deleted by b, become a no-op delete of length 0 (caller may drop)
  return { ...a, pos: newPos, len: Math.max(0, newLen) } as TextOp;
}

export function isNoop(op: TextOp): boolean {
  if (op.kind === "del") return op.len <= 0;
  if (op.kind === "ins") return op.text.length === 0;
  return false;
}

export function rebaseOp(op: TextOp, opsSinceBase: TextOp[]): TextOp {
  let cur: TextOp = op;
  for (const b of opsSinceBase) {
    cur = transformAgainst(cur, b);
    if (isNoop(cur)) break;
  }
  return cur;
}

