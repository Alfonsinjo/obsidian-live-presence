import { EditorView } from "@codemirror/view";
import { MarkdownView, Notice, Plugin, type WorkspaceLeaf } from "obsidian";
import { CollabBinding } from "./collab/binding";
import { NameModal } from "./name-modal";
import { PresenceConnection } from "./presence";
import { fetchProfileName, saveProfileName } from "./profile";
import { type RemoteCursor, remoteCursorsField, setRemoteCursors } from "./remote-cursors";
import { ROSTER_VIEW_TYPE, RosterView } from "./roster-view";
import { LivePresenceSettingTab } from "./settings";
import { DEFAULT_SETTINGS, type LivePresenceSettings } from "./types";
import { colorFromName, debounce } from "./utils";

// Obsidian exposes the underlying CodeMirror 6 view as editor.cm (undocumented but stable).
function getCmView(view: MarkdownView): EditorView | undefined {
  return (view.editor as unknown as { cm?: EditorView }).cm;
}

export default class LivePresencePlugin extends Plugin {
  settings!: LivePresenceSettings;
  presence!: PresenceConnection;
  private binding = new CollabBinding();
  private coeditEngageTimer: number | null = null;
  private coeditDisengageTimer: number | null = null;
  private statusBarEl!: HTMLElement;
  // CodeMirror view of the file that currently has focus; used for cursor reporting.
  private activeCm: EditorView | null = null;
  // Full name resolved from the profile database.
  private displayName = "";

  private reportCursor = debounce((anchor: number, head: number, docLen: number) => {
    this.presence?.setCursor({ anchor, head, docLen });
  }, 80);

  async onload(): Promise<void> {
    await this.loadSettings();

    this.presence = new PresenceConnection(
      this.settings.serverUrl,
      this.effectiveUser(),
      this.effectiveAuth(),
    );
    this.presence.onChange(() => this.onPresenceChange());

    this.addSettingTab(new LivePresenceSettingTab(this.app, this));

    this.registerView(
      ROSTER_VIEW_TYPE,
      (leaf) =>
        new RosterView(
          leaf,
          () => this.presence.getAll(),
          () => this.presence.clientId,
          (path) => this.app.workspace.openLinkText(path, "", false),
        ),
    );

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("lp-statusbar");
    this.statusBarEl.onClickEvent(() => this.activateRoster());
    this.updateStatusBar();

    // Render remote cursors and report our own selection changes.
    const cursorReporter = EditorView.updateListener.of((update) => {
      if (update.view !== this.activeCm) return;
      if (!update.selectionSet && !update.docChanged) return;
      const sel = update.state.selection.main;
      this.reportCursor(sel.anchor, sel.head, update.state.doc.length);
    });
    this.registerEditorExtension([remoteCursorsField, cursorReporter, this.binding.baseExtension()]);

    this.addRibbonIcon("users", "Live Presence: Wer ist da?", () => this.activateRoster());
    this.addCommand({
      id: "lp-presence-open-roster",
      name: "Roster öffnen (wer ist gerade im Vault)",
      callback: () => this.activateRoster(),
    });

    this.app.workspace.onLayoutReady(() => {
      void this.startPresence(false);
    });

    this.registerEvent(this.app.workspace.on("file-open", () => this.updateActiveContext()));
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.updateActiveContext();
        this.onPresenceChange();
      }),
    );

    // Leave immediately on quit instead of waiting for the server-side timeout.
    this.registerDomEvent(window, "beforeunload", () => this.presence?.destroy());
  }

  onunload(): void {
    void this.binding.disengage();
    this.presence?.destroy();
  }

  // Start co-editing automatically when two or more people share the active file,
  // and stop shortly after fewer than two remain (grace period against tab switches).
  private evaluateCoedit(): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const cm = view ? getCmView(view) : undefined;
    const file = view?.file?.path ?? null;
    if (!this.settings.serverUrl || !file || !cm) return;

    const participants = this.presence.getAll().filter((e) => e.state.file === file).length;

    if (participants >= 2) {
      if (this.coeditDisengageTimer !== null) {
        window.clearTimeout(this.coeditDisengageTimer);
        this.coeditDisengageTimer = null;
      }
      if (!this.binding.isActive(file) && this.coeditEngageTimer === null) {
        this.coeditEngageTimer = window.setTimeout(() => {
          this.coeditEngageTimer = null;
          const v = this.app.workspace.getActiveViewOfType(MarkdownView);
          const c = v ? getCmView(v) : undefined;
          const f = v?.file?.path ?? null;
          if (
            f === file &&
            c &&
            !this.binding.isActive(f) &&
            this.presence.getAll().filter((e) => e.state.file === f).length >= 2
          ) {
            void this.binding.engage(
              c,
              f,
              this.settings.serverUrl,
              this.effectiveAuth(),
              this.effectiveUser(),
            );
          }
        }, 500);
      }
    } else if (this.binding.isActive(file) && this.coeditDisengageTimer === null) {
      this.coeditDisengageTimer = window.setTimeout(() => {
        this.coeditDisengageTimer = null;
        const p = this.binding.path;
        if (p && this.presence.getAll().filter((e) => e.state.file === p).length < 2) {
          void this.binding.disengage();
        }
      }, 5000);
    }
  }

  private effectiveUser(): { name: string; color: string } {
    const name = this.displayName || this.settings.userName || "Anonym";
    const color = this.settings.color || colorFromName(name);
    return { name, color };
  }

  private effectiveAuth(): { user: string; pass: string } {
    return { user: this.settings.authUser, pass: this.settings.authPass };
  }

  // Connect to the presence server. Resolves the display name from the profile
  // database first (asking for it once if it is not set yet).
  private async startPresence(withToast: boolean): Promise<void> {
    this.presence?.destroy();
    if (!this.settings.serverUrl) {
      new Notice("Live Presence: Bitte die Server-URL in den Einstellungen eintragen.");
      return;
    }
    this.displayName = await this.resolveDisplayName();
    this.presence = new PresenceConnection(
      this.settings.serverUrl,
      this.effectiveUser(),
      this.effectiveAuth(),
    );
    this.presence.onChange(() => this.onPresenceChange());

    if (withToast) {
      new Notice("Live Presence: Verbinde …");
      let settled = false;
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        new Notice(
          "Live Presence: Verbindung fehlgeschlagen (Zeitüberschreitung). Server-URL, Login und Netzwerk prüfen.",
        );
      }, 8000);
      this.presence.onStatus((status) => {
        if (settled) return;
        if (status === "connected") {
          settled = true;
          window.clearTimeout(timer);
          new Notice("Live Presence: Verbunden.");
        } else if (status === "error") {
          settled = true;
          window.clearTimeout(timer);
          new Notice(
            "Live Presence: Verbindung fehlgeschlagen. Login (Benutzer/Passwort), Server-URL und Netzwerk prüfen.",
          );
        }
      });
    }

    this.presence.connect();
    this.updateActiveContext();
  }

  private async resolveDisplayName(): Promise<string> {
    const { serverUrl, authUser, authPass } = this.settings;
    if (!serverUrl || !authUser || !authPass) {
      return this.settings.userName || "Anonym";
    }
    let name = await fetchProfileName(serverUrl, authUser, authPass);
    if (!name) {
      name = await this.promptName(this.settings.userName || "");
      if (name) {
        await saveProfileName(serverUrl, authUser, authPass, name);
        this.settings.userName = name;
        await this.saveData(this.settings);
      }
    }
    return name || this.settings.userName || "Anonym";
  }

  private promptName(initial: string): Promise<string> {
    return new Promise((resolve) => {
      new NameModal(this.app, initial, (name) => resolve(name)).open();
    });
  }

  // Change the stored full name (from settings).
  async changeName(): Promise<void> {
    const { serverUrl, authUser, authPass } = this.settings;
    const name = await this.promptName(this.displayName || this.settings.userName || "");
    if (!name) return;
    this.displayName = name;
    this.settings.userName = name;
    await this.saveData(this.settings);
    if (serverUrl && authUser && authPass) {
      await saveProfileName(serverUrl, authUser, authPass, name);
    }
    this.presence?.setUser(this.effectiveUser());
    new Notice(`Live Presence: Name gesetzt: ${name}`);
  }

  // Track the active file + editor and publish them.
  private updateActiveContext(): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const activePath = view?.file?.path ?? null;
    // Co-editing follows a single file; leaving it ends the session.
    if (this.binding.active && this.binding.path !== activePath) {
      void this.binding.disengage();
    }
    this.activeCm = view ? (getCmView(view) ?? null) : null;
    this.presence.setFile(activePath);
    if (view && this.activeCm) {
      const sel = this.activeCm.state.selection.main;
      this.presence.setCursor({
        anchor: sel.anchor,
        head: sel.head,
        docLen: this.activeCm.state.doc.length,
      });
    } else {
      this.presence.setCursor(null);
    }
    this.refreshRemoteCursors();
    this.evaluateCoedit();
  }

  private onPresenceChange(): void {
    this.updateStatusBar();
    this.refreshRemoteCursors();
    for (const leaf of this.app.workspace.getLeavesOfType(ROSTER_VIEW_TYPE)) {
      (leaf.view as RosterView).refresh();
    }
    this.evaluateCoedit();
  }

  private updateStatusBar(): void {
    const all = this.presence?.getAll() ?? [];
    const n = all.length;
    const online = this.presence?.isConnected() ?? false;
    this.statusBarEl.empty();
    const dot = this.statusBarEl.createSpan({ cls: "lp-roster-dot" });
    dot.style.backgroundColor = online ? "var(--color-green, #3ba55d)" : "var(--text-faint, #888)";
    this.statusBarEl.createSpan({ text: ` ${n} online` });
  }

  // Push the remote cursors of each file into its open editor(s).
  private refreshRemoteCursors(): void {
    const remotes = this.presence?.getRemotes() ?? [];
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view as MarkdownView;
      const cm = getCmView(view);
      if (!cm) continue;
      const file = view.file?.path ?? null;
      // While co-editing a file, yCollab draws the cursors, so suppress ours there.
      if (file && this.binding.isActive(file)) {
        cm.dispatch({ effects: setRemoteCursors.of([]) });
        continue;
      }
      const cursors: RemoteCursor[] = [];
      if (file) {
        for (const r of remotes) {
          if (r.state.file === file && r.state.cursor) {
            cursors.push({
              name: r.state.user.name || "Anonym",
              color: r.state.user.color,
              anchor: r.state.cursor.anchor,
              head: r.state.cursor.head,
            });
          }
        }
      }
      cm.dispatch({ effects: setRemoteCursors.of(cursors) });
    }
  }

  async activateRoster(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(ROSTER_VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf: WorkspaceLeaf | null = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: ROSTER_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  reconnect(): void {
    void this.startPresence(true);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.presence?.setUser(this.effectiveUser());
  }
}
