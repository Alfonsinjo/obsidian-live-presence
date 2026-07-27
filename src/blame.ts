import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { colorFromName } from "./utils";

interface YItem {
  deleted: boolean;
  content: { str?: string };
  id: { client: number };
  right: YItem | null;
}

export interface AuthorRun {
  text: string;
  name: string;
  color: string;
}

// Connect briefly to a note's document and return its current text split into
// runs by author (adjacent runs of the same author merged).
export async function readAuthorRuns(
  serverUrl: string,
  auth: { user: string; pass: string },
  path: string,
): Promise<AuthorRun[] | null> {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(serverUrl, `doc:${encodeURIComponent(path)}`, doc, {
    connect: true,
    params: { u: auth.user, p: auth.pass },
  });
  try {
    const ok = await new Promise<boolean>((resolve) => {
      if (provider.synced) return resolve(true);
      const timer = setTimeout(() => resolve(false), 8000);
      provider.once("sync", (synced: boolean) => {
        clearTimeout(timer);
        resolve(synced);
      });
    });
    if (!ok) return null;

    const authors = doc.getMap("authors");
    const text = doc.getText("content") as unknown as { _start: YItem | null };
    const resolve = (client: number): { name: string; color: string } => {
      const a = authors.get(String(client)) as { name?: string; color?: string } | undefined;
      const name = a?.name || "Unbekannt";
      return { name, color: a?.color || colorFromName(name) };
    };

    const runs: AuthorRun[] = [];
    let item = text._start;
    while (item) {
      if (!item.deleted && typeof item.content?.str === "string") {
        const info = resolve(item.id.client);
        const last = runs[runs.length - 1];
        if (last && last.name === info.name) last.text += item.content.str;
        else runs.push({ text: item.content.str, name: info.name, color: info.color });
      }
      item = item.right;
    }
    return runs;
  } finally {
    provider.destroy();
    doc.destroy();
  }
}
