"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { io, type Socket } from "socket.io-client";
import type { ServerAck, ServerError, ServerSnapshot, TextOp } from "@ds/shared";
import { applyOp, isNoop, transformAgainst } from "@ds/shared";

function now() {
  return Date.now();
}

function getTabId(): string {
  const tabKey = "ds.tabId";
  const rand = () => Math.random().toString(16).slice(2);
  const make = () => `t_${rand()}_${now().toString(16)}`;
  if (typeof window === "undefined") return make();
  try {
    const existing = window.sessionStorage.getItem(tabKey);
    if (existing) return existing;
    const created = make();
    window.sessionStorage.setItem(tabKey, created);
    return created;
  } catch {
    return make();
  }
}

function getActorId(): string {
  const userKey = "ds.userId";
  const tabKey = "ds.tabId";

  const rand = () => Math.random().toString(16).slice(2);
  const make = (prefix: string) => `${prefix}_${rand()}_${now().toString(16)}`;

  if (typeof window === "undefined") return make("actor");

  let userId = make("u");
  let tabId = make("t");

  try {
    userId = window.localStorage.getItem(userKey) ?? userId;
    window.localStorage.setItem(userKey, userId);
  } catch {
    // ignore
  }

  // sessionStorage is per-tab, survives refresh, and won't collide across tabs
  try {
    tabId = window.sessionStorage.getItem(tabKey) ?? tabId;
    window.sessionStorage.setItem(tabKey, tabId);
  } catch {
    // ignore
  }

  return `${userId}.${tabId}`;
}

function seqKey(docId: string, clientId: string) {
  return `ds.seq.${docId}.${clientId}`;
}

function nextSeq(docId: string, clientId: string): number {
  if (typeof window === "undefined") return 1;
  try {
    const key = seqKey(docId, clientId);
    const cur = Number(window.sessionStorage.getItem(key) ?? "0");
    const next = Number.isFinite(cur) ? cur + 1 : 1;
    window.sessionStorage.setItem(key, String(next));
    return next;
  } catch {
    return Math.floor(Math.random() * 1_000_000_000);
  }
}

type PendingOp = TextOp & { _pending: true };

function storageKey(docId: string) {
  // per-tab queue to avoid multi-tab duplication while offline
  return `ds.doc.${docId}.${getTabId()}.pendingOps`;
}

function baseKey(docId: string) {
  return `ds.doc.${docId}.base`;
}

function loadPending(docId: string): PendingOp[] {
  try {
    const raw = window.localStorage.getItem(storageKey(docId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as PendingOp[];
  } catch {
    return [];
  }
}

function savePending(docId: string, ops: PendingOp[]) {
  window.localStorage.setItem(storageKey(docId), JSON.stringify(ops));
}

function splitPending(list: PendingOp[]): { outstanding: PendingOp | null; buffer: PendingOp[] } {
  if (!list.length) return { outstanding: null, buffer: [] };
  const [first, ...rest] = list;
  return { outstanding: first, buffer: rest };
}

function joinPending(outstanding: PendingOp | null, buffer: PendingOp[]): PendingOp[] {
  return outstanding ? [outstanding, ...buffer] : [...buffer];
}

function loadBase(docId: string): { rev: number; text: string } | null {
  try {
    const raw = window.localStorage.getItem(baseKey(docId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.rev !== "number" || typeof parsed.text !== "string") return null;
    return parsed as { rev: number; text: string };
  } catch {
    return null;
  }
}

function saveBase(docId: string, rev: number, text: string) {
  try {
    window.localStorage.setItem(baseKey(docId), JSON.stringify({ rev, text }));
  } catch {
    // ignore
  }
}

function applyPending(baseText: string, pending: PendingOp[]) {
  let t = baseText;
  for (const op of pending) {
    if (!isNoop(op)) t = applyOp(t, op);
  }
  return t;
}

function maxBaseRev(pending: PendingOp[]): number {
  let m = 0;
  for (const p of pending) m = Math.max(m, p.baseRev);
  return m;
}

// Minimal diff: common prefix/suffix then produce del + ins at the change site.
function diffToOps(prev: string, next: string, base: Omit<TextOp, "kind" | "pos" | "text" | "len">): TextOp[] {
  if (prev === next) return [];

  let start = 0;
  while (start < prev.length && start < next.length && prev[start] === next[start]) start++;

  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && prev[endPrev - 1] === next[endNext - 1]) {
    endPrev--;
    endNext--;
  }

  const deletedLen = endPrev - start;
  const insertedText = next.slice(start, endNext);

  const ops: TextOp[] = [];
  if (deletedLen > 0) {
    ops.push({
      ...base,
      kind: "del",
      pos: start,
      len: deletedLen,
    });
  }
  if (insertedText.length > 0) {
    ops.push({
      ...base,
      kind: "ins",
      pos: start,
      text: insertedText,
    });
  }
  return ops;
}

export default function DocPage() {
  const params = useParams<{ docId: string }>();
  const docId = params.docId;
  const clientId = useMemo(() => getActorId(), []);

  const [connected, setConnected] = useState(false);
  const [rev, setRev] = useState(0);
  const [text, setText] = useState("");
  const [status, setStatus] = useState<string>("connecting…");
  const [pendingCount, setPendingCount] = useState(0);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const serverTextRef = useRef("");
  const prevTextRef = useRef("");
  const forceRebuildRef = useRef(false);
  const revRef = useRef(0);
  const outstandingRef = useRef<PendingOp | null>(null);
  const bufferRef = useRef<PendingOp[]>([]);

  // IME / Vietnamese composition handling:
  // - During composition we only update UI text.
  // - On composition end we commit the whole change as OT ops.
  const composingRef = useRef(false);
  const composeBaseTextRef = useRef("");
  const composeBaseRevRef = useRef(0);

  useEffect(() => {
    const loaded = loadPending(docId);
    const split = splitPending(loaded);
    outstandingRef.current = split.outstanding;
    bufferRef.current = split.buffer;
    setPendingCount((split.outstanding ? 1 : 0) + split.buffer.length);

    const base = loadBase(docId);
    if (base) {
      serverTextRef.current = base.text;
      setRev(base.rev);
      revRef.current = base.rev;
      const view = applyPending(base.text, joinPending(outstandingRef.current, bufferRef.current));
      setText(view);
      prevTextRef.current = view;
      return;
    }
  }, [docId]);

  useEffect(() => {
    const socket = io("http://localhost:4000", {
      transports: ["websocket"],
      reconnection: true,
      reconnectionDelayMax: 2000,
    });
    socketRef.current = socket;

    const onConnect = () => {
      setConnected(true);
      setStatus("connected");
      // join already returns snapshot and (if needed) ops since knownRev.
      // Sending an additional sync request duplicates ops and can cause repeated characters.
      socket.emit("join", { docId, knownRev: revRef.current });
      flushOutstanding(socket);
    };

    const onDisconnect = () => {
      setConnected(false);
      setStatus("offline (will sync when reconnected)");
    };

    const onSnapshot = (snap: ServerSnapshot) => {
      if (snap.docId !== docId) return;
      serverTextRef.current = snap.text;
      saveBase(docId, snap.rev, snap.text);

      const desired = prevTextRef.current;
      const pendingNow = joinPending(outstandingRef.current, bufferRef.current);

      // If server restarted (rev went backwards) or our queued ops refer to a future baseRev,
      // rebuild pending ops from server snapshot -> desired text.
      const needsRebuild =
        forceRebuildRef.current || snap.rev < revRef.current || maxBaseRev(pendingNow) > snap.rev;
      if (needsRebuild) {
        forceRebuildRef.current = false;
        const base = {
          id: "",
          clientId,
          seq: 0,
          docId,
          baseRev: snap.rev,
          ts: now(),
        } as const;

        const rebuilt = diffToOps(snap.text, desired, base as any).map((op) => {
          const seq = nextSeq(docId, clientId);
          const id = `${clientId}:${seq}`;
          return { ...op, id, seq, clientId, docId, baseRev: snap.rev, ts: now(), _pending: true } as PendingOp;
        });

        const split = splitPending(rebuilt);
        outstandingRef.current = split.outstanding;
        bufferRef.current = split.buffer;
        savePending(docId, rebuilt);
        setPendingCount((split.outstanding ? 1 : 0) + split.buffer.length);
      }

      setRev(snap.rev);
      revRef.current = snap.rev;
      const view = applyPending(serverTextRef.current, joinPending(outstandingRef.current, bufferRef.current));
      setText(view);
      prevTextRef.current = view;
    };

    const onOps = (payload: { docId: string; fromRev: number; toRev: number; ops: TextOp[] }) => {
      if (payload.docId !== docId) return;
      // Deduplicate in case we receive overlapping ops (reconnect races).
      const curRev = revRef.current;
      if (payload.toRev <= curRev) return;
      const skip = Math.max(0, curRev - payload.fromRev);
      const ops = skip > 0 ? payload.ops.slice(skip) : payload.ops;
      // apply server ops to the server base text, then re-render view = base + local pending
      let baseText = serverTextRef.current;
      for (const op of ops) baseText = applyOp(baseText, op);
      serverTextRef.current = baseText;
      saveBase(docId, payload.toRev, baseText);

      const view = applyPending(baseText, joinPending(outstandingRef.current, bufferRef.current));
      setText(view);
      prevTextRef.current = view;
      setRev(payload.toRev);
      revRef.current = payload.toRev;
    };

    const onRemoteOp = (payload: { op: TextOp; newRev: number }) => {
      if (payload.op.docId !== docId) return;
      // Client-side OT (Google-Docs-like):
      // We keep 2 queues:
      // - outstanding: sent, waiting for ack
      // - buffer: local ops typed while outstanding exists
      // Transform the incoming remote op through our local queues so it applies to our current view,
      // and update queues so future sends preserve intention.
      let remote = payload.op;
      const out = outstandingRef.current;
      if (out) {
        const remote2 = transformAgainst(remote, out);
        const out2 = transformAgainst(out, remote);
        remote = remote2;
        outstandingRef.current = isNoop(out2) ? null : ({ ...(out2 as any), _pending: true } as PendingOp);
      }

      const nextBuf: PendingOp[] = [];
      for (const b of bufferRef.current) {
        const remote2 = transformAgainst(remote, b);
        const b2 = transformAgainst(b, remote);
        remote = remote2;
        if (!isNoop(b2)) nextBuf.push({ ...(b2 as any), _pending: true });
      }
      bufferRef.current = nextBuf;

      const persist = joinPending(outstandingRef.current, bufferRef.current);
      savePending(docId, persist);
      setPendingCount((outstandingRef.current ? 1 : 0) + bufferRef.current.length);

      // update server base with the server-authored op (not the transformed one)
      serverTextRef.current = applyOp(serverTextRef.current, payload.op);
      saveBase(docId, payload.newRev, serverTextRef.current);

      // re-render view from base + transformed local pending
      const view = applyPending(serverTextRef.current, joinPending(outstandingRef.current, bufferRef.current));
      setText(view);
      prevTextRef.current = view;
      setRev(payload.newRev);
      revRef.current = payload.newRev;
    };

    const onAck = (ack: ServerAck) => {
      // Ack only applies to the outstanding op (we send one-at-a-time)
      if (outstandingRef.current?.id === ack.opId) {
        // Move the server-accepted op from optimistic queue into the server base.
        // (Sender does not receive remoteOp for its own change, so base must be advanced on ack.)
        if (ack.acceptedOp) {
          serverTextRef.current = applyOp(serverTextRef.current, ack.acceptedOp);
          saveBase(docId, ack.newRev, serverTextRef.current);
        }

        outstandingRef.current = null;
        if (bufferRef.current.length > 0) {
          outstandingRef.current = bufferRef.current.shift() ?? null;
          const socket = socketRef.current;
          if (socket && socket.connected && outstandingRef.current) socket.emit("op", outstandingRef.current);
        }
        const persist = joinPending(outstandingRef.current, bufferRef.current);
        savePending(docId, persist);
        setPendingCount((outstandingRef.current ? 1 : 0) + bufferRef.current.length);
      }
      const nextRev = Math.max(revRef.current, ack.newRev);
      setRev(nextRev);
      revRef.current = nextRev;

      // Re-render from base + pending to avoid "disappearing" local edits.
      const view = applyPending(serverTextRef.current, joinPending(outstandingRef.current, bufferRef.current));
      setText(view);
      prevTextRef.current = view;
    };

    const onErr = (err: ServerError) => {
      setStatus(`error: ${err.message} (resyncing…)`);
      // If the server rejects an op, force a snapshot-driven rebuild of the queue.
      // This avoids getting stuck with an invalid outstanding/buffer state.
      forceRebuildRef.current = true;
      socket.emit("join", { docId, knownRev: 0 });
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("snapshot", onSnapshot);
    socket.on("ops", onOps);
    socket.on("remoteOp", onRemoteOp);
    socket.on("ack", onAck);
    socket.on("err", onErr);

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("snapshot", onSnapshot);
      socket.off("ops", onOps);
      socket.off("remoteOp", onRemoteOp);
      socket.off("ack", onAck);
      socket.off("err", onErr);
      socket.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  function enqueueOps(ops: TextOp[]) {
    for (const raw of ops) {
      const op = { ...(raw as any), _pending: true } as PendingOp;
      if (!outstandingRef.current) {
        outstandingRef.current = op;
      } else {
        bufferRef.current.push(op);
      }
    }
    const persist = joinPending(outstandingRef.current, bufferRef.current);
    savePending(docId, persist);
    setPendingCount((outstandingRef.current ? 1 : 0) + bufferRef.current.length);

    const socket = socketRef.current;
    if (socket && socket.connected) flushOutstanding(socket);
  }

  function flushOutstanding(socket: Socket) {
    if (outstandingRef.current) socket.emit("op", outstandingRef.current);
  }

  function commitDiff(prev: string, next: string, baseRev: number) {
    if (prev === next) {
      setText(next);
      prevTextRef.current = next;
      return;
    }
    setText(next);
    prevTextRef.current = next;

    const base = {
      id: "",
      clientId,
      seq: 0,
      docId,
      baseRev,
      ts: now(),
    } as const;

    const ops = diffToOps(prev, next, base as any).map((op) => {
      const seq = nextSeq(docId, clientId);
      const id = `${clientId}:${seq}`;
      return { ...op, id, seq, clientId, docId, baseRev, ts: now() } as TextOp;
    });
    if (ops.length > 0) enqueueOps(ops);

    const socket = socketRef.current;
    if (!socket || !socket.connected) setStatus("offline (queued changes)");
  }

  function applyLocalOpsAndEnqueue(ops: TextOp[]) {
    let next = prevTextRef.current;
    for (const op of ops) next = applyOp(next, op);
    setText(next);
    prevTextRef.current = next;
    enqueueOps(ops);

    const socket = socketRef.current;
    if (!socket || !socket.connected) setStatus("offline (queued changes)");
  }

  function makeIns(pos: number, insertText: string): TextOp {
    const baseRev = revRef.current;
    const seq = nextSeq(docId, clientId);
    const id = `${clientId}:${seq}`;
    const ts = now();
    return { id, clientId, seq, docId, baseRev, kind: "ins", pos, text: insertText, ts };
  }

  function makeDel(pos: number, len: number): TextOp {
    const baseRev = revRef.current;
    const seq = nextSeq(docId, clientId);
    const id = `${clientId}:${seq}`;
    const ts = now();
    return { id, clientId, seq, docId, baseRev, kind: "del", pos, len, ts };
  }

  function handleBeforeInput(e: React.FormEvent<HTMLTextAreaElement>) {
    if (composingRef.current) return; // let composition drive UI; we'll commit at compositionend

    const ne = (e as any).nativeEvent as InputEvent | undefined;
    const inputType = ne?.inputType;
    // If we can't detect type, fall back to diff on onChange.
    if (!inputType) return;

    const el = textareaRef.current;
    if (!el) return;

    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? start;
    const hasSel = end > start;

    const mkDelSel = () =>
      hasSel
        ? ([
            makeDel(start, end - start),
          ] as TextOp[])
        : ([] as TextOp[]);

    // Insert-like operations
    if (inputType.startsWith("insert")) {
      const data = (ne as any).data as string | null | undefined;
      const insertText =
        inputType === "insertLineBreak" ? "\n" : typeof data === "string" ? data : "";

      // Some browsers/IME paths provide no `data` for insertText; let onChange handle it.
      if (inputType !== "insertLineBreak" && insertText.length === 0) return;

      // We fully control the textarea value; prevent the browser from applying its own mutation.
      e.preventDefault();

      const ops: TextOp[] = [];
      ops.push(...mkDelSel());
      if (insertText.length > 0) {
        ops.push(makeIns(start, insertText));
      }
      if (ops.length > 0) applyLocalOpsAndEnqueue(ops);
      return;
    }

    // Delete-like operations
    if (inputType.startsWith("delete")) {
      // We fully control the textarea value; prevent the browser from applying its own mutation.
      e.preventDefault();

      if (hasSel) {
        const ops = mkDelSel();
        if (ops.length > 0) applyLocalOpsAndEnqueue(ops);
        return;
      }

      if (inputType === "deleteContentBackward") {
        if (start <= 0) return;
        applyLocalOpsAndEnqueue([
          makeDel(start - 1, 1),
        ]);
        return;
      }

      if (inputType === "deleteContentForward") {
        if (start >= prevTextRef.current.length) return;
        applyLocalOpsAndEnqueue([
          makeDel(start, 1),
        ]);
        return;
      }

      // fallback: delete selection or ignore
      const ops = mkDelSel();
      if (ops.length > 0) applyLocalOpsAndEnqueue(ops);
      return;
    }
  }

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <h2 style={{ margin: 0 }}>Doc: {docId}</h2>
          <div className="muted">Open this same URL in 2 tabs to test concurrent edits.</div>
        </div>
        <div className="row">
          <span className="pill">
            <strong>status</strong> {connected ? "online" : "offline"}
          </span>
          <span className="pill">
            <strong>rev</strong> {rev}
          </span>
          <span className="pill">
            <strong>pending</strong> {pendingCount}
          </span>
        </div>
      </div>

      <div style={{ height: 12 }} />
      <textarea
        ref={textareaRef}
        value={text}
        onBeforeInput={handleBeforeInput}
        onCompositionStart={() => {
          composingRef.current = true;
          composeBaseTextRef.current = prevTextRef.current;
          composeBaseRevRef.current = revRef.current;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
          // Commit everything typed during composition as a single diff.
          commitDiff(composeBaseTextRef.current, prevTextRef.current, composeBaseRevRef.current);
        }}
        onChange={(e) => {
          // During IME composition, allow the browser to update value; we only commit on compositionend.
          if (composingRef.current) {
            setText(e.target.value);
            prevTextRef.current = e.target.value;
            return;
          }
          // Fallback path when beforeinput doesn't provide enough info (common offline / some browsers).
          commitDiff(prevTextRef.current, e.target.value, revRef.current);
        }}
        spellCheck={false}
      />
      <div style={{ height: 10 }} />
      <div className="row">
        <span className="muted">{status}</span>
        <button
          onClick={() => {
            const socket = socketRef.current;
            if (socket && socket.connected) flushOutstanding(socket);
          }}
        >
          Force sync
        </button>
      </div>
    </div>
  );
}

