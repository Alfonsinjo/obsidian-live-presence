import { requestUrl } from "obsidian";
import { authHeader, couchBase } from "./profile";

// Reads the append-only change log written by the server (one merged Yjs update
// per short time window).
const CHANGELOG_DB = "ksk_changelog";

export interface ChangeEntry {
  t0: number;
  t1: number;
  u: string; // base64-encoded merged Yjs update
}

export async function listChangelog(
  serverUrl: string,
  auth: { user: string; pass: string },
  path: string,
): Promise<ChangeEntry[]> {
  const prefix = `c:doc:${encodeURIComponent(path)}:`;
  const start = encodeURIComponent(`"${prefix}"`);
  const end = encodeURIComponent(`"${prefix}￰"`);
  const url =
    `${couchBase(serverUrl)}/${CHANGELOG_DB}/_all_docs?include_docs=true` +
    `&startkey=${start}&endkey=${end}`;
  try {
    const res = await requestUrl({
      url,
      method: "GET",
      headers: { Authorization: authHeader(auth.user, auth.pass) },
      throw: false,
    });
    if (res.status !== 200) return [];
    const rows = (res.json?.rows ?? []) as Array<{ doc?: { t0: number; t1: number; u: string } }>;
    const out: ChangeEntry[] = [];
    for (const row of rows) {
      if (row.doc && typeof row.doc.u === "string") {
        out.push({ t0: row.doc.t0, t1: row.doc.t1, u: row.doc.u });
      }
    }
    out.sort((a, b) => a.t0 - b.t0);
    return out;
  } catch {
    return [];
  }
}
