import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import type { OverlayRun } from "./inline-overlay";
import { colorFromName, sleep, withAlpha } from "./utils";

interface Auth {
  user: string;
  pass: string;
}

export interface LiveBlame {
  runs: OverlayRun[];
  legend: { label: string; color: string }[];
  length: number;
}

const SYNC_TIMEOUT = 8000;

function waitForSync(provider: WebsocketProvider, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (provider.synced) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), ms);
    provider.once("sync", (synced: boolean) => {
      clearTimeout(timer);
      resolve(synced);
    });
  });
}

// Yjs internal item shape we walk (each item carries the client id that inserted
// its text). Kept local so the rest of the code stays on the public API.
interface YItem {
  deleted: boolean;
  content: { str?: string };
  id: { client: number };
  right: YItem | null;
}

interface AuthorEntry {
  name?: string;
  color?: string;
  user?: string; // login user, stable across name changes
}

// Build author blame from an already-open shared document: walk the Y.Text items
// and map each inserting client id to a name/colour via the document's "authors"
// map. `names` maps a login user to their CURRENT display name, so a passage
// shows the author's up-to-date name (and colour) even after they renamed.
export function blameFromDoc(doc: Y.Doc, names?: Map<string, string>): LiveBlame {
  const text = doc.getText("content");
  const authors = doc.getMap("authors");

  const raw: { from: number; to: number; name: string; color: string }[] = [];
  let pos = 0;
  let item = (text as unknown as { _start: YItem | null })._start;
  while (item) {
    const str = item.content?.str;
    if (!item.deleted && typeof str === "string" && str.length > 0) {
      const a = authors.get(String(item.id.client)) as AuthorEntry | undefined;
      const current = a?.user ? names?.get(a.user) : undefined;
      const name = current ?? a?.name ?? "Unbekannt";
      // Colour follows the (possibly renamed) name so it stays in sync with it.
      const color = current ? colorFromName(current) : (a?.color ?? colorFromName(name));
      const prev = raw[raw.length - 1];
      if (prev && prev.name === name && prev.color === color && prev.to === pos) {
        prev.to = pos + str.length; // merge adjacent runs of the same author
      } else {
        raw.push({ from: pos, to: pos + str.length, name, color });
      }
      pos += str.length;
    }
    item = item.right;
  }

  const runs: OverlayRun[] = raw.map((r) => ({
    from: r.from,
    to: r.to,
    color: withAlpha(r.color, 0.3),
    label: r.name,
  }));
  const legendMap = new Map<string, string>();
  for (const r of raw) if (!legendMap.has(r.name)) legendMap.set(r.name, r.color);
  const legend = [...legendMap].map(([label, color]) => ({ label, color }));
  return { runs, legend, length: pos };
}

// Connect to a note's shared document just to read its blame (used when the note
// is not currently co-edited, so there is no live document to reuse).
export async function buildLiveBlame(
  serverUrl: string,
  auth: Auth,
  path: string,
  names?: Map<string, string>,
): Promise<LiveBlame | null> {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(serverUrl, `doc:${encodeURIComponent(path)}`, doc, {
    connect: true,
    params: { u: auth.user, p: auth.pass },
  });
  try {
    if (!(await waitForSync(provider, SYNC_TIMEOUT))) return null;
    await sleep(250); // let the full content arrive after the sync event
    return blameFromDoc(doc, names);
  } finally {
    provider.destroy();
    doc.destroy();
  }
}
