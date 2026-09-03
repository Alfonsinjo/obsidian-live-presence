import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import type { OverlayRun } from "./inline-overlay";
import { sleep, withAlpha } from "./utils";

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

// Build author blame straight from the live shared document: walk the Y.Text
// items and map each inserting client id to a name/colour via the document's
// "authors" map. This always matches the current text length exactly, unlike
// replaying the (possibly stale or empty) change log.
export async function buildLiveBlame(
  serverUrl: string,
  auth: Auth,
  path: string,
): Promise<LiveBlame | null> {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(serverUrl, `doc:${encodeURIComponent(path)}`, doc, {
    connect: true,
    params: { u: auth.user, p: auth.pass },
  });
  try {
    if (!(await waitForSync(provider, SYNC_TIMEOUT))) return null;
    await sleep(250); // let the full content arrive after the sync event
    const text = doc.getText("content");
    const authors = doc.getMap("authors");

    const raw: { from: number; to: number; name: string; color: string }[] = [];
    let pos = 0;
    let item = (text as unknown as { _start: YItem | null })._start;
    while (item) {
      const str = item.content?.str;
      if (!item.deleted && typeof str === "string" && str.length > 0) {
        const a = authors.get(String(item.id.client)) as { name?: string; color?: string } | undefined;
        const name = a?.name ?? "Unbekannt";
        const color = a?.color ?? "#888888";
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
  } finally {
    provider.destroy();
    doc.destroy();
  }
}
