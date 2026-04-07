import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DocId, Revision, TextOp } from "@ds/shared";

export type PersistedDoc = {
  docId: DocId;
  rev: Revision;
  text: string;
  ops: TextOp[];
};

function dataDir() {
  return join(process.cwd(), "data");
}

function docPath(docId: DocId) {
  return join(dataDir(), `${encodeURIComponent(docId)}.json`);
}

export function loadDoc(docId: DocId): PersistedDoc | null {
  const p = docPath(docId);
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || parsed.docId !== docId) return null;
  return parsed as PersistedDoc;
}

export function saveDoc(doc: PersistedDoc) {
  const dir = dataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const p = docPath(doc.docId);
  // atomic-ish: write then replace
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc), "utf8");
  renameSync(tmp, p);
}

