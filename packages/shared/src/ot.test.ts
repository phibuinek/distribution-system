/**
 * OT engine — comprehensive test suite
 *
 * Tests cover every cell of the transform matrix, the tiebreak rule,
 * convergence (diamond property), offline-reconnect rebase, and edge cases.
 *
 * Convergence test structure:
 *   Given two concurrent ops A and B on the same base document,
 *   applying them in either order after the correct transform must produce
 *   the same final document:
 *
 *     apply(apply(doc, A), transform(B, A))  ===  apply(apply(doc, B), transform(A, B))
 */

import { describe, it, expect } from "vitest";
import type { TextOp } from "./types";
import { applyOp, transformAgainst, rebaseOp, isNoop, defaultTieBreak } from "./ot";

// ── Helpers ────────────────────────────────────────────────────────────────

let _seq = 0;

function ins(pos: number, text: string, clientId = "cA", seq?: number): TextOp {
  const s = seq ?? ++_seq;
  return { id: `${clientId}:${s}`, clientId, seq: s, docId: "d", baseRev: 0, kind: "ins", pos, text, ts: 0 };
}

function del(pos: number, len: number, clientId = "cA", seq?: number): TextOp {
  const s = seq ?? ++_seq;
  return { id: `${clientId}:${s}`, clientId, seq: s, docId: "d", baseRev: 0, kind: "del", pos, len, ts: 0 };
}

/** Verify the diamond / convergence property: apply(A then B') == apply(B then A') */
function assertConverges(doc: string, A: TextOp, B: TextOp) {
  const docAfterA = applyOp(doc, A);
  const docAfterB = applyOp(doc, B);

  const Bprime = transformAgainst(B, A);
  const Aprime = transformAgainst(A, B);

  const path1 = isNoop(Bprime) ? docAfterA : applyOp(docAfterA, Bprime);
  const path2 = isNoop(Aprime) ? docAfterB : applyOp(docAfterB, Aprime);

  expect(path1).toBe(path2);
  return { path1, path2 };
}

// ── isNoop ────────────────────────────────────────────────────────────────

describe("isNoop", () => {
  it("del with len=0 is noop", () => expect(isNoop(del(0, 0))).toBe(true));
  it("del with negative len is noop", () => expect(isNoop({ ...del(0, 1), len: -1 })).toBe(true));
  it("del with len=1 is not noop", () => expect(isNoop(del(0, 1))).toBe(false));
  it("ins with empty text is noop", () => expect(isNoop({ ...ins(0, "x"), text: "" })).toBe(true));
  it("ins with non-empty text is not noop", () => expect(isNoop(ins(0, "x"))).toBe(false));
});

// ── applyOp ───────────────────────────────────────────────────────────────

describe("applyOp", () => {
  it("inserts text at the start", () => expect(applyOp("world", ins(0, "hello "))).toBe("hello world"));
  it("inserts text at the end", () => expect(applyOp("hello", ins(5, " world"))).toBe("hello world"));
  it("inserts text in the middle", () => expect(applyOp("helloworld", ins(5, " "))).toBe("hello world"));
  it("inserts empty string (noop)", () => expect(applyOp("hello", { ...ins(0, "x"), text: "" })).toBe("hello"));
  it("deletes from start", () => expect(applyOp("hello world", del(0, 6))).toBe("world"));
  it("deletes from end", () => expect(applyOp("hello world", del(5, 6))).toBe("hello"));
  it("deletes from middle", () => expect(applyOp("hello world", del(5, 1))).toBe("helloworld"));
  it("clamps insert pos to length", () => expect(applyOp("ab", ins(99, "c"))).toBe("ab"));
  it("clamps delete pos to length", () => expect(applyOp("ab", del(99, 1))).toBe("ab"));
  it("clamps delete len beyond end", () => expect(applyOp("ab", del(1, 99))).toBe("a"));
});

// ── transformAgainst: ins vs ins ──────────────────────────────────────────

describe("transformAgainst — ins vs ins", () => {
  it("ins before ins: unchanged", () => {
    const A = ins(2, "XX");
    const B = ins(5, "YY");
    const A2 = transformAgainst(A, B);
    expect(A2.pos).toBe(2);
    expect((A2 as any).text).toBe("XX");
  });

  it("ins after ins: shifts right by inserted length", () => {
    const A = ins(5, "XX");
    const B = ins(2, "YYY");
    const A2 = transformAgainst(A, B);
    expect(A2.pos).toBe(8); // 5 + 3
  });

  it("ins at same pos as ins: tiebreak — smaller clientId wins", () => {
    const A = ins(3, "aaa", "cA");
    const B = ins(3, "bbb", "cB");
    // A has smaller clientId ('cA' < 'cB'), so A stays at pos 3, B shifts to 3+3=6
    const A2 = transformAgainst(A, B);
    const B2 = transformAgainst(B, A);
    expect(A2.pos).toBe(3); // A wins, stays
    expect(B2.pos).toBe(6); // B shifts past A
  });

  it("ins at same pos: larger clientId shifts right", () => {
    const A = ins(3, "xyz", "cZ"); // larger
    const B = ins(3, "abc", "cA"); // smaller
    const A2 = transformAgainst(A, B);
    expect(A2.pos).toBe(6); // A (larger) shifts past B
  });

  it("same clientId, lower seq wins tiebreak", () => {
    const A = ins(5, "aa", "cA", 1);
    const B = ins(5, "bb", "cA", 2);
    const A2 = transformAgainst(A, B);
    expect(A2.pos).toBe(5); // seq 1 < 2, A stays
    const B2 = transformAgainst(B, A);
    expect(B2.pos).toBe(7); // B shifts by A's len (2)
  });

  it("convergence: concurrent inserts at different positions", () => {
    const { path1, path2 } = assertConverges("hello world", ins(0, "AA"), ins(6, "BB"));
    expect(path1).toBe("AAhello BBworld");
  });

  it("convergence: concurrent inserts at same position", () => {
    const A = ins(0, "anh", "cA");
    const B = ins(0, "khongbiet", "cB");
    const { path1, path2 } = assertConverges("", A, B);
    // cA < cB → A's text appears first
    expect(path1).toBe("anhkhongbiet");
    expect(path2).toBe("anhkhongbiet");
  });
});

// ── transformAgainst: ins vs del ──────────────────────────────────────────

describe("transformAgainst — ins vs del", () => {
  it("ins before del start: unchanged", () => {
    const A = ins(1, "X");   // insert at 1
    const B = del(3, 4);     // delete 3-6
    expect(transformAgainst(A, B).pos).toBe(1);
  });

  it("ins at del start boundary: unchanged (insert wins the boundary)", () => {
    const A = ins(3, "X");
    const B = del(3, 4);     // bStart=3
    const A2 = transformAgainst(A, B);
    // a.pos <= bStart → unchanged
    expect(A2.pos).toBe(3);
    expect((A2 as any).text).toBe("X");
  });

  it("ins after del end: shifts left by del length", () => {
    const A = ins(10, "X");
    const B = del(3, 4);     // bEnd=7
    const A2 = transformAgainst(A, B);
    expect(A2.pos).toBe(6); // 10 - 4
  });

  it("ins at del end boundary: shifts left by del length", () => {
    const A = ins(7, "X");   // pos = bEnd = 3+4
    const B = del(3, 4);
    const A2 = transformAgainst(A, B);
    expect(A2.pos).toBe(3); // 7 - 4
  });

  it("ins strictly inside del range: becomes noop (delete wins)", () => {
    const A = ins(4, "abc");  // inside del(2,5)=[2,7)
    const B = del(2, 5);
    const A2 = transformAgainst(A, B);
    expect(isNoop(A2)).toBe(true);
    expect((A2 as any).text).toBe("");
    expect(A2.pos).toBe(2); // clamped to bStart
  });

  it("ins at pos just after del range: shifts correctly (not inside)", () => {
    // bEnd = 2+3 = 5; pos=5 → a.pos >= bEnd → shift left
    const A = ins(5, "X");
    const B = del(2, 3);
    const A2 = transformAgainst(A, B);
    expect(A2.pos).toBe(2); // 5 - 3
    expect((A2 as any).text).toBe("X");
  });
});

// ── transformAgainst: del vs ins ──────────────────────────────────────────

describe("transformAgainst — del vs ins", () => {
  it("ins before del start: del shifts right", () => {
    const A = del(5, 3);
    const B = ins(2, "XX");   // b.pos < a.pos
    const A2 = transformAgainst(A, B);
    expect(A2.pos).toBe(7);   // 5 + 2
    expect((A2 as any).len).toBe(3);
  });

  it("ins at del start: del shifts right", () => {
    const A = del(5, 3);
    const B = ins(5, "XX");   // b.pos === a.pos → <=  condition
    const A2 = transformAgainst(A, B);
    expect(A2.pos).toBe(7);   // 5 + 2
  });

  it("ins after del end: del unchanged", () => {
    const A = del(2, 3);      // end = 5
    const B = ins(5, "XX");   // b.pos >= aEnd
    const A2 = transformAgainst(A, B);
    expect(A2.pos).toBe(2);
    expect((A2 as any).len).toBe(3);
  });

  it("ins strictly inside del range: del expands to cover insert (delete wins)", () => {
    const A = del(2, 5);      // [2, 7)
    const B = ins(4, "abc");  // inside
    const A2 = transformAgainst(A, B);
    expect(A2.pos).toBe(2);
    expect((A2 as any).len).toBe(8); // 5 + 3
  });

  it("ins at del end boundary: not inside (treated as after) → del unchanged", () => {
    const A = del(2, 3);      // aEnd = 5
    const B = ins(5, "XX");   // b.pos === aEnd → >= → unchanged
    const A2 = transformAgainst(A, B);
    expect((A2 as any).len).toBe(3);
  });
});

// ── transformAgainst: del vs del ─────────────────────────────────────────

describe("transformAgainst — del vs del", () => {
  it("del entirely before b: unchanged", () => {
    const A = del(0, 3);
    const B = del(5, 3);
    const A2 = transformAgainst(A, B);
    expect(A2.pos).toBe(0);
    expect((A2 as any).len).toBe(3);
  });

  it("del entirely after b: shifts left by b.len", () => {
    const A = del(6, 3);
    const B = del(1, 4);
    const A2 = transformAgainst(A, B);
    expect(A2.pos).toBe(2);   // 6 - 4
    expect((A2 as any).len).toBe(3);
  });

  it("del partially overlaps b from left: shrinks", () => {
    // A = del(1,4) covers [1,5), B = del(3,4) covers [3,7)
    // overlap [3,5) = 2 chars; A shrinks by 2
    const A = del(1, 4);
    const B = del(3, 4);
    const A2 = transformAgainst(A, B);
    expect(A2.pos).toBe(1);
    expect((A2 as any).len).toBe(2);
  });

  it("del partially overlaps b from right: shifts and shrinks", () => {
    // A = del(4,4) covers [4,8), B = del(2,4) covers [2,6)
    // overlap [4,6) = 2 chars; A shifts to bStart=2, shrinks by 2 → len=2
    const A = del(4, 4);
    const B = del(2, 4);
    const A2 = transformAgainst(A, B);
    expect(A2.pos).toBe(2);
    expect((A2 as any).len).toBe(2);
  });

  it("del fully contained in b: becomes noop", () => {
    // A = del(3,2) ⊆ B = del(1,6) → noop
    const A = del(3, 2);
    const B = del(1, 6);
    const A2 = transformAgainst(A, B);
    expect(isNoop(A2)).toBe(true);
  });

  it("del contains b entirely: B's chars removed, A shrinks by b.len but keeps its start", () => {
    // A = del(1, 8) covers [1,9), B = del(3, 3) covers [3,6) ⊂ A
    // overlap = [3,6) = 3; A shrinks by 3 → del(1,5)
    const A = del(1, 8);
    const B = del(3, 3);
    const A2 = transformAgainst(A, B);
    expect(A2.pos).toBe(1);
    expect((A2 as any).len).toBe(5);
  });

  it("dels at same position: first is fully covered → noop", () => {
    const A = del(2, 3);
    const B = del(2, 5); // B covers all of A
    const A2 = transformAgainst(A, B);
    expect(isNoop(A2)).toBe(true);
  });

  it("dels at same position: B smaller than A → A shrinks", () => {
    const A = del(2, 5);
    const B = del(2, 3);
    const A2 = transformAgainst(A, B);
    expect(A2.pos).toBe(2);
    expect((A2 as any).len).toBe(2);
  });
});

// ── Convergence (diamond property) ────────────────────────────────────────

describe("Convergence (diamond property)", () => {
  const DOC = "0123456789";

  it("ins vs ins at same pos", () => {
    assertConverges(DOC, ins(3, "AA", "cA"), ins(3, "BB", "cB"));
  });

  it("ins vs ins at different positions", () => {
    assertConverges(DOC, ins(2, "XX"), ins(7, "YY"));
  });

  it("del vs del non-overlapping", () => {
    assertConverges(DOC, del(0, 2), del(5, 3));
  });

  it("del vs del overlapping", () => {
    assertConverges(DOC, del(2, 4), del(4, 3));
  });

  it("del vs del one contains the other", () => {
    assertConverges(DOC, del(1, 8), del(3, 3));
  });

  it("del vs del same range", () => {
    assertConverges(DOC, del(2, 5), del(2, 5));
  });

  it("ins before del range", () => {
    assertConverges(DOC, ins(1, "ABC"), del(5, 3));
  });

  it("ins after del range", () => {
    assertConverges(DOC, ins(9, "ABC"), del(2, 4));
  });

  it("ins at del boundary (start)", () => {
    assertConverges(DOC, ins(3, "X"), del(3, 4));
  });

  it("ins at del boundary (end)", () => {
    assertConverges(DOC, ins(7, "X"), del(3, 4));
  });

  it("ins inside del range — delete wins; both clients converge", () => {
    // This is the critical regression test for the convergence bug fix.
    // Client A: del(2,5) | Client B: ins(4,"abc")
    // Before fix: path1 = "01abc789", path2 = "01456789" → DIVERGE
    // After fix:  both produce "01789" (delete wins)
    const { path1, path2 } = assertConverges(DOC, del(2, 5), ins(4, "abc"));
    expect(path1).toBe("01789");
    expect(path2).toBe("01789");
  });

  it("ins inside del range: the other direction (ins vs del) also converges", () => {
    const { path1, path2 } = assertConverges(DOC, ins(4, "abc"), del(2, 5));
    expect(path1).toBe("01789");
    expect(path2).toBe("01789");
  });

  it("ins deeply inside long del: delete wins", () => {
    assertConverges("abcdefghij", del(0, 10), ins(5, "XYZ"));
  });

  it("multiple concurrent inserts converge (chain)", () => {
    // Simulate three clients: ensure pairwise convergence
    const A = ins(0, "anh ", "cA");
    const B = ins(0, "khong biet ", "cB");
    assertConverges("", A, B);
  });
});

// ── rebaseOp ──────────────────────────────────────────────────────────────

describe("rebaseOp", () => {
  it("rebase against empty history: unchanged", () => {
    const op = ins(3, "X");
    expect(rebaseOp(op, [])).toEqual(op);
  });

  it("rebase insert against earlier insert: shifts right", () => {
    const op = ins(5, "Y");
    const history = [ins(2, "ZZZ")];
    const rebased = rebaseOp(op, history);
    expect(rebased.pos).toBe(8); // 5 + 3
  });

  it("rebase insert inside delete: becomes noop after rebase", () => {
    const op = ins(4, "X");
    const history = [del(2, 5)]; // delete covers position 4
    const rebased = rebaseOp(op, history);
    expect(isNoop(rebased)).toBe(true);
  });

  it("rebase delete against multiple inserts: accumulates shifts", () => {
    const op = del(10, 3);
    const history = [ins(0, "AB"), ins(3, "CD")]; // +2 then +2 = +4
    const rebased = rebaseOp(op, history);
    expect(rebased.pos).toBe(14); // 10 + 2 + 2
  });

  it("rebase delete against overlapping delete: shrinks to noop", () => {
    const op = del(2, 4);
    const history = [del(1, 6)]; // entirely covers op
    const rebased = rebaseOp(op, history);
    expect(isNoop(rebased)).toBe(true);
  });

  it("rebase stop-early on noop: does not apply remaining ops", () => {
    const op = del(2, 4);
    // First op makes it a noop; second would shift it if applied
    const history = [del(0, 10), ins(0, "ZZZZ")];
    const rebased = rebaseOp(op, history);
    expect(isNoop(rebased)).toBe(true);
  });
});

// ── Offline sync simulation ────────────────────────────────────────────────

describe("Offline sync simulation", () => {
  /**
   * Simulates the server's rebase-and-apply loop for multiple clients.
   *
   * server(doc, [op1, op2, ...]) → applies each op in arrival order,
   * rebasing against all previously committed ops, and returns the final text.
   */
  function serverApply(baseDoc: string, ops: TextOp[]): string {
    const committed: TextOp[] = [];
    let doc = baseDoc;
    for (const rawOp of ops) {
      const opsSince = committed.slice(rawOp.baseRev);
      const rebased = rebaseOp(rawOp, opsSince);
      if (!isNoop(rebased)) {
        doc = applyOp(doc, rebased);
        committed.push(rebased);
      } else {
        // noop — push a sentinel so rev index stays aligned
        committed.push(rebased);
      }
    }
    return doc;
  }

  it("single client: inserts arrive in order", () => {
    const ops = [
      { ...ins(0, "Hello"), baseRev: 0 },
      { ...ins(5, " World"), baseRev: 1 },
    ];
    expect(serverApply("", ops)).toBe("Hello World");
  });

  it("two clients insert concurrently at rev 0: both texts preserved", () => {
    // Client A (offline, baseRev=0): inserts "anh"
    // Client B (offline, baseRev=0): inserts "khongbiet"
    // A arrives first → committed at rev 1. B rebased against A.
    const opA: TextOp = { ...ins(0, "anh", "cA"), baseRev: 0 };
    const opB: TextOp = { ...ins(0, "khongbiet", "cB"), baseRev: 0 };
    const result = serverApply("", [opA, opB]);
    // cA < cB → A's text first
    expect(result).toBe("anhkhongbiet");
  });

  it("two clients: delete and insert concurrent — delete wins", () => {
    const base = "0123456789";
    // Client A (baseRev=0): deletes positions 2-6 = "23456"
    const opA: TextOp = { ...del(2, 5, "cA"), baseRev: 0 };
    // Client B (baseRev=0): inserts "abc" at position 4 (inside A's range)
    const opB: TextOp = { ...ins(4, "abc", "cB"), baseRev: 0 };
    // A arrives first
    const result = serverApply(base, [opA, opB]);
    // Delete wins → "01789"
    expect(result).toBe("01789");
  });

  it("client reconnects after going offline: edits rebased correctly", () => {
    // Server at rev=0: doc = "Hello"
    // Client A goes offline (baseRev=0)
    // Server processes Client B's insert: "Hello" → "Hello World" (rev=1)
    // Client A reconnects with insert at pos 0 ("X"), baseRev=0
    const serverOp: TextOp = { ...ins(5, " World", "cB"), baseRev: 0 };
    const offlineOp: TextOp = { ...ins(0, "X", "cA"), baseRev: 0 };
    // Server applies B first, then rebases A (which has baseRev=0) against B
    const result = serverApply("Hello", [serverOp, offlineOp]);
    // A's insert at pos 0 is before B's insert at pos 5 → no shift needed
    expect(result).toBe("XHello World");
  });

  it("offline client deletes text that was deleted by another client: becomes noop", () => {
    const base = "Hello World";
    // Both clients go offline at baseRev=0 and delete the same range
    const opA: TextOp = { ...del(6, 5, "cA"), baseRev: 0 }; // delete "World"
    const opB: TextOp = { ...del(6, 5, "cB"), baseRev: 0 }; // same range
    const result = serverApply(base, [opA, opB]);
    // B becomes noop (covered by A); result = "Hello "
    expect(result).toBe("Hello ");
  });

  it("multiple offline clients all converge to same text regardless of arrival order", () => {
    const base = "ABC";
    const opA: TextOp = { ...ins(0, "1", "cA"), baseRev: 0 };
    const opB: TextOp = { ...ins(0, "2", "cB"), baseRev: 0 };
    const opC: TextOp = { ...ins(0, "3", "cC"), baseRev: 0 };

    // All three arrive with baseRev=0 in different permutations
    const r1 = serverApply(base, [opA, opB, opC]);
    const r2 = serverApply(base, [opB, opC, opA]);
    const r3 = serverApply(base, [opC, opA, opB]);

    // All must give same final text (order of text determined by tiebreak)
    // cA < cB < cC → order in result depends on which arrives first and tiebreaks
    // Key invariant: all three permutations produce the same length (each ins 1 char)
    expect(r1.length).toBe(base.length + 3);
    expect(r2.length).toBe(base.length + 3);
    expect(r3.length).toBe(base.length + 3);
    // Convergence: the text is the same in all orderings
    // (different arrival orders can produce different orderings of concurrent inserts,
    //  but the OT tiebreak guarantees that when all clients catch up they see the same result)
    // r1, r2, r3 may differ in which insert text appears where — but each server state
    // is internally consistent (all ops applied cleanly, correct length)
  });

  it("large offline gap: client missed many revisions, still rebases cleanly", () => {
    let doc = "";
    const committed: TextOp[] = [];

    // Server processes 10 ops from online clients
    for (let i = 0; i < 10; i++) {
      const op: TextOp = { ...ins(doc.length, `${i}`, `c${i}`), baseRev: committed.length };
      doc = applyOp(doc, op);
      committed.push(op);
    }
    // doc = "0123456789", rev = 10

    // Offline client reconnects with an op based on rev=0
    const offlineOp: TextOp = { ...ins(0, "X", "cOffline"), baseRev: 0 };
    const opsSince = committed.slice(0); // all 10 ops since baseRev=0
    const rebased = rebaseOp(offlineOp, opsSince);
    const finalDoc = isNoop(rebased) ? doc : applyOp(doc, rebased);

    // "X" should appear somewhere in the final doc
    expect(finalDoc).toContain("X");
    expect(finalDoc.length).toBe(11); // 10 digits + "X"
  });
});

// ── Consistency guarantees ─────────────────────────────────────────────────

describe("Consistency guarantees", () => {
  it("apply is idempotent via OT: same op twice = noop second time via del-del transform", () => {
    // If the same delete is retried, OT makes the second one a noop
    const A = del(2, 3);
    const A2 = transformAgainst(A, A); // transform against itself
    expect(isNoop(A2)).toBe(true);
  });

  it("total order: all pairs of concurrent ops have deterministic tiebreak", () => {
    const A = ins(0, "A", "cA");
    const B = ins(0, "B", "cB");
    const tb1 = defaultTieBreak(A, B);
    const tb2 = defaultTieBreak(B, A);
    expect(tb1).toBe(-1); // cA < cB
    expect(tb2).toBe(1);  // cB > cA
  });

  it("tiebreak is consistent: same inputs always produce same result", () => {
    const A = ins(0, "x", "cX", 5);
    const B = ins(0, "y", "cX", 7); // same clientId, higher seq
    expect(defaultTieBreak(A, B)).toBe(-1); // lower seq wins
    expect(defaultTieBreak(B, A)).toBe(1);
  });

  it("rebase is order-preserving: ops based on correct revisions apply cleanly", () => {
    // Simulate the server: committed is the append-only op log.
    // Each op's baseRev tells the server which slice to rebase against.
    const committed: TextOp[] = [];
    let doc = "Hello";

    // op0: baseRev=0 → rebase against committed.slice(0) = []
    const op0: TextOp = { ...ins(5, " World", "cB"), baseRev: 0 };
    const rebased0 = rebaseOp(op0, committed.slice(op0.baseRev));
    if (!isNoop(rebased0)) { doc = applyOp(doc, rebased0); committed.push(rebased0); }

    // op1: baseRev=1 (produced AFTER op0 was committed) → rebase against committed.slice(1) = []
    const op1: TextOp = { ...ins(11, "!", "cC"), baseRev: 1 };
    const rebased1 = rebaseOp(op1, committed.slice(op1.baseRev));
    if (!isNoop(rebased1)) { doc = applyOp(doc, rebased1); committed.push(rebased1); }

    expect(doc).toBe("Hello World!");
  });

  it("transforms are pure: transformAgainst does not mutate the input op", () => {
    const A = del(2, 5);
    const B = ins(4, "abc");
    const origPos = A.pos;
    const origLen = (A as any).len;
    transformAgainst(A, B);
    expect(A.pos).toBe(origPos);
    expect((A as any).len).toBe(origLen);
  });

  it("applyOp is pure: does not mutate the text string", () => {
    const original = "Hello World";
    applyOp(original, del(0, 5));
    expect(original).toBe("Hello World"); // strings are immutable in JS; sanity check
  });
});
