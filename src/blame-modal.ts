import { type App, Modal } from "obsidian";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { colorFromName, withAlpha } from "./utils";

interface Auth {
  user: string;
  pass: string;
}

interface AuthorInfo {
  name: string;
  color: string;
}

// Minimal view of a Yjs text item; property names are stable in yjs 13 and are
// preserved by the bundler (no property mangling), so walking the item list is safe.
interface YItem {
  deleted: boolean;
  content: { str?: string };
  id: { client: number };
  right: YItem | null;
}

interface Run {
  name: string;
  color: string;
  text: string;
}

// Shows the current note coloured by author ("who wrote what").
export class BlameModal extends Modal {
  private provider: WebsocketProvider | null = null;
  private doc: Y.Doc | null = null;

  constructor(
    app: App,
    private serverUrl: string,
    private auth: Auth,
    private path: string,
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const { contentEl, titleEl } = this;
    titleEl.setText(`Autoren: ${this.path}`);
    contentEl.createEl("p", { text: "Lade …", cls: "lp-blame-status" });

    const doc = new Y.Doc();
    const provider = new WebsocketProvider(this.serverUrl, `doc:${encodeURIComponent(this.path)}`, doc, {
      connect: true,
      params: { u: this.auth.user, p: this.auth.pass },
    });
    this.doc = doc;
    this.provider = provider;

    const ok = await new Promise<boolean>((resolve) => {
      if (provider.synced) return resolve(true);
      const timer = setTimeout(() => resolve(false), 8000);
      provider.once("sync", (synced: boolean) => {
        clearTimeout(timer);
        resolve(synced);
      });
    });

    contentEl.empty();
    if (!ok) {
      contentEl.createEl("p", { text: "Keine Verbindung zum Server." });
      return;
    }

    const authors = doc.getMap("authors");
    const text = doc.getText("content") as unknown as { _start: YItem | null };
    const runs = this.blame(text, authors);
    this.render(runs);
  }

  private blame(text: { _start: YItem | null }, authors: Y.Map<unknown>): Run[] {
    const resolve = (client: number): AuthorInfo => {
      const a = authors.get(String(client)) as AuthorInfo | undefined;
      if (a?.name) return { name: a.name, color: a.color || colorFromName(a.name) };
      return { name: "Unbekannt", color: "#888888" };
    };

    const runs: Run[] = [];
    let item = text._start;
    while (item) {
      if (!item.deleted && typeof item.content?.str === "string") {
        const info = resolve(item.id.client);
        const last = runs[runs.length - 1];
        if (last && last.name === info.name) last.text += item.content.str;
        else runs.push({ name: info.name, color: info.color, text: item.content.str });
      }
      item = item.right;
    }
    return runs;
  }

  private render(runs: Run[]): void {
    const { contentEl } = this;
    if (runs.length === 0) {
      contentEl.createEl("p", { text: "Diese Notiz hat noch keinen synchronisierten Inhalt." });
      return;
    }

    const names = new Map<string, string>();
    for (const r of runs) if (!names.has(r.name)) names.set(r.name, r.color);

    const legend = contentEl.createDiv({ cls: "lp-blame-legend" });
    for (const [name, color] of names) {
      const chip = legend.createSpan({ cls: "lp-blame-chip" });
      const dot = chip.createSpan({ cls: "lp-blame-dot" });
      dot.style.backgroundColor = color;
      chip.createSpan({ text: name });
    }

    const pre = contentEl.createEl("pre", { cls: "lp-blame-text" });
    for (const r of runs) {
      const span = pre.createSpan({ text: r.text });
      span.style.backgroundColor = withAlpha(r.color, 0.3);
      span.setAttr("title", r.name);
    }
  }

  onClose(): void {
    this.provider?.destroy();
    this.doc?.destroy();
    this.provider = null;
    this.doc = null;
    this.contentEl.empty();
  }
}
