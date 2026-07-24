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

  async engage(
    view: EditorView,
    path: string,
    serverUrl: string,
    auth: Auth,
    user: User,
  ): Promise<void> {
    await this.disengage();
    const gen = ++this.gen;

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

    const synced = await this.waitForSync(provider, 8000);
    if (this.gen !== gen || this.destroyed(view)) return;
    if (!synced) {
      new Notice("Live Presence: Co-Editing konnte nicht verbinden (Zeitüberschreitung).");
      await this.disengage();
      return;
    }

    // Seed or reconcile so editor and Y.Text match before binding.
    if (text.length === 0) {
      await sleep(400); // let peers announce themselves
      if (this.gen !== gen || this.destroyed(view)) return;
      const ids = [...provider.awareness.getStates().keys()];
      const lowest = ids.length === 0 || provider.awareness.clientID <= Math.min(...ids);
      if (text.length === 0 && lowest) {
        applyMinimalYTextUpdate(doc, text, normalizeLineEndings(view.state.doc.toString()));
      } else {
        for (let i = 0; i < 20 && text.length === 0; i++) {
          await sleep(100);
          if (this.gen !== gen || this.destroyed(view)) return;
        }
        applyMinimalCmUpdate(view, text.toString());
      }
    } else {
      applyMinimalCmUpdate(view, text.toString());
    }
    if (this.gen !== gen || this.destroyed(view)) return;

    provider.awareness.setLocalStateField("user", {
      name: user.name,
      color: user.color,
      colorLight: withAlpha(user.color, 0.25),
    });
    const ext = yCollab(text, provider.awareness, { undoManager: false });
    view.dispatch({
      effects: this.compartment.reconfigure(Array.isArray(ext) ? [...ext] : [ext]),
    });
    new Notice(`Live Presence: Co-Editing aktiv (${path}).`);
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
