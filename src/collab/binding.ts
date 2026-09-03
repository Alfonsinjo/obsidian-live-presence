import { Compartment, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { Notice } from "obsidian";
import { yCollab } from "y-codemirror.next";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { listChangelog, reconstructBase } from "../changelog";
import { logProblem } from "../logger";
import { type MergeResult, mergeThreeWay } from "../merge";
import {
  applyMinimalCmUpdate,
  applyMinimalYTextUpdate,
  hashString,
  normalizeLineEndings,
  registerAuthor,
  sleep,
  withAlpha,
} from "../utils";

interface Auth {
  user: string;
  pass: string;
}
interface User {
  name: string;
  color: string;
}

type ConflictResolver = (path: string, result: MergeResult) => Promise<"mine" | "theirs">;
type BaseHashLookup = (path: string) => string | undefined;

// Binds one file's editor to a shared Y.Text so edits are character-by-character
// real-time with correct (relative-position) remote cursors. One file at a time.
export class CollabBinding {
  private compartment = new Compartment();
  private doc: Y.Doc | null = null;
  private provider: WebsocketProvider | null = null;
  private view: EditorView | null = null;
  path: string | null = null;
  private gen = 0;

  private user: User | null = null;
  private onConflict: ConflictResolver | null = null;
  private serverUrl = "";
  private auth: Auth | null = null;
  private getBaseHash: BaseHashLookup | null = null;

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
    onConflict?: ConflictResolver,
    getBaseHash?: BaseHashLookup,
  ): Promise<void> {
    await this.disengage();
    const gen = ++this.gen;

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
      this.user = user;
      this.onConflict = onConflict ?? null;
      this.serverUrl = serverUrl;
      this.auth = auth;
      this.getBaseHash = getBaseHash ?? null;

      const synced = await this.waitForSync(provider, 8000);
      if (this.gen !== gen || this.destroyed(view)) return;
      if (!synced) {
        logProblem("error", "Co-Editing Zeitüberschreitung", {
          path,
          wsconnected: provider.wsconnected,
          online: navigator.onLine,
        });
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
      registerAuthor(doc, user);

      // Reconcile editor <-> shared text. CRITICAL: never clear a non-empty
      // editor and never blindly overwrite local edits.
      const local = normalizeLineEndings(view.state.doc.toString());
      const remote0 = text.toString();
      if (remote0 === local) {
        // Already identical: nothing to reconcile.
      } else if (remote0.length === 0 && local.length > 0) {
        // Shared text is empty but we have content. Wait briefly for a peer to seed it,
        // then adopt; otherwise seed from our own content. Never wipe the editor.
        await sleep(400);
        if (this.gen !== gen || this.destroyed(view)) return;
        const self = provider.awareness.clientID;
        const others = [...provider.awareness.getStates().keys()].filter((id) => id !== self);
        const iSeed = others.length === 0 || self <= Math.min(...others);
        if (!iSeed) {
          for (let i = 0; i < 25 && text.length === 0; i++) {
            await sleep(100);
            if (this.gen !== gen || this.destroyed(view)) return;
          }
        }
        if (text.length > 0) applyMinimalCmUpdate(view, text.toString());
        else applyMinimalYTextUpdate(doc, text, local);
      } else if (local.length === 0) {
        // Editor empty, shared has content -> adopt it.
        applyMinimalCmUpdate(view, remote0);
      } else {
        // Both sides have content and differ. Do NOT overwrite: line-merge
        // against the last-synced base (which may have diverged while this note
        // was edited elsewhere or closed here), then publish the result.
        const base = await this.resolveBase(path, local, remote0);
        if (this.gen !== gen || this.destroyed(view)) return;
        const merged = await this.mergeShared(path, base, local, remote0);
        if (this.gen !== gen || this.destroyed(view)) return;
        applyMinimalCmUpdate(view, merged);
        applyMinimalYTextUpdate(doc, text, merged);
      }
      if (this.gen !== gen || this.destroyed(view)) return;

      this.bindEditor();
      // A dropped connection needs no special handling: editing is locked while
      // offline (a connection is required to write), so nothing diverges and
      // Yjs resynchronises cleanly on its own when the socket returns.
    } catch (err) {
      logProblem("error", "Co-Editing Fehler", { path, err: String(err) });
      new Notice("Live Presence: Co-Editing-Fehler.");
      await this.disengage();
    }
  }

  // Attach yCollab (editor <-> shared text, remote cursors).
  private bindEditor(): void {
    const view = this.view;
    const provider = this.provider;
    const doc = this.doc;
    if (!view || !provider || !doc || this.destroyed(view)) return;
    const ext = yCollab(doc.getText("content"), provider.awareness, { undoManager: false });
    view.dispatch({
      effects: this.compartment.reconfigure(Array.isArray(ext) ? [...ext] : [ext]),
    });
  }

  // Recover the common ancestor for an engage-time divergence from the change
  // log, using the last-synced base hash. Empty string if it cannot be found
  // (a full-file conflict, resolved losslessly, is better than an overwrite).
  private async resolveBase(path: string, local: string, remote: string): Promise<string> {
    const baseHash = this.getBaseHash?.(path);
    if (baseHash === undefined) return "";
    if (hashString(local) === baseHash) return local; // our copy is the ancestor
    if (hashString(remote) === baseHash) return remote; // shared copy is the ancestor
    if (!this.auth) return "";
    const entries = await listChangelog(this.serverUrl, this.auth, path);
    return reconstructBase(entries, baseHash) ?? "";
  }

  // Three-way line merge shared by engage-time and reconnect-time reconciliation.
  // Clean merges combine both sides; overlapping (same-line) changes ask the user
  // which side to keep and write it cleanly (never markers, never duplicates).
  private async mergeShared(
    path: string,
    base: string,
    local: string,
    remote: string,
  ): Promise<string> {
    if (remote === local) return local;
    const probe = mergeThreeWay(base, local, remote, "detect");
    if (probe.conflicts.length === 0) return probe.text;
    if (this.onConflict) {
      const action = await this.onConflict(path, probe);
      return mergeThreeWay(base, local, remote, action === "theirs" ? "theirs" : "mine").text;
    }
    return mergeThreeWay(base, local, remote, "mine").text;
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
    this.user = null;
    this.onConflict = null;

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
