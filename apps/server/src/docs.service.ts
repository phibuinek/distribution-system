import { Injectable } from "@nestjs/common";
import type { DocId, Revision, TextOp } from "@ds/shared";
import { applyOp, isNoop, rebaseOp } from "@ds/shared";
import { loadDoc, saveDoc } from "./persistence";

type DocState = {
  id: DocId;
  rev: Revision;
  text: string;
  // append-only operation log; index = rev-1
  ops: TextOp[];
  // basic dedupe: opId -> newRev
  applied: Map<string, Revision>;
};

@Injectable()
export class DocsService {
  private docs = new Map<DocId, DocState>();

  getOrCreate(docId: DocId): DocState {
    const existing = this.docs.get(docId);
    if (existing) return existing;
    const persisted = loadDoc(docId);
    const created: DocState = persisted
      ? {
          id: docId,
          rev: persisted.rev,
          text: persisted.text,
          ops: persisted.ops ?? [],
          // rebuild dedupe index from persisted op log: op index i => rev i+1
          applied: new Map((persisted.ops ?? []).map((op, i) => [op.id, i + 1] as const)),
        }
      : {
          id: docId,
          rev: 0,
          text: "",
          ops: [],
          applied: new Map(),
        };
    this.docs.set(docId, created);
    return created;
  }

  getSnapshot(docId: DocId) {
    const doc = this.getOrCreate(docId);
    return { docId: doc.id, rev: doc.rev, text: doc.text };
  }

  getOpsSince(docId: DocId, rev: Revision): TextOp[] {
    const doc = this.getOrCreate(docId);
    if (rev < 0) rev = 0;
    if (rev >= doc.rev) return [];
    return doc.ops.slice(rev); // ops indexed by [0..rev-1]
  }

  applyClientOp(rawOp: TextOp): { newRev: Revision; rebasedOp?: TextOp; deduped?: boolean } {
    const doc = this.getOrCreate(rawOp.docId);

    const prior = doc.applied.get(rawOp.id);
    if (prior !== undefined) {
      return { newRev: prior, deduped: true };
    }

    if (rawOp.baseRev > doc.rev) {
      // client thinks it's ahead; reject
      throw new Error(`baseRev ${rawOp.baseRev} > serverRev ${doc.rev}`);
    }

    const opsSince = doc.ops.slice(rawOp.baseRev);
    const rebased = rebaseOp(rawOp, opsSince);
    if (isNoop(rebased)) {
      // treat as applied, but no doc change
      doc.applied.set(rawOp.id, doc.rev);
      return { newRev: doc.rev, rebasedOp: rebased };
    }

    // Clamp against current server text to avoid hard-rejecting after client-side buffering.
    // This keeps the system convergent and prevents "stuck" offline queues.
    let safe = rebased;
    if (safe.kind === "ins") {
      const pos = Math.max(0, Math.min(safe.pos, doc.text.length));
      safe = pos === safe.pos ? safe : { ...safe, pos };
    } else {
      const pos = Math.max(0, Math.min(safe.pos, doc.text.length));
      const maxLen = Math.max(0, doc.text.length - pos);
      const len = Math.max(0, Math.min(safe.len, maxLen));
      safe = pos === safe.pos && len === safe.len ? safe : ({ ...safe, pos, len } as TextOp);
      if (isNoop(safe)) {
        doc.applied.set(rawOp.id, doc.rev);
        return { newRev: doc.rev, rebasedOp: safe };
      }
    }

    const nextText = applyOp(doc.text, safe);
    doc.text = nextText;
    doc.ops.push(safe);
    doc.rev += 1;
    doc.applied.set(rawOp.id, doc.rev);
    saveDoc({ docId: doc.id, rev: doc.rev, text: doc.text, ops: doc.ops });
    return { newRev: doc.rev, rebasedOp: safe };
  }
}

