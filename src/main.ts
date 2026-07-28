import { EditorView } from "@codemirror/view";
import { MarkdownView, Notice, Plugin, TFile, type WorkspaceLeaf } from "obsidian";
import { readAuthorRuns } from "./blame";
import { BlameModal } from "./blame-modal";
import { CollabBinding } from "./collab/binding";
import { diffLines, listVersions, saveVersion as storeVersion } from "./history";
import { SessionTimelineModal } from "./session-modal";
import { type OverlayRun, inlineOverlayExtension, setOverlay } from "./inline-overlay";
import { PlaybackModal } from "./playback-modal";
import { NameModal } from "./name-modal";
import { PresenceConnection } from "./presence";
import { fetchProfileName, saveProfileName } from "./profile";
import { type RemoteCursor, remoteCursorsField, setRemoteCursors } from "./remote-cursors";
import { ROSTER_VIEW_TYPE, RosterView } from "./roster-view";
import { LivePresenceSettingTab } from "./settings";
import { VaultSync } from "./sync/vault-sync";
import { DEFAULT_SETTINGS, type LivePresenceSettings } from "./types";
import { colorFromName, debounce, normalizeLineEndings, withAlpha } from "./utils";

// Obsidian exposes the underlying CodeMirror 6 view as editor.cm (undocumented but stable).
function getCmView(view: MarkdownView): EditorView | undefined {
  return (view.editor as unknown as { cm?: EditorView }).cm;
}

export default class LivePresencePlugin extends Plugin {
  settings!: LivePresenceSettings;
  presence!: PresenceConnection;
  private binding = new CollabBinding();
  private vaultSync: VaultSync | null = null;
  private coeditEngageTimer: number | null = null;
  private coeditDisengageTimer: number | null = null;
  private statusBarEl!: HTMLElement;
  // CodeMirror view of the file that currently has focus; used for cursor reporting.
  private activeCm: EditorView | null = null;
  // Full name resolved from the profile database.
  private displayName = "";
  // In-editor history overlay state.
  private overlayMode: "authors" | "since" | null = null;
  private overlaySinceT: number | null = null;

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
        new RosterView(leaf, {
          getEntries: () => this.presence.getAll(),
          getSelfId: () => this.presence.clientId,
          onOpenFile: (path) => this.app.workspace.openLinkText(path, "", false),
          getActivePath: () => this.activePath(),
          loadVersions: (path) => this.loadVersions(path),
          onSaveVersion: () => this.saveVersion(),
          onOpenHistory: () => this.showHistory(),
          onOpenPlayback: () => this.showPlayback(),
          onToggleAuthors: () => void this.toggleAuthorsOverlay(),
          onShowSince: (t) => void this.showSinceOverlay(t),
          onClearOverlay: () => this.clearOverlay(),
          overlayInfo: () => this.overlayInfo(),
        }),
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
    this.registerEditorExtension([
      remoteCursorsField,
      cursorReporter,
      this.binding.baseExtension(),
      inlineOverlayExtension(),
    ]);

    this.addRibbonIcon("users", "Live Presence: Wer ist da?", () => this.activateRoster());
    this.addCommand({
      id: "lp-presence-open-roster",
      name: "Roster öffnen (wer ist gerade im Vault)",
      callback: () => this.activateRoster(),
    });
    this.addRibbonIcon("history", "Live Presence: Autoren dieser Notiz", () => this.showBlame());
    this.addCommand({
      id: "lp-show-blame",
      name: "Autoren dieser Notiz anzeigen (wer hat was geschrieben)",
      callback: () => this.showBlame(),
    });
    this.addRibbonIcon("git-compare", "Live Presence: Verlauf dieser Notiz", () => this.showHistory());
    this.addCommand({
      id: "lp-show-history",
      name: "Verlauf dieser Notiz anzeigen (Versionen und Änderungen)",
      callback: () => this.showHistory(),
    });
    this.addCommand({
      id: "lp-save-version",
      name: "Version dieser Notiz merken",
      callback: () => this.saveVersion(),
    });
    this.addCommand({
      id: "lp-playback",
      name: "Wiedergabe dieser Notiz (Verlauf über die Zeit)",
      callback: () => this.showPlayback(),
    });

    this.app.workspace.onLayoutReady(() => {
      void this.startPresence();
    });

    this.registerEvent(this.app.workspace.on("file-open", () => this.updateActiveContext()));
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.updateActiveContext();
        this.onPresenceChange();
        this.reapplyOverlayOnLeafChange();
      }),
    );

    // When the active file is renamed, move the co-editing session to the new path
    // so the local editor keeps following instead of dropping out.
    this.registerEvent(
      this.app.vault.on("rename", (_file, oldPath) => {
        if (this.binding.path === oldPath) {
          void this.binding.disengage().then(() => this.evaluateCoedit());
        }
      }),
    );

    // Leave immediately on quit instead of waiting for the server-side timeout.
    this.registerDomEvent(window, "beforeunload", () => this.presence?.destroy());
  }

  onunload(): void {
    this.vaultSync?.stop();
    void this.binding.disengage();
    this.presence?.destroy();
  }

  // Start co-editing automatically when two or more people share the active file,
  // and stop shortly after fewer than two remain (grace period against tab switches).
  private isExcalidraw(view: MarkdownView): boolean {
    const path = view.file?.path ?? "";
    if (/\.excalidraw(\.md)?$/i.test(path)) return true;
    const fm = view.file ? this.app.metadataCache.getFileCache(view.file)?.frontmatter : null;
    return fm != null && fm["excalidraw-plugin"] != null;
  }

  private evaluateCoedit(): void {
    if (!this.settings.enableCoedit) {
      if (this.binding.active) void this.binding.disengage();
      return;
    }
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const cm = view ? getCmView(view) : undefined;
    const file = view?.file?.path ?? null;
    if (!this.settings.serverUrl || !file || !cm || !view) return;
    // Never co-edit Excalidraw notes: their body is a machine-managed data block.
    if (this.isExcalidraw(view)) {
      if (this.binding.isActive(file)) void this.binding.disengage();
      return;
    }

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
  private async startPresence(): Promise<void> {
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

    // Report the connection outcome: a green success notice when connected (on
    // startup as well as on manual connect), and a clear notice when the server
    // cannot be reached. A short poll covers a status event we might have missed.
    {
      new Notice("Live Presence: Versuche Verbindung zur Datenbank aufzubauen …");
      let settled = false;
      const succeed = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        const n = new Notice("Erfolgreich mit Live Presence verbunden");
        n.noticeEl.addClass("lp-notice-success");
      };
      const fail = (msg: string) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        new Notice(msg);
      };
      const timer = window.setTimeout(
        () =>
          fail(
            "Live Presence: Keine Verbindung zum Server (Zeitüberschreitung). Server-URL, Login und Netzwerk prüfen.",
          ),
        8000,
      );
      this.presence.onStatus((status) => {
        if (status === "connected") succeed();
        else if (status === "error")
          fail(
            "Live Presence: Keine Verbindung zum Server. Login (Benutzer/Passwort), Server-URL und Netzwerk prüfen.",
          );
      });
      this.presence.connect();
      window.setTimeout(() => {
        if (this.presence?.isConnected()) succeed();
      }, 1500);
    }

    this.updateActiveContext();
    this.restartVaultSync();
  }

  // Start (or restart) whole-vault synchronisation when it is enabled.
  private restartVaultSync(): void {
    this.vaultSync?.stop();
    this.vaultSync = null;
    if (!this.settings.enableVaultSync || !this.settings.serverUrl || !this.settings.authUser) return;
    this.vaultSync = new VaultSync(
      this.app,
      this.settings.serverUrl,
      this.effectiveAuth(),
      (path) => this.binding.isActive(path),
      () => this.effectiveUser(),
      () => {}, // logging silenced for normal operation
    );
    void this.vaultSync.start();
  }

  private async resolveDisplayName(): Promise<string> {
    const { serverUrl, authUser, authPass } = this.settings;
    if (!serverUrl || !authUser || !authPass) {
      return this.settings.userName || "Anonym";
    }
    const res = await fetchProfileName(serverUrl, authUser, authPass);

    // Server knows our name: adopt it (and cache locally).
    if (res.reachable && res.name) {
      if (res.name !== this.settings.userName) {
        this.settings.userName = res.name;
        await this.saveSettings();
      }
      return res.name;
    }

    // If we already have a locally stored name, use it and never ask again just
    // because the server is offline; push it up when the server is reachable.
    if (this.settings.userName) {
      if (res.reachable) void saveProfileName(serverUrl, authUser, authPass, this.settings.userName);
      return this.settings.userName;
    }

    // No name anywhere yet: ask once, store locally, and store on the server if reachable.
    const name = await this.promptName("");
    if (name) {
      this.settings.userName = name;
      await this.saveSettings();
      if (res.reachable) void saveProfileName(serverUrl, authUser, authPass, name);
    }
    return name || "Anonym";
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
      // Sidebar views can be deferred (Obsidian 1.7+); only refresh a real roster view.
      if (leaf.view instanceof RosterView) leaf.view.refresh();
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

  private showBlame(): void {
    const path = this.activePath();
    if (!path) {
      new Notice("Live Presence: Keine aktive Notiz.");
      return;
    }
    if (!this.settings.serverUrl) {
      new Notice("Live Presence: Bitte die Server-URL in den Einstellungen eintragen.");
      return;
    }
    new BlameModal(this.app, this.settings.serverUrl, this.effectiveAuth(), path).open();
  }

  // Path of the current note (Markdown only), even when a sidebar has focus.
  private activePath(): string | null {
    const file = this.app.workspace.getActiveFile();
    return file && file.extension === "md" ? file.path : null;
  }

  private async loadVersions(path: string): Promise<{ t: number; by: string }[]> {
    if (!this.settings.serverUrl) return [];
    const versions = await listVersions(this.settings.serverUrl, this.effectiveAuth(), path);
    return versions.map((v) => ({ t: v.t, by: v.by }));
  }

  // Editor of the current note, found by file rather than focus, so it also
  // works when a sidebar (roster) currently holds the focus.
  private activeCmView(): EditorView | undefined {
    const path = this.activePath();
    if (!path) return undefined;
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view as MarkdownView;
      if (view.file?.path === path) return getCmView(view);
    }
    return undefined;
  }

  private refreshRosters(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(ROSTER_VIEW_TYPE)) {
      if (leaf.view instanceof RosterView) leaf.view.refresh();
    }
  }

  overlayInfo(): { mode: "authors" | "since" | null; sinceT: number | null } {
    return { mode: this.overlayMode, sinceT: this.overlaySinceT };
  }

  clearOverlay(): void {
    this.activeCmView()?.dispatch({ effects: setOverlay.of(null) });
    this.overlayMode = null;
    this.overlaySinceT = null;
    this.refreshRosters();
  }

  async toggleAuthorsOverlay(): Promise<void> {
    if (this.overlayMode === "authors") {
      this.clearOverlay();
      return;
    }
    await this.applyAuthorsOverlay(false);
  }

  private async applyAuthorsOverlay(silent: boolean): Promise<void> {
    const path = this.activePath();
    if (!path || !this.settings.serverUrl) {
      if (!silent) new Notice("Live Presence: Keine aktive Notiz.");
      return;
    }
    const runs = await readAuthorRuns(this.settings.serverUrl, this.effectiveAuth(), path);
    if (!runs) {
      if (!silent) new Notice("Live Presence: Nicht mit dem Server verbunden.");
      return;
    }
    const cm = this.activeCmView();
    const total = runs.reduce((n, r) => n + r.text.length, 0);
    if (!cm || total !== cm.state.doc.length) {
      if (!silent) new Notice("Live Presence: Text noch nicht synchron – kurz warten und erneut versuchen.");
      return;
    }
    let pos = 0;
    const oruns: OverlayRun[] = [];
    const legend = new Map<string, string>();
    for (const r of runs) {
      const from = pos;
      const to = pos + r.text.length;
      pos = to;
      if (to > from) oruns.push({ from, to, color: withAlpha(r.color, 0.28), label: r.name });
      if (!legend.has(r.name)) legend.set(r.name, r.color);
    }
    cm.dispatch({
      effects: setOverlay.of({
        runs: oruns,
        legend: [...legend].map(([label, color]) => ({ label, color })),
        title: "Autoren",
      }),
    });
    this.overlayMode = "authors";
    this.overlaySinceT = null;
    this.refreshRosters();
  }

  async showSinceOverlay(t: number): Promise<void> {
    const path = this.activePath();
    if (!path || !this.settings.serverUrl) {
      new Notice("Live Presence: Keine aktive Notiz.");
      return;
    }
    const versions = await listVersions(this.settings.serverUrl, this.effectiveAuth(), path);
    const version = versions.find((v) => v.t === t);
    const cm = this.activeCmView();
    if (!version || !cm) {
      new Notice("Live Presence: Version nicht gefunden.");
      return;
    }
    const green = "#2ea043";
    const runs = this.addedRanges(version.text, cm.state.doc.toString(), withAlpha(green, 0.3));
    cm.dispatch({
      effects: setOverlay.of({
        runs,
        legend: [{ label: `neu seit ${new Date(t).toLocaleString()}`, color: green }],
        title: "Änderungen",
      }),
    });
    this.overlayMode = "since";
    this.overlaySinceT = t;
    this.refreshRosters();
  }

  // Character ranges of lines present in the current text but not in the old one.
  private addedRanges(oldText: string, newText: string, color: string): OverlayRun[] {
    const lines = newText.split("\n");
    const starts: number[] = [];
    let off = 0;
    for (const line of lines) {
      starts.push(off);
      off += line.length + 1;
    }
    const ops = diffLines(oldText, newText);
    const runs: OverlayRun[] = [];
    let j = 0;
    for (const op of ops) {
      if (op.type === "removed") continue;
      if (op.type === "added") {
        const from = starts[j];
        const to = from + (lines[j]?.length ?? 0);
        if (to > from) runs.push({ from, to, color, label: "neu" });
      }
      j++;
    }
    return runs;
  }

  private reapplyOverlayOnLeafChange(): void {
    if (!this.overlayMode) return;
    if (!this.activePath() || this.overlayMode === "since") {
      this.clearOverlay();
      return;
    }
    void this.applyAuthorsOverlay(true);
  }

  private showHistory(): void {
    const path = this.activePath();
    if (!path) {
      new Notice("Live Presence: Keine aktive Notiz.");
      return;
    }
    if (!this.settings.serverUrl) {
      new Notice("Live Presence: Bitte die Server-URL in den Einstellungen eintragen.");
      return;
    }
    new SessionTimelineModal(this.app, this.settings.serverUrl, this.effectiveAuth(), path).open();
  }

  private showPlayback(): void {
    const path = this.activePath();
    if (!path || !this.settings.serverUrl) {
      new Notice("Live Presence: Keine aktive Notiz oder Server-URL fehlt.");
      return;
    }
    new PlaybackModal(this.app, this.settings.serverUrl, this.effectiveAuth(), path).open();
  }

  private async saveVersion(): Promise<void> {
    const path = this.activePath();
    const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
    if (!(file instanceof TFile) || !this.settings.serverUrl) {
      new Notice("Live Presence: Keine aktive Notiz oder Server-URL fehlt.");
      return;
    }
    const text = normalizeLineEndings(await this.app.vault.read(file));
    const ok = await storeVersion(
      this.settings.serverUrl,
      this.effectiveAuth(),
      file.path,
      this.effectiveUser().name,
      text,
    );
    new Notice(ok ? "Live Presence: Version gemerkt." : "Live Presence: Version konnte nicht gespeichert werden.");
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
    void this.startPresence();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.presence?.setUser(this.effectiveUser());
  }
}
