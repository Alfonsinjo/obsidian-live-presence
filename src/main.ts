import { EditorView } from "@codemirror/view";
import { MarkdownView, Notice, Plugin, type WorkspaceLeaf } from "obsidian";
import { type AuthorRun, readAuthorRuns } from "./blame";
import { BlameModal } from "./blame-modal";
import { type Frame, buildFrames, listChangelog } from "./changelog";
import { CollabBinding } from "./collab/binding";
import { diffLines } from "./history";
import { SessionTimelineModal } from "./session-modal";
import { type HiddenRange, type OverlayRun, inlineOverlayExtension, setOverlay } from "./inline-overlay";
import { NameModal } from "./name-modal";
import { PresenceConnection } from "./presence";
import { fetchProfileName, saveProfileName } from "./profile";
import { type RemoteCursor, remoteCursorsField, setRemoteCursors } from "./remote-cursors";
import { ROSTER_VIEW_TYPE, RosterView } from "./roster-view";
import { LivePresenceSettingTab } from "./settings";
import { VaultSync } from "./sync/vault-sync";
import { DEFAULT_SETTINGS, type LivePresenceSettings } from "./types";
import { colorFromName, debounce, sleep, withAlpha } from "./utils";

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
  private overlayMode: "authors" | "asof" | null = null;
  // Cached reconstructed frames and author runs of the current note, for the
  // timeline scrubber and author colouring.
  private framesCache: { path: string; frames: Frame[]; authorRuns: AuthorRun[] | null } | null = null;

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
          onOpenHistory: () => this.showHistory(),
          onToggleAuthors: () => void this.toggleAuthorsOverlay(),
          onClearOverlay: () => this.clearOverlay(),
          overlayInfo: () => this.overlayInfo(),
          loadFrames: (path) => this.loadFrames(path),
          onScrubTo: (index) => this.showAsOfOverlay(index),
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

  // Load and cache the reconstructed timeline frames for a note; returns the
  // timestamp of each frame for the sidebar scrubber labels.
  private async loadFrames(path: string): Promise<number[]> {
    if (!this.settings.serverUrl) {
      this.framesCache = null;
      return [];
    }
    const auth = this.effectiveAuth();
    const entries = await listChangelog(this.settings.serverUrl, auth, path);
    const frames = buildFrames(entries);
    const authorRuns = await readAuthorRuns(this.settings.serverUrl, auth, path);
    this.framesCache = { path, frames, authorRuns };
    return frames.map((f) => f.t);
  }

  // Map author runs to coloured overlay runs, aligned to the editor by length.
  private buildAuthorOverlay(
    authorRuns: AuthorRun[],
    docLen: number,
  ): { runs: OverlayRun[]; legend: { label: string; color: string }[] } | null {
    const total = authorRuns.reduce((n, r) => n + r.text.length, 0);
    if (total !== docLen) return null;
    let pos = 0;
    const runs: OverlayRun[] = [];
    const legend = new Map<string, string>();
    for (const r of authorRuns) {
      const from = pos;
      const to = pos + r.text.length;
      pos = to;
      if (to > from) runs.push({ from, to, color: withAlpha(r.color, 0.28), label: r.name });
      if (!legend.has(r.name)) legend.set(r.name, r.color);
    }
    return { runs, legend: [...legend].map(([label, color]) => ({ label, color })) };
  }

  // Remove the hidden ranges from the coloured runs, so background colouring and
  // collapsed (hidden) text never overlap.
  private clipRuns(runs: OverlayRun[], hidden: HiddenRange[]): OverlayRun[] {
    const out: OverlayRun[] = [];
    for (const run of runs) {
      let cursor = run.from;
      for (const h of hidden) {
        if (h.to <= cursor) continue;
        if (h.from >= run.to) break;
        const visTo = Math.min(h.from, run.to);
        if (visTo > cursor) out.push({ ...run, from: cursor, to: visTo });
        cursor = Math.min(h.to, run.to);
        if (cursor >= run.to) break;
      }
      if (cursor < run.to) out.push({ ...run, from: cursor, to: run.to });
    }
    return out;
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
      if (leaf.view instanceof RosterView) leaf.view.refreshVersions();
    }
  }

  overlayInfo(): { mode: "authors" | "asof" | null } {
    return { mode: this.overlayMode };
  }

  clearOverlay(): void {
    this.activeCmView()?.dispatch({ effects: setOverlay.of(null) });
    this.overlayMode = null;
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
    const cm = this.activeCmView();
    if (!cm) {
      if (!silent) new Notice("Live Presence: Keine aktive Notiz.");
      return;
    }
    // The authorship comes from the shared document; align it to the editor by
    // length. Retry once in case the document is still catching up.
    let runs = null as Awaited<ReturnType<typeof readAuthorRuns>>;
    let aligned = false;
    for (let attempt = 0; attempt < 2 && !aligned; attempt++) {
      if (attempt > 0) await sleep(700);
      runs = await readAuthorRuns(this.settings.serverUrl, this.effectiveAuth(), path);
      if (!runs) {
        if (!silent) new Notice("Live Presence: Nicht mit dem Server verbunden.");
        return;
      }
      const total = runs.reduce((n, r) => n + r.text.length, 0);
      aligned = total === cm.state.doc.length;
    }
    if (!runs || !aligned) {
      if (!silent) new Notice("Live Presence: Autoren konnten nicht zugeordnet werden (Text nicht synchron).");
      return;
    }
    const built = this.buildAuthorOverlay(runs, cm.state.doc.length);
    if (!built) {
      if (!silent) new Notice("Live Presence: Autoren konnten nicht zugeordnet werden (Text nicht synchron).");
      return;
    }
    cm.dispatch({
      effects: setOverlay.of({ runs: built.runs, hidden: [], legend: built.legend, title: "Autoren" }),
    });
    this.overlayMode = "authors";
    this.refreshRosters();
  }

  // Show the document as of the frame at the given index: hide the lines added
  // after that time and colour the remaining text by author. Driven by the
  // sidebar scrubber, so it does not re-render the sidebar.
  showAsOfOverlay(index: number): void {
    const cm = this.activeCmView();
    const cache = this.framesCache;
    if (!cm || !cache || cache.path !== this.activePath()) return;
    if (index < 0 || index >= cache.frames.length) return;
    if (index >= cache.frames.length - 1) {
      cm.dispatch({ effects: setOverlay.of(null) }); // "now": nothing to hide
      this.overlayMode = null;
      return;
    }
    const hidden = this.addedLineRanges(cache.frames[index].text, cm.state.doc.toString());
    let runs: OverlayRun[] = [];
    let legend: { label: string; color: string }[] = [];
    if (cache.authorRuns) {
      const built = this.buildAuthorOverlay(cache.authorRuns, cm.state.doc.length);
      if (built) {
        runs = this.clipRuns(built.runs, hidden);
        legend = built.legend;
      }
    }
    cm.dispatch({
      effects: setOverlay.of({
        runs,
        hidden,
        legend,
        title: `Stand: ${new Date(cache.frames[index].t).toLocaleString()}`,
      }),
    });
    this.overlayMode = "asof";
  }

  // Ranges (including the trailing newline) of lines present in the current text
  // but not in the old one, i.e. added later and to be hidden for an older view.
  private addedLineRanges(oldText: string, newText: string): HiddenRange[] {
    const lines = newText.split("\n");
    const starts: number[] = [];
    let off = 0;
    for (const line of lines) {
      starts.push(off);
      off += line.length + 1;
    }
    const docLen = newText.length;
    const ops = diffLines(oldText, newText);
    const hidden: HiddenRange[] = [];
    let j = 0;
    for (const op of ops) {
      if (op.type === "removed") continue;
      if (op.type === "added") {
        const from = starts[j];
        const to = Math.min(from + (lines[j]?.length ?? 0) + 1, docLen);
        if (to > from) hidden.push({ from, to });
      }
      j++;
    }
    return hidden;
  }

  private reapplyOverlayOnLeafChange(): void {
    this.framesCache = null; // frames are per note
    if (!this.overlayMode) return;
    if (!this.activePath() || this.overlayMode === "asof") {
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
