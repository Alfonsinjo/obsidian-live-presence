import { Compartment, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { Notice } from "obsidian";
import { yCollab } from "y-codemirror.next";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { applyMinimalCmUpdate, applyMinimalYTextUpdate, normalizeLineEndings, sleep, withAlpha } from "../utils";

interface Auth {
  user: string;
  pass: string;
}
interface User {
  name: string;
  color: string;
}

// Binds one file's editor to a shared Y.Text so edits are character-by-character
// real-time with correct (relative-position) remote cursors. One file at a time.
export class CollabBinding {
  private compartment = new Compartment();
  private doc: Y.Doc | null = null;
  private provider: WebsocketProvider | null = null;
  private view: EditorView | null = null;
  path: string | null = null;
  private gen = 0;

  baseExtension(): Extension {
    return this.compartment.of([]);
  }

  isActive(path: string): boolean {
    return this.provider !== null && this.path === path;
  }
  get active(): boolean {
    return this.provider !== null;
  }

  private log(...args: unknown[]): void {
    console.log("[LivePresence]", ...args);
  }

  async engage(
    view: EditorView,
    path: string,
    serverUrl: string,
    auth: Auth,
    user: User,
  ): Promise<void> {
    await this.disengage();
    const gen = ++this.gen;
    this.log(`engage: ${path} via ${serverUrl}`);

    try {
      const doc = new Y.Doc();
      const provider = new WebsocketProvider(serverUrl, `doc:${encodeURIComponent(path)}`, doc, {
        connect: true,
        params: { u: auth.user, p: auth.pass },
      });
      const text = doc.getText("content");
      this.doc = doc;
      this.provider = provider;
      this.view = view;
      this.path = path;

      provider.on("status", (e: { status: string }) => this.log("ws status:", e.status));
      provider.on("connection-error", () => this.log("ws connection-error"));

      const synced = await this.waitForSync(provider, 8000);
      if (this.gen !== gen || this.destroyed(view)) return;
      this.log(`synced=${synced} sharedTextLen=${text.length}`);
      if (!synced) {
        new Notice("Live Presence: Co-Editing konnte nicht verbinden (Zeitüberschreitung).");
        await this.disengage();
        return;
      }

      // Announce ourselves in the doc room first (used for the seed election and by yCollab).
      provider.awareness.setLocalStateField("user", {
        name: user.name,
        color: user.color,
        colorLight: withAlpha(user.color, 0.25),
      });

      // Reconcile editor <-> shared text. CRITICAL: never clear a non-empty editor.
      const local = normalizeLineEndings(view.state.doc.toString());
      if (text.length > 0) {
        // Shared text already has content -> adopt it into the editor.
        this.log("adopt shared text into editor");
        applyMinimalCmUpdate(view, text.toString());
      } else if (local.length > 0) {
        // Shared text is empty but we have content. Wait briefly for a peer to seed it,
        // then adopt; otherwise seed from our own content. Never wipe the editor.
        await sleep(400);
        if (this.gen !== gen || this.destroyed(view)) return;
        const self = provider.awareness.clientID;
        const others = [...provider.awareness.getStates().keys()].filter((id) => id !== self);
        const iSeed = others.length === 0 || self <= Math.min(...others);
        this.log(`shared empty; iSeed=${iSeed} peers=${others.length}`);
        if (!iSeed) {
          for (let i = 0; i < 25 && text.length === 0; i++) {
            await sleep(100);
            if (this.gen !== gen || this.destroyed(view)) return;
          }
        }
        if (text.length > 0) {
          applyMinimalCmUpdate(view, text.toString());
        } else {
          applyMinimalYTextUpdate(doc, text, local);
        }
      } else {
        this.log("both empty; nothing to reconcile");
      }
      // If both are empty there is nothing to reconcile.
      if (this.gen !== gen || this.destroyed(view)) return;

      text.observe(() => this.log(`shared text changed, len=${text.length}`));

      const ext = yCollab(text, provider.awareness, { undoManager: false });
      view.dispatch({
        effects: this.compartment.reconfigure(Array.isArray(ext) ? [...ext] : [ext]),
      });
      this.log("yCollab attached; co-editing active for", path);
      new Notice(`Live Presence: Co-Editing aktiv (${path}).`);
    } catch (err) {
      console.error("[LivePresence] engage failed:", err);
      new Notice("Live Presence: Co-Editing-Fehler (siehe Konsole).");
      await this.disengage();
    }
  }

  async disengage(): Promise<void> {
    this.gen++;
    const view = this.view;
    const provider = this.provider;
    const doc = this.doc;
    this.view = null;
    this.provider = null;
    this.doc = null;
    this.path = null;

    if (view && !this.destroyed(view)) {
      try {
        view.dispatch({ effects: this.compartment.reconfigure([]) });
      } catch {
        // view may be gone
      }
    }
    if (provider) {
      try {
        provider.awareness.setLocalState(null);
      } catch {
        // ignore
      }
      provider.destroy();
    }
    if (doc) doc.destroy();
  }

  private waitForSync(provider: WebsocketProvider, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (provider.synced) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => resolve(false), ms);
      provider.once("sync", (isSynced: boolean) => {
        clearTimeout(timer);
        resolve(isSynced);
      });
    });
  }

  private destroyed(view: EditorView): boolean {
    return (view as unknown as { destroyed?: boolean }).destroyed === true;
  }
}
