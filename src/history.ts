import { requestUrl } from "obsidian";
import { authHeader, couchBase } from "./profile";

// Version history is stored as full-text snapshots in a dedicated CouchDB
// database, one document per saved version. This is independent of the live
// Yjs documents and reliable across reconnects (no reliance on retained CRDT
// history). Diffs between versions are computed as a line-level comparison.
const HISTORY_DB = "ksk_history";
const MAX_DIFF_CELLS = 3_000_000;

export interface Version {
  t: number;
  by: string;
  text: string;
}

export interface DiffLine {
  text: string;
  type: "added" | "removed" | null;
}

function versionId(path: string, t: number): string {
  return `h:${encodeURIComponent(path)}:${String(t).padStart(16, "0")}`;
}

function keyRange(path: string): { start: string; end: string } {
  const p = `h:${encodeURIComponent(path)}:`;
  return { start: `"${p}"`, end: `"${p}￰"` };
}

// Store the current text of a note as a new version.
export async function saveVersion(
  serverUrl: string,
  auth: { user: string; pass: string },
  path: string,
  by: string,
  text: string,
): Promise<boolean> {
  const t = Date.now();
  const url = `${couchBase(serverUrl)}/${HISTORY_DB}/${versionId(path, t)}`;
  try {
    const res = await requestUrl({
      url,
      method: "PUT",
      headers: { Authorization: authHeader(auth.user, auth.pass), "Content-Type": "application/json" },
      body: JSON.stringify({ path, t, by, text }),
      throw: false,
    });
    return res.status === 201 || res.status === 200;
  } catch {
    return false;
  }
}

// List all stored versions of a note, oldest first.
export async function listVersions(
  serverUrl: string,
  auth: { user: string; pass: string },
  path: string,
): Promise<Version[]> {
  const { start, end } = keyRange(path);
  const url =
    `${couchBase(serverUrl)}/${HISTORY_DB}/_all_docs?include_docs=true` +
    `&startkey=${encodeURIComponent(start)}&endkey=${encodeURIComponent(end)}`;
  try {
    const res = await requestUrl({
      url,
      method: "GET",
      headers: { Authorization: authHeader(auth.user, auth.pass) },
      throw: false,
    });
    if (res.status !== 200) return [];
    const rows = (res.json?.rows ?? []) as Array<{ doc?: { t: number; by: string; text: string } }>;
    const out: Version[] = [];
    for (const row of rows) {
      if (row.doc && typeof row.doc.text === "string") {
        out.push({ t: row.doc.t, by: row.doc.by ?? "", text: row.doc.text });
      }
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  } catch {
    return [];
  }
}

// Line-level diff (like a simple git diff). Falls back to a whole-content
// replacement when the inputs are too large for the LCS table.
export function diffLines(aStr: string, bStr: string): DiffLine[] {
  const a = aStr.split("\n");
  const b = bStr.split("\n");
  const n = a.length;
  const m = b.length;

  const out: DiffLine[] = [];
  const push = (text: string, type: DiffLine["type"]) => out.push({ text, type });

  if ((n + 1) * (m + 1) > MAX_DIFF_CELLS) {
    for (const line of a) push(line, "removed");
    for (const line of b) push(line, "added");
    return out;
  }

  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push(a[i], null);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push(a[i], "removed");
      i++;
    } else {
      push(b[j], "added");
      j++;
    }
  }
  while (i < n) push(a[i++], "removed");
  while (j < m) push(b[j++], "added");
  return out;
}
