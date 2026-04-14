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
  // Put timestamp first so lexicographic order matches creation order.
  // This makes concurrent insert tie-breaks more intuitive in demos:
  // the tab opened first tends to sort before the tab opened later.
  const make = () => `t_${now().toString(16)}_${rand()}`;
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

// ── Op feed item type ────────────────────────────────────────
type OpFeedItem = {
  key: string;
  direction: "in" | "out";
  kind: "ins" | "del";
  preview: string;
  pos: number;
  clientShort: string;
  dotColor: string;
};

// ── Reusable color-swatch picker popover ────────────────────
function ColorPicker({
  colors, onPick, onClose, labels = {},
}: {
  colors: string[];
  onPick: (c: string) => void;
  onClose: () => void;
  labels?: Record<string, string>;
}) {
  return (
    <>
      {/* overlay to close on outside click */}
      <div style={{ position: "fixed", inset: 0, zIndex: 400 }} onClick={onClose} />
      <div style={{
        position: "absolute", top: "100%", left: 0, zIndex: 401, marginTop: 4,
        background: "white", border: "1px solid #e0e0e0", borderRadius: 6,
        padding: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.14)",
        display: "flex", flexWrap: "wrap", gap: 4, width: 164,
      }}>
        {colors.map((c) => (
          <button
            key={c}
            title={labels[c] ?? c}
            onClick={() => onPick(c)}
            style={{
              width: 22, height: 22, borderRadius: 3, border: "1px solid #dadce0",
              background: c === "transparent" ? "linear-gradient(135deg,#fff 45%,#f00 45%,#f00 55%,#fff 55%)" : c,
              cursor: "pointer", padding: 0, flexShrink: 0,
            }}
          />
        ))}
      </div>
    </>
  );
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
  // Conflict / merge log — shows the last few OT transformations for observability.
  const [mergeLog, setMergeLog] = useState<string[]>([]);
  const [showMergeToast, setShowMergeToast] = useState(false);
  const [docTitle, setDocTitle] = useState(() =>
    docId.charAt(0).toUpperCase() + docId.slice(1).replace(/-/g, " ")
  );

  // ── Editor formatting state ──────────────────────────────
  const [editorFont, setEditorFont]           = useState("Arial, sans-serif");
  const [editorFontSize, setEditorFontSize]   = useState(11);
  const [editorAlign, setEditorAlign]         = useState<React.CSSProperties["textAlign"]>("left");
  const [editorLineHeight, setEditorLineHeight] = useState(1.6);
  const [zoom, setZoom]                       = useState(100);
  const [isBold, setIsBold]                   = useState(false);
  const [isItalic, setIsItalic]               = useState(false);
  const [isUnderline, setIsUnderline]         = useState(false);
  const [isStrike, setIsStrike]               = useState(false);
  const [textColor, setTextColor]             = useState("#202124");
  const [hlColor, setHlColor]                 = useState("transparent");
  const [paraStyle, setParaStyle]             = useState("normal");
  const [colorPickerFor, setColorPickerFor]   = useState<"text" | "hl" | null>(null);
  const [linkOpen, setLinkOpen]               = useState(false);
  const [linkUrl, setLinkUrl]                 = useState("");

  // ── Phá cách features ───────────────────────────────────
  const THEMES = ["light", "neon", "sepia"] as const;
  type Theme = typeof THEMES[number];
  const [theme, setTheme] = useState<Theme>("light");
  const [syncFlash, setSyncFlash] = useState(false);
  const [opFeed, setOpFeed] = useState<OpFeedItem[]>([]);
  const [wpm, setWpm] = useState(0);
  const keystrokesRef = useRef<number[]>([]);
  const syncFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const serverTextRef = useRef("");
  const prevTextRef = useRef("");
  const forceRebuildRef = useRef(false);
  const revRef = useRef(0);
  const outstandingRef = useRef<PendingOp | null>(null);
  const bufferRef = useRef<PendingOp[]>([]);

  // ── Undo / Redo stacks ───────────────────────────────────
  const undoStackRef       = useRef<string[]>([]);
  const redoStackRef       = useRef<string[]>([]);
  const suppressHistoryRef = useRef(false);

  // IME / Vietnamese composition handling:
  // - During composition we only update UI text.
  // - On composition end we commit the whole change as OT ops.
  const composingRef = useRef(false);
  const composeBaseTextRef = useRef("");
  const composeBaseRevRef = useRef(0);
  const skipNextChangeRef = useRef(false);
  const offlineDirtyRef = useRef(false);

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
      // Send join; the server replies with a snapshot (and any ops we missed).
      // We intentionally do NOT flush outstanding here — we wait until onSnapshot
      // has run so we can rebase any stale or offline ops before sending them.
      socket.emit("join", { docId, knownRev: revRef.current });
    };

    const onDisconnect = () => {
      setConnected(false);
      setStatus("offline (will sync when reconnected)");
    };

    const onSnapshot = (snap: ServerSnapshot) => {
      if (snap.docId !== docId) return;

      // ── Step 1: capture the client's last-known server state BEFORE overwriting it ──
      //
      // offlineBaseText / offlineBaseRev describe the document revision from which
      // all local pending ops (and any offline-typed text) were produced.
      //
      // CRITICAL: we use offlineBaseRev as the baseRev when rebuilding ops, NOT
      // snap.rev.  This lets the server run the standard OT rebase:
      //   rebaseOp(ourOp, serverOps.slice(offlineBaseRev))
      // so concurrent remote edits (e.g. another tab's offline text) are merged
      // correctly via transformAgainst() rather than one overwriting the other.
      //
      // Bug that this fixes: if Tab A typed "anh" and Tab B typed "khong biet"
      // while both were offline (base rev=0), and Tab A reconnected first:
      //   Old code: Tab B sends diff(snap.text="anh" → "khong biet") with baseRev=1
      //             → server applies del(0,3)+ins(0,"khong biet"), erasing "anh".
      //   New code: Tab B sends diff(offlineBase="" → "khong biet") with baseRev=0
      //             → server rebases ins(0,"khong biet") against ins(0,"anh") via
      //               transformAgainst (tiebreak shifts B to pos 3)
      //             → final text: "anhkhong biet"  (both preserved ✓)
      const offlineBaseText = serverTextRef.current;
      const offlineBaseRev  = revRef.current;

      serverTextRef.current = snap.text;
      saveBase(docId, snap.rev, snap.text);

      const desired    = prevTextRef.current; // full local text the user wants to keep
      const pendingNow = joinPending(outstandingRef.current, bufferRef.current);

      // ── Step 2: decide whether to rebuild the pending-op queue ──
      //
      // Conditions that require a rebuild:
      //   (a) forceRebuildRef  — server rejected an op; queue may be corrupt
      //   (b) offlineDirtyRef  — user typed while offline; those edits live only
      //                          in prevTextRef, not in the pending queue yet
      //   (c) server rev went backwards — server restarted; old baseRevs invalid
      //   (d) a queued op has a baseRev the server hasn't reached — shouldn't
      //                          happen normally, but guard anyway
      const wasOfflineDirty = offlineDirtyRef.current;
      const needsRebuild =
        forceRebuildRef.current ||
        offlineDirtyRef.current ||
        snap.rev < revRef.current ||
        maxBaseRev(pendingNow) > snap.rev;

      if (needsRebuild) {
        forceRebuildRef.current = false;
        offlineDirtyRef.current = false; // handled below via offlineBaseRev

        // When the rebuild was triggered by offline typing, append a trailing space
        // so that when multiple clients reconnect concurrently, OT places their texts
        // side-by-side with a natural gap instead of gluing them together.
        // e.g. Tab A typed "anh", Tab B typed "khong biet"
        //   without space → "anhkhong biet"
        //   with space    → "anh khong biet"  ✓
        const effectiveDesired = (wasOfflineDirty && desired.trim() !== "")
          ? desired.trimEnd() + " "
          : desired;

        // Produce ops from OLD base → desired so the server can OT-rebase them.
        const rebuilt = diffToOps(offlineBaseText, effectiveDesired, {
          id: "", clientId, seq: 0, docId, baseRev: offlineBaseRev, ts: now(),
        } as any).map((op) => {
          const seq = nextSeq(docId, clientId);
          const id  = `${clientId}:${seq}`;
          return { ...op, id, seq, clientId, docId, baseRev: offlineBaseRev, ts: now(), _pending: true } as PendingOp;
        });

        const split = splitPending(rebuilt);
        outstandingRef.current = split.outstanding;
        bufferRef.current      = split.buffer;
        savePending(docId, rebuilt);
        setPendingCount((split.outstanding ? 1 : 0) + split.buffer.length);

        if (offlineBaseRev < snap.rev) {
          setMergeLog(prev =>
            [`offline merge: rebased local edits against rev ${offlineBaseRev}→${snap.rev} via OT`, ...prev].slice(0, 8)
          );
        }
      }

      setRev(snap.rev);
      revRef.current = snap.rev;
      const view = applyPending(serverTextRef.current, joinPending(outstandingRef.current, bufferRef.current));
      setText(view);
      prevTextRef.current = view;

      // ── Step 3: flush AFTER state is fully settled ──
      // (Flushing in onConnect would send stale ops before we know the server's
      //  current revision and before any rebuild has run.)
      flushOutstanding(socket);
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
      // ── Client-side OT (Google-Docs / Jupiter model) ──
      // Queues:
      //   outstanding — sent to server, awaiting ack
      //   buffer      — typed locally while outstanding is in-flight
      //
      // Conflict rule for concurrent inserts at the same position:
      //   The op whose clientId sorts lexicographically smaller lands first.
      //   (See defaultTieBreak in ot.ts.)
      //
      // We transform the incoming remote op "through" our local queues so it
      // applies correctly on top of our optimistic view, and we transform each
      // local op "through" the remote op to keep the server in sync.
      let remote = payload.op;
      const hadLocal = !!(outstandingRef.current || bufferRef.current.length);
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

      // Update server base with the server-authored op (not the locally-transformed one).
      serverTextRef.current = applyOp(serverTextRef.current, payload.op);
      saveBase(docId, payload.newRev, serverTextRef.current);

      // Re-render view = server base + locally-transformed pending ops.
      const view = applyPending(serverTextRef.current, joinPending(outstandingRef.current, bufferRef.current));
      setText(view);
      prevTextRef.current = view;
      setRev(payload.newRev);
      revRef.current = payload.newRev;

      // Log the OT event so the conflict resolution rule is observable in the UI.
      if (hadLocal) {
        const op = payload.op;
        const action = op.kind === "ins"
          ? `ins "${op.text}" @${op.pos}`
          : `del ${op.len}ch @${op.pos}`;
        setMergeLog(prev =>
          [`rev ${payload.newRev}: remote ${op.clientId.slice(0, 10)}… → ${action} (transformed through local queue)`, ...prev].slice(0, 8)
        );
      }

      // Push to live op feed
      const rop = payload.op;
      setOpFeed(prev => [{
        key: `${rop.id}-${Date.now()}`,
        direction: "in" as const,
        kind: rop.kind,
        preview: rop.kind === "ins" ? rop.text.slice(0, 18) : `${rop.len} chars`,
        pos: rop.pos,
        clientShort: rop.clientId.slice(0, 8),
        dotColor: colorFromId(rop.clientId),
      }, ...prev].slice(0, 6));
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

      // Sync flash + push outgoing op to feed
      if (ack.acceptedOp) {
        setSyncFlash(false);
        requestAnimationFrame(() => setSyncFlash(true));
        if (syncFlashTimerRef.current) clearTimeout(syncFlashTimerRef.current);
        syncFlashTimerRef.current = setTimeout(() => setSyncFlash(false), 650);

        const aop = ack.acceptedOp;
        setOpFeed(prev => [{
          key: `ack-${aop.id}-${Date.now()}`,
          direction: "out" as const,
          kind: aop.kind,
          preview: aop.kind === "ins" ? aop.text.slice(0, 18) : `${aop.len} chars`,
          pos: aop.pos,
          clientShort: "you",
          dotColor: "#1a73e8",
        }, ...prev].slice(0, 6));
      }
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
    if (!suppressHistoryRef.current) {
      undoStackRef.current.push(prev);
      if (undoStackRef.current.length > 200) undoStackRef.current.shift();
      redoStackRef.current = [];
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
    if (!suppressHistoryRef.current) {
      undoStackRef.current.push(prevTextRef.current);
      if (undoStackRef.current.length > 200) undoStackRef.current.shift();
      redoStackRef.current = [];
    }
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

    // If server is offline, don't generate per-keystroke ops (they interleave on reconnect).
    // Let the textarea change normally; we'll merge as a single diff on reconnect.
    const socket = socketRef.current;
    if (!socket || !socket.connected) return;

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

    trackKeystroke();

    // Insert-like operations
    if (inputType.startsWith("insert")) {
      const data = (ne as any).data as string | null | undefined;
      const insertText =
        inputType === "insertLineBreak" ? "\n" : typeof data === "string" ? data : "";

      // Some browsers/IME paths provide no `data` for insertText; let onChange handle it.
      if (inputType !== "insertLineBreak" && insertText.length === 0) return;

      // We fully control the textarea value; prevent the browser from applying its own mutation.
      e.preventDefault();
      skipNextChangeRef.current = true;

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
      skipNextChangeRef.current = true;

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

  // ── Phá cách helpers ─────────────────────────────────────
  function colorFromId(id: string): string {
    const p = ["#1a73e8","#34a853","#ea4335","#9334e6","#00796b","#e67c00","#c2185b","#00b8d4"];
    let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return p[h % p.length];
  }

  function cycleTheme() {
    setTheme(t => {
      const idx = THEMES.indexOf(t);
      return THEMES[(idx + 1) % THEMES.length];
    });
  }

  function trackKeystroke() {
    const now = Date.now();
    keystrokesRef.current.push(now);
    // Keep only last 10 seconds
    keystrokesRef.current = keystrokesRef.current.filter(t => now - t < 10_000);
    // chars/min extrapolated from 10s window
    const cpm = keystrokesRef.current.length * 6;
    setWpm(Math.round(cpm / 5)); // 5 chars = 1 word
  }

  // ── Undo / Redo ─────────────────────────────────────────
  function handleUndo() {
    if (!undoStackRef.current.length) return;
    const prev = undoStackRef.current.pop()!;
    redoStackRef.current.push(prevTextRef.current);
    suppressHistoryRef.current = true;
    commitDiff(prevTextRef.current, prev, revRef.current);
    suppressHistoryRef.current = false;
  }

  function handleRedo() {
    if (!redoStackRef.current.length) return;
    const next = redoStackRef.current.pop()!;
    undoStackRef.current.push(prevTextRef.current);
    suppressHistoryRef.current = true;
    commitDiff(prevTextRef.current, next, revRef.current);
    suppressHistoryRef.current = false;
  }

  // ── Wrap selected text with markers (bold/italic/strike) ─
  function wrapSelection(before: string, after: string = before) {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart ?? 0;
    const end   = el.selectionEnd   ?? start;
    const selected = text.slice(start, end);
    // Toggle: if already wrapped, unwrap
    if (selected.startsWith(before) && selected.endsWith(after)) {
      const inner = selected.slice(before.length, selected.length - after.length);
      commitDiff(text, text.slice(0, start) + inner + text.slice(end), revRef.current);
      requestAnimationFrame(() => { el.selectionStart = start; el.selectionEnd = start + inner.length; el.focus(); });
    } else {
      const newText = text.slice(0, start) + before + selected + after + text.slice(end);
      commitDiff(text, newText, revRef.current);
      requestAnimationFrame(() => { el.selectionStart = start + before.length; el.selectionEnd = end + before.length; el.focus(); });
    }
  }

  // ── Prefix / toggle bullet or numbered list on selected lines ─
  function prefixLines(prefix: string, numbered = false) {
    const el = textareaRef.current;
    if (!el) return;
    const selStart = el.selectionStart ?? 0;
    const selEnd   = el.selectionEnd   ?? selStart;
    const lines = text.split("\n");
    let charIdx = 0;
    let counter = 1;
    const newLines = lines.map((line) => {
      const lineStart = charIdx;
      const lineEnd   = charIdx + line.length;
      charIdx += line.length + 1;
      const inRange = lineEnd >= selStart && lineStart <= (selEnd > selStart ? selEnd - 1 : selStart);
      if (!inRange) return line;
      const p = numbered ? `${counter++}. ` : prefix;
      return line.startsWith(p) ? line.slice(p.length) : p + line;
    });
    commitDiff(text, newLines.join("\n"), revRef.current);
  }

  // ── Insert markdown link ─────────────────────────────────
  function insertLink() {
    const el = textareaRef.current;
    if (!el || !linkUrl.trim()) return;
    const start = el.selectionStart ?? 0;
    const end   = el.selectionEnd   ?? start;
    const label = text.slice(start, end).trim() || linkUrl;
    const link  = `[${label}](${linkUrl.trim()})`;
    commitDiff(text, text.slice(0, start) + link + text.slice(end), revRef.current);
    setLinkOpen(false);
    setLinkUrl("");
    el.focus();
  }

  // ── Paragraph style preset (changes font size + bold) ────
  function applyParaStyle(style: string) {
    setParaStyle(style);
    const presets: Record<string, { size: number; bold: boolean }> = {
      normal: { size: 11, bold: false },
      h1:     { size: 26, bold: true  },
      h2:     { size: 20, bold: true  },
      h3:     { size: 14, bold: true  },
    };
    const p = presets[style] ?? presets.normal;
    setEditorFontSize(p.size);
    setIsBold(p.bold);
  }

  // ── Keyboard shortcuts ───────────────────────────────────
  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    trackKeystroke();
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    switch (e.key.toLowerCase()) {
      case "z": e.preventDefault(); e.shiftKey ? handleRedo() : handleUndo(); break;
      case "y": e.preventDefault(); handleRedo(); break;
      case "b": e.preventDefault(); setIsBold(v => !v); break;
      case "i": e.preventDefault(); setIsItalic(v => !v); break;
      case "u": e.preventDefault(); setIsUnderline(v => !v); break;
      case "k": e.preventDefault(); setLinkOpen(true); break;
      case "p": e.preventDefault(); window.print(); break;
    }
  }

  // ── Derived display values ────────────────────────────────
  const avatarColor = useMemo(() => colorFromId(clientId), [clientId]);

  const initials = clientId.slice(0, 2).toUpperCase();

  const saveLabel = !connected
    ? "Offline"
    : pendingCount > 0
    ? "Saving…"
    : "All changes saved";

  const dotClass = !connected ? "offline" : pendingCount > 0 ? "saving" : "online";

  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;

  const themeEmoji: Record<string, string> = { light: "☀️", neon: "⚡", sepia: "📜" };

  return (
    <div className={`docs-app theme-${theme}`}>

      {/* ── Header ───────────────────────────────────────── */}
      <header className="docs-header">
        <div className="docs-header-left">
          {/* Docs icon */}
          <div className="docs-app-icon" title="Docs home">
            <svg width="30" height="30" viewBox="0 0 30 30" fill="none" aria-hidden>
              <rect width="30" height="30" rx="3" fill="#4285F4"/>
              <rect x="6" y="9"  width="18" height="2.5" rx="1.25" fill="white"/>
              <rect x="6" y="14" width="18" height="2.5" rx="1.25" fill="white"/>
              <rect x="6" y="19" width="12" height="2.5" rx="1.25" fill="white"/>
            </svg>
          </div>

          {/* Title + menu */}
          <div className="docs-title-area">
            <div className="docs-title-row">
              <input
                className="docs-title-input"
                value={docTitle}
                onChange={(e) => setDocTitle(e.target.value)}
                aria-label="Document title"
              />
              {/* Star */}
              <button className="docs-icon-btn" title="Star" style={{ width: 28, height: 28 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                </svg>
              </button>
              {/* Move to folder */}
              <button className="docs-icon-btn" title="Move" style={{ width: 28, height: 28 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
              </button>
            </div>

            <nav className="docs-menu-bar" aria-label="Menu">
              {["File","Edit","View","Insert","Format","Tools","Extensions","Help"].map((item) => (
                <span key={item} className="docs-menu-item">{item}</span>
              ))}
            </nav>
          </div>
        </div>

        {/* Right side */}
        <div className="docs-header-right">
          <span className="docs-save-status">{saveLabel}</span>

          {/* Comments */}
          <button className="docs-icon-btn" title="Comments">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
          </button>

          {/* Theme toggle */}
          <button
            className="theme-toggle-btn"
            title={`Theme: ${theme} — click to switch`}
            onClick={cycleTheme}
          >
            {themeEmoji[theme]}
          </button>

          {/* Share */}
          <button className="docs-share-btn" title="Share">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
              <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
            </svg>
            Share
          </button>

          {/* Avatar */}
          <div
            className="docs-avatar"
            style={{ background: avatarColor }}
            title={`You (${clientId.slice(0, 16)}…)`}
          >
            {initials}
          </div>
        </div>
      </header>

      {/* ── Offline banner ────────────────────────────────── */}
      {!connected && (
        <div className="docs-offline-banner">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
            <path d="M1 1l22 22M16.72 11.06A10.94 10.94 0 0 1 19 12.55M5 12.55a10.94 10.94 0 0 1 5.17-2.39M10.71 5.05A16 16 0 0 1 22.56 9M1.42 9a15.91 15.91 0 0 1 4.7-2.88M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01"/>
          </svg>
          You are offline — changes will sync when your connection is restored.
        </div>
      )}

      {/* ── Toolbar ──────────────────────────────────────── */}
      <div className="docs-toolbar" role="toolbar" aria-label="Formatting">
        {/* Undo / Redo */}
        <button className="toolbar-btn" title="Undo (Ctrl+Z)" onClick={handleUndo} disabled={!undoStackRef.current.length}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>
        </button>
        <button className="toolbar-btn" title="Redo (Ctrl+Y)" onClick={handleRedo} disabled={!redoStackRef.current.length}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/></svg>
        </button>
        <button className="toolbar-btn" title="Print (Ctrl+P)" onClick={() => window.print()}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
        </button>

        <div className="toolbar-sep" />

        {/* Zoom */}
        <select
          className="toolbar-select"
          title="Zoom"
          value={zoom}
          style={{ width: 68 }}
          onChange={(e) => setZoom(Number(e.target.value))}
        >
          {[50, 75, 90, 100, 110, 125, 150, 200].map(z => (
            <option key={z} value={z}>{z}%</option>
          ))}
        </select>

        <div className="toolbar-sep" />

        {/* Paragraph style */}
        <select
          className="toolbar-select"
          title="Paragraph styles"
          value={paraStyle}
          style={{ width: 120 }}
          onChange={(e) => applyParaStyle(e.target.value)}
        >
          <option value="normal">Normal text</option>
          <option value="h1">Heading 1</option>
          <option value="h2">Heading 2</option>
          <option value="h3">Heading 3</option>
        </select>

        {/* Font */}
        <select
          className="toolbar-select"
          title="Font"
          value={editorFont}
          style={{ width: 110 }}
          onChange={(e) => setEditorFont(e.target.value)}
        >
          <option value="Arial, sans-serif">Arial</option>
          <option value="'Times New Roman', serif">Times New Roman</option>
          <option value="'Courier New', monospace">Courier New</option>
          <option value="Georgia, serif">Georgia</option>
          <option value="'Comic Sans MS', cursive">Comic Sans</option>
          <option value="Verdana, sans-serif">Verdana</option>
        </select>

        {/* Font size */}
        <select
          className="toolbar-select"
          title="Font size"
          value={editorFontSize}
          style={{ width: 50 }}
          onChange={(e) => setEditorFontSize(Number(e.target.value))}
        >
          {[8,9,10,11,12,14,16,18,20,24,28,36,48,72].map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        <div className="toolbar-sep" />

        {/* Bold */}
        <button
          className={`toolbar-btn${isBold ? " active" : ""}`}
          title="Bold (Ctrl+B)"
          style={{ fontWeight: 700, fontSize: 15 }}
          onClick={() => setIsBold(v => !v)}
        >B</button>

        {/* Italic */}
        <button
          className={`toolbar-btn${isItalic ? " active" : ""}`}
          title="Italic (Ctrl+I)"
          style={{ fontStyle: "italic", fontSize: 15 }}
          onClick={() => setIsItalic(v => !v)}
        >I</button>

        {/* Underline */}
        <button
          className={`toolbar-btn${isUnderline ? " active" : ""}`}
          title="Underline (Ctrl+U)"
          style={{ textDecoration: "underline", fontSize: 15 }}
          onClick={() => setIsUnderline(v => !v)}
        >U</button>

        {/* Strikethrough */}
        <button
          className={`toolbar-btn${isStrike ? " active" : ""}`}
          title="Strikethrough"
          style={{ textDecoration: "line-through", fontSize: 14 }}
          onClick={() => setIsStrike(v => !v)}
        >S</button>

        <div className="toolbar-sep" />

        {/* Text color */}
        <div style={{ position: "relative" }}>
          <button
            className="toolbar-btn"
            title="Text color"
            style={{ flexDirection: "column", gap: 1 }}
            onClick={() => setColorPickerFor(v => v === "text" ? null : "text")}
          >
            <span style={{ fontSize: 14, fontWeight: 700, lineHeight: 1, color: textColor }}>A</span>
            <span style={{ height: 3, width: 16, background: textColor, borderRadius: 1 }} />
          </button>
          {colorPickerFor === "text" && (
            <ColorPicker
              colors={["#202124","#d93025","#f29900","#188038","#1967d2","#9334e6","#c5221f","#fa7b17","#0d652d","#174ea6","#6a0dad","#e52592"]}
              onPick={(c) => { setTextColor(c); setColorPickerFor(null); }}
              onClose={() => setColorPickerFor(null)}
            />
          )}
        </div>

        {/* Highlight color */}
        <div style={{ position: "relative" }}>
          <button
            className="toolbar-btn"
            title="Highlight color"
            style={{ flexDirection: "column", gap: 1 }}
            onClick={() => setColorPickerFor(v => v === "hl" ? null : "hl")}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
            <span style={{ height: 3, width: 16, background: hlColor === "transparent" ? "#e0e0e0" : hlColor, borderRadius: 1 }} />
          </button>
          {colorPickerFor === "hl" && (
            <ColorPicker
              colors={["transparent","#fef08a","#bbf7d0","#bfdbfe","#fde68a","#ddd6fe","#fbcfe8","#fed7aa","#e5e7eb"]}
              onPick={(c) => { setHlColor(c); setColorPickerFor(null); }}
              onClose={() => setColorPickerFor(null)}
              labels={{ transparent: "None" }}
            />
          )}
        </div>

        <div className="toolbar-sep" />

        {/* Link */}
        <button
          className="toolbar-btn"
          title="Insert link (Ctrl+K)"
          onClick={() => setLinkOpen(true)}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
        </button>

        <div className="toolbar-sep" />

        {/* Alignment */}
        <button
          className={`toolbar-btn${editorAlign === "left" ? " active" : ""}`}
          title="Align left (Ctrl+Shift+L)"
          onClick={() => setEditorAlign("left")}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="15" y2="12"/><line x1="3" y1="18" x2="18" y2="18"/></svg>
        </button>
        <button
          className={`toolbar-btn${editorAlign === "center" ? " active" : ""}`}
          title="Align center (Ctrl+Shift+E)"
          onClick={() => setEditorAlign("center")}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="6" y1="12" x2="18" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg>
        </button>
        <button
          className={`toolbar-btn toolbar-hide-sm${editorAlign === "right" ? " active" : ""}`}
          title="Align right (Ctrl+Shift+R)"
          onClick={() => setEditorAlign("right")}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="6" y1="18" x2="21" y2="18"/></svg>
        </button>
        <button
          className={`toolbar-btn toolbar-hide-sm${editorAlign === "justify" ? " active" : ""}`}
          title="Justify (Ctrl+Shift+J)"
          onClick={() => setEditorAlign("justify")}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
        </button>

        <div className="toolbar-sep" />

        {/* Line spacing */}
        <select
          className="toolbar-select toolbar-hide-sm"
          title="Line spacing"
          value={editorLineHeight}
          style={{ width: 58 }}
          onChange={(e) => setEditorLineHeight(Number(e.target.value))}
        >
          {[1.0, 1.15, 1.5, 1.6, 2.0, 2.5].map(v => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>

        {/* Bullet list */}
        <button
          className="toolbar-btn toolbar-hide-sm"
          title="Bulleted list"
          onClick={() => prefixLines("• ")}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="4" cy="6" r="1.5" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1.5" fill="currentColor" stroke="none"/></svg>
        </button>

        {/* Numbered list */}
        <button
          className="toolbar-btn toolbar-hide-sm"
          title="Numbered list"
          onClick={() => prefixLines("", true)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/></svg>
        </button>
      </div>

      {/* ── Link dialog ───────────────────────────────────── */}
      {linkOpen && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 300,
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "rgba(0,0,0,0.25)",
        }} onClick={() => setLinkOpen(false)}>
          <div style={{
            background: "white", borderRadius: 8, padding: "20px 24px",
            boxShadow: "0 8px 30px rgba(0,0,0,0.18)", width: 380,
          }} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontWeight: 500, marginBottom: 12, fontSize: 15 }}>Insert link</div>
            <input
              autoFocus
              type="url"
              placeholder="https://example.com"
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") insertLink(); if (e.key === "Escape") setLinkOpen(false); }}
              style={{
                width: "100%", border: "1px solid #dadce0", borderRadius: 4,
                padding: "8px 10px", fontSize: 14, outline: "none",
                fontFamily: "inherit",
              }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button
                onClick={() => setLinkOpen(false)}
                style={{ border: "none", background: "transparent", cursor: "pointer", padding: "8px 16px", borderRadius: 4, fontSize: 14, fontFamily: "inherit", color: "#1a73e8" }}
              >Cancel</button>
              <button
                onClick={insertLink}
                style={{ background: "#1a73e8", color: "white", border: "none", borderRadius: 4, padding: "8px 16px", cursor: "pointer", fontSize: 14, fontFamily: "inherit", fontWeight: 500 }}
              >Apply</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Page canvas ───────────────────────────────────── */}
      <main className="docs-canvas" onClick={() => { setColorPickerFor(null); }}>
        <div className={`docs-page${syncFlash ? " sync-flash" : ""}`} style={{ zoom: zoom / 100 }}>
          <textarea
            ref={textareaRef}
            className="docs-editor"
            value={text}
            placeholder="Start typing…"
            style={{
              fontFamily: editorFont,
              fontSize: editorFontSize + "pt",
              fontWeight: isBold ? 700 : 400,
              fontStyle: isItalic ? "italic" : "normal",
              textDecoration: [isUnderline ? "underline" : "", isStrike ? "line-through" : ""].filter(Boolean).join(" ") || "none",
              color: textColor,
              backgroundColor: hlColor,
              textAlign: editorAlign,
              lineHeight: editorLineHeight,
            }}
            onKeyDown={handleKeyDown}
            onBeforeInput={handleBeforeInput}
            onCompositionStart={() => {
              composingRef.current = true;
              composeBaseTextRef.current = prevTextRef.current;
              composeBaseRevRef.current = revRef.current;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
              const socket = socketRef.current;
              if (!socket || !socket.connected) {
                offlineDirtyRef.current = true;
                setStatus("offline (queued locally)");
                return;
              }
              commitDiff(composeBaseTextRef.current, prevTextRef.current, composeBaseRevRef.current);
            }}
            onChange={(e) => {
              if (skipNextChangeRef.current) {
                skipNextChangeRef.current = false;
                return;
              }
              if (composingRef.current) {
                setText(e.target.value);
                prevTextRef.current = e.target.value;
                return;
              }
              const socket = socketRef.current;
              if (!socket || !socket.connected) {
                offlineDirtyRef.current = true;
                setText(e.target.value);
                prevTextRef.current = e.target.value;
                setStatus("offline (queued locally)");
                return;
              }
              commitDiff(prevTextRef.current, e.target.value, revRef.current);
            }}
            spellCheck={false}
          />
        </div>
      </main>

      {/* ── Status bar ────────────────────────────────────── */}
      <div className="docs-statusbar">
        <span className={`status-dot ${dotClass}`} />
        <span>{saveLabel}</span>
        <span>·</span>
        <span>{wordCount} word{wordCount !== 1 ? "s" : ""}</span>
        <span>·</span>
        <span>Rev {rev}</span>
        {wpm > 0 && (
          <span className={`wpm-badge${wpm >= 80 ? " hot" : ""}`}>
            · {wpm > 0 ? `${wpm} WPM` : ""}{wpm >= 80 ? " 🔥" : wpm >= 50 ? " ✨" : ""}
          </span>
        )}

        {mergeLog.length > 0 && (
          <button
            onClick={() => setShowMergeToast(v => !v)}
            style={{
              border: "none",
              background: "transparent",
              cursor: "pointer",
              color: "#1a73e8",
              fontSize: 12,
              padding: "0 4px",
              fontFamily: "inherit",
            }}
            title="View OT conflict log"
          >
            ⚡ OT merge ({mergeLog.length})
          </button>
        )}

        <div className="docs-statusbar-right">
          <button
            onClick={() => {
              const socket = socketRef.current;
              if (socket && socket.connected) flushOutstanding(socket);
            }}
            style={{
              border: "1px solid #dadce0",
              background: "white",
              borderRadius: 4,
              padding: "2px 10px",
              fontSize: 12,
              cursor: "pointer",
              color: "#202124",
              fontFamily: "inherit",
            }}
          >
            Force sync
          </button>
        </div>
      </div>

      {/* ── Live Op Feed ─────────────────────────────────────── */}
      {opFeed.length > 0 && (
        <div className="op-feed">
          {opFeed.map((item) => (
            <div key={item.key} className="op-chip">
              <span className="op-chip-dot" style={{ background: item.dotColor }} />
              <span className={`op-chip-type ${item.kind}`}>
                {item.kind.toUpperCase()}
              </span>
              <span className="op-chip-preview">
                {item.kind === "ins" ? `"${item.preview}"` : `✂ ${item.preview}`}
              </span>
              <span className="op-chip-dir">{item.direction === "in" ? "←" : "→"}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── Merge / conflict toast ─────────────────────────── */}
      {showMergeToast && mergeLog.length > 0 && (
        <div className="docs-merge-toast">
          <button className="docs-merge-toast-close" onClick={() => setShowMergeToast(false)}>×</button>
          <div className="docs-merge-toast-title">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#1a73e8" strokeWidth="2.5"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
            OT Conflict resolution
          </div>
          <div className="docs-merge-toast-rule">
            Concurrent inserts @ same pos → clientId lexicographic order (smaller = first){"\n"}
            Offline edits → rebased against server ops since baseRev
          </div>
          <div className="docs-merge-toast-log">
            {mergeLog.map((entry, i) => (
              <div key={i} className="docs-merge-toast-entry">
                {i === 0 ? "▶ " : "  "}{entry}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

