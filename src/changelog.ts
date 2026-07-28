import { requestUrl } from "obsidian";
import * as Y from "yjs";
import { authHeader, couchBase } from "./profile";
import { base64ToBytes } from "./utils";

// Reads the append-only change log written by the server (one merged entry per
// short time window) and groups it into meaningful editing sessions.
const CHANGELOG_DB = "ksk_changelog";

export interface ChangeEntry {
  t0: number;
  t1: number;
  u: string; // base64-encoded merged Yjs update
}

export interface Session {
  startT: number;
  endT: number;
  authors: string[];
  startText: string;
  endText: string;
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

// Replay the log to derive, per session, the text before and after it and the
// set of contributing authors. Sessions are split on inactivity gaps.
export function buildSessions(entries: ChangeEntry[], gapMs: number): Session[] {
  if (entries.length === 0) return [];

  const groups: ChangeEntry[][] = [];
  let current: ChangeEntry[] = [entries[0]];
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].t0 - current[current.length - 1].t1 > gapMs) {
      groups.push(current);
      current = [entries[i]];
    } else {
      current.push(entries[i]);
    }
  }
  groups.push(current);

  const doc = new Y.Doc({ gc: false });
  const text = doc.getText("content");
  const authors = doc.getMap("authors");
  const sessions: Session[] = [];
  let prevText = "";

  for (const group of groups) {
    const clients = new Set<number>();
    for (const e of group) {
      const update = base64ToBytes(e.u);
      Y.applyUpdate(doc, update);
      const sv = Y.decodeStateVector(Y.encodeStateVectorFromUpdate(update));
      for (const client of sv.keys()) clients.add(client);
    }
    const names = new Set<string>();
    for (const client of clients) {
      const a = authors.get(String(client)) as { name?: string } | undefined;
      names.add(a?.name || "Unbekannt");
    }
    const endText = text.toString();
    sessions.push({
      startT: group[0].t0,
      endT: group[group.length - 1].t1,
      authors: [...names],
      startText: prevText,
      endText,
    });
    prevText = endText;
  }
  return sessions;
}
