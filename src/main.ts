import { EditorView } from "@codemirror/view";
import { MarkdownView, Notice, Plugin, type WorkspaceLeaf, requestUrl } from "obsidian";
import { listChangelog } from "./changelog";
import { CollabBinding } from "./collab/binding";
import { ExcalidrawBinding, websocketConnector } from "./collab/excalidraw-binding";
import { activeDrawingView, createSceneHost } from "./collab/excalidraw-host";
import { ConflictInfoModal } from "./conflict-info-modal";
import { editingLockExtension, setEditingOnline } from "./editing-lock";
import { configureLogger, logProblem } from "./logger";
import { UpdateModal } from "./update-modal";
import { type VersionInfo, fetchRequiredVersion, isOutdated } from "./version";
import { type DayInfo, type TimedRun, reconstructHistory } from "./history-blame";
import { blameFromDoc, buildLiveBlame } from "./history-live";
import { type OverlayRun, inlineOverlayExtension, setOverlay } from "./inline-overlay";
import { NameModal } from "./name-modal";
import { PresenceConnection } from "./presence";
import { ProblemModal } from "./problem-modal";
import { fetchProfileName, saveProfileName } from "./profile";
import { type RemoteCursor, remoteCursorsField, setRemoteCursors } from "./remote-cursors";
import { ROSTER_VIEW_TYPE, RosterView } from "./roster-view";
import { LivePresenceSettingTab } from "./settings";
import { VaultSync } from "./sync/vault-sync";
import { DEFAULT_SETTINGS, type LivePresenceSettings } from "./types";
import { colorFromName, debounce, withAlpha } from "./utils";

// Release source for the in-place self-update (same repository BRAT installs from).
const UPDATE_REPO = "Alfonsinjo/obsidian-live-presence";

// Obsidian exposes the underlying CodeMirror 6 view as editor.cm (undocumented but stable).
function getCmView(view: MarkdownView): EditorView | undefined {
  return (view.editor as unknown as { cm?: EditorView }).cm;
}

export default class LivePresencePlugin extends Plugin {
  settings!: LivePresenceSettings;
  presence!: PresenceConnection;
  private binding = new CollabBinding();
  // Real-time co-editing for Excalidraw drawings. A drawing is not text in an
  // editor, so it cannot use the CodeMirror binding above: its scene is shared
  // element by element in its own room (see collab/excalidraw-binding.ts).
  private excalBinding = new ExcalidrawBinding(
    (room, auth) => websocketConnector(this.settings.serverUrl)(room, auth),
    (level, msg, ctx) => logProblem(level, msg, ctx),
  );
  private drawingEngageTimer: number | null = null;
  private vaultSync: VaultSync | null = null;
  private coeditEngageTimer: number | null = null;
  private statusBarEl!: HTMLElement;
  // Fixed banner shown in every view (top-right) while the connection is down.
  private offlineBanner: HTMLElement | null = null;
  private offlineShowTimer: number | null = null;
  private offlineBannerVisible = false;
  // Offline/verification state: editing stays locked while offline and during a
  // short verification window after reconnecting (so the note is re-synced from
  // the server before writing resumes).
  private lockedOffline = true;
  private hasConnected = false;
  private verifyTimer: number | null = null;
  private verifyNotice: Notice | null = null;
  // Set when the client is older than the server-required version: the tool is
  // locked and an update modal is shown until the user updates.
  private versionBlocked = false;
  private updateModalOpen = false;
  // CodeMirror view of the file that currently has focus; used for cursor reporting.
  private activeCm: EditorView | null = null;
  // Last opened markdown note, so the sidebar keeps showing it even when the
  // sidebar itself (a non-note view) is focused.
  private lastMarkdownPath: string | null = null;
  // Note the sidebar version section was last rendered for, so it is only
  // re-rendered when the note actually changes - not on every focus change,
  // which would recreate its buttons mid-click and swallow the first click.
  private lastVersionPath: string | null = null;
  private lastOverlayPath: string | null = null;
  // Full name resolved from the profile database.
  private displayName = "";
  // In-editor history overlay state.
  private overlayMode: "authors" | "day" | null = null;
  private overlayDay: string | null = null;
  // Cached time-aware blame of the current note (per-author, per-day runs).
  private historyCache: { path: string; runs: TimedRun[]; days: DayInfo[] } | null = null;

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
          onToggleAuthors: () => void this.toggleAuthorsOverlay(),
          onClearOverlay: () => this.clearOverlay(),
          overlayInfo: () => this.overlayInfo(),
          loadDays: (path) => this.loadHistory(path),
          onSelectDay: (day) => void this.showDayOverlay(day),
          onReportProblem: () =>
            new ProblemModal(this.app, this.manifest.version, this.effectiveUser().name).open(),
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
      editingLockExtension(),
    ]);

    this.addRibbonIcon("users", "Live Presence: Wer ist da?", () => this.activateRoster());
    this.addCommand({
      id: "lp-presence-open-roster",
      name: "Roster öffnen (wer ist gerade im Vault)",
      callback: () => this.activateRoster(),
    });
    this.addCommand({
      id: "lp-toggle-authors",
      name: "Autoren im Text ein-/ausblenden (wer hat was geschrieben)",
      callback: () => void this.toggleAuthorsOverlay(),
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
        // A drawing room is keyed by path, so a rename ends the old session and
        // starts one for the new path. Going through endDrawingSession keeps the
        // last strokes: a plain disengage would drop whatever was still inside
        // the publish interval.
        if (this.excalBinding.path === oldPath) {
          void this.endDrawingSession().then(() => this.evaluateDrawingCoedit());
        }
      }),
    );

    // Leave immediately on quit instead of waiting for the server-side timeout.
    this.registerDomEvent(window, "beforeunload", () => this.presence?.destroy());

    // Detect a dropped connection quickly: the browser's offline event fires the
    // moment the network is gone (instant lock), and a short heartbeat catches an
    // unreachable server before the WebSocket's own long timeout would.
    this.registerDomEvent(window, "offline", () => this.setOffline(true));
    this.registerDomEvent(window, "online", () => void this.heartbeat());
    this.registerInterval(window.setInterval(() => void this.heartbeat(), 5000));
    // Pick up a newly required version even while Obsidian keeps running.
    this.registerInterval(window.setInterval(() => void this.enforceVersion(), 60000));
    // An Excalidraw view becomes usable asynchronously and fires no workspace
    // event when it does, so the drawing session is re-evaluated periodically.
    this.registerInterval(window.setInterval(() => this.evaluateDrawingCoedit(), 2000));
    // Keep the cloud badges on not-yet-downloaded files current: new placeholder
    // files appear, items render as the tree scrolls, and files get downloaded.
    this.registerInterval(window.setInterval(() => this.refreshCloudIcons(), 2000));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.refreshCloudIcons()));
  }

  onunload(): void {
    this.vaultSync?.stop();
    void this.binding.disengage();
    void this.excalBinding.disengage();
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

    // The binding owns the active markdown note whenever it is open, regardless
    // of how many people are present. This makes it the single authority for
    // open notes; whole-vault sync handles only closed files. Do not attempt to
    // engage while our connection is down - vault sync covers offline opens, and
    // a bound note that goes offline is kept alive by the reconnect merge.
    if (this.binding.isActive(file) || this.coeditEngageTimer !== null) return;
    if (!this.presence.isConnected()) return;
    // A placeholder note has no real content yet; wait until it is downloaded
    // (onNoteMaterialized re-runs this), otherwise the placeholder would sync.
    if (this.vaultSync?.isStub(file)) return;
    this.coeditEngageTimer = window.setTimeout(() => {
      this.coeditEngageTimer = null;
      const v = this.app.workspace.getActiveViewOfType(MarkdownView);
      const c = v ? getCmView(v) : undefined;
      const f = v?.file?.path ?? null;
      if (
        f === file &&
        c &&
        v &&
        !this.isExcalidraw(v) &&
        !this.binding.isActive(f) &&
        !this.vaultSync?.isStub(f)
      ) {
        void this.binding.engage(
          c,
          f,
          this.settings.serverUrl,
          this.effectiveAuth(),
          this.effectiveUser(),
          (p, localText, remoteText) => this.notifyConflict(p, localText, remoteText),
          (p) => this.vaultSync?.getBaseHash(p),
        );
      }
    }, 150);
  }

  // Drawings are co-edited whenever co-editing is on: they need no separate
  // switch, and the drawing room never touches note text.
  private drawingCoeditEnabled(): boolean {
    return this.settings.enableCoedit && !!this.settings.serverUrl && !!this.settings.authUser;
  }

  // Identity for the drawing room. Excalidraw derives a collaborator's cursor
  // colour from the id, so it has to be the login name rather than the
  // per-connection client id - otherwise everyone changes colour on reconnect.
  private effectiveDrawingUser(): { id: string; name: string; color: string } {
    const { name, color } = this.effectiveUser();
    return { id: this.settings.authUser || name, name, color };
  }

  // Attach or detach the drawing session for whichever drawing is in front.
  private evaluateDrawingCoedit(): void {
    const stop = (): void => {
      if (this.excalBinding.active) void this.endDrawingSession();
    };
    if (!this.drawingCoeditEnabled() || this.versionBlocked) {
      stop();
      return;
    }
    const view = activeDrawingView(this.app);
    const path = view?.file?.path ?? null;
    if (!view || !path) {
      stop();
      return;
    }
    if (this.excalBinding.active && this.excalBinding.path !== path) {
      void this.endDrawingSession().then(() => this.evaluateDrawingCoedit());
      return;
    }
    if (this.excalBinding.isActive(path) || this.drawingEngageTimer !== null) return;
    if (!this.presence.isConnected()) return;
    // A placeholder has no drawing in it yet; wait until it is downloaded.
    if (this.vaultSync?.isStub(path)) return;

    // Short delay: an Excalidraw view reports itself before its scene API is
    // usable, and this also coalesces rapid tab switching.
    this.drawingEngageTimer = window.setTimeout(() => {
      this.drawingEngageTimer = null;
      const v = activeDrawingView(this.app);
      const p = v?.file?.path ?? null;
      if (!v || p !== path || this.excalBinding.isActive(path)) return;
      const host = createSceneHost(v);
      if (!host) return; // this Excalidraw build does not expose what we need
      void this.excalBinding.engage(
        host,
        path,
        this.effectiveAuth(),
        this.effectiveDrawingUser(),
      );
    }, 300);
  }

  // End a drawing session cleanly: publish the last strokes, then refresh the
  // at-rest copy so peers who never opened the drawing still get it.
  private async endDrawingSession(): Promise<void> {
    const path = this.excalBinding.path;
    if (this.drawingEngageTimer !== null) {
      window.clearTimeout(this.drawingEngageTimer);
      this.drawingEngageTimer = null;
    }
    this.excalBinding.flush();
    await this.excalBinding.disengage();
    // Every leaving client refreshes the at-rest copy. That is safe because the
    // copy is stored content-addressed, and restricting it to the last one out
    // would risk nobody publishing at all when a peer drops off the network.
    if (path) await this.vaultSync?.publishDrawingAtRest(path);
  }

  private effectiveUser(): { name: string; color: string; login: string } {
    const name = this.displayName || this.settings.userName || "Anonym";
    return { name, color: colorFromName(name), login: this.settings.authUser };
  }

  // Map login user -> current display name (from live presence + ourselves), so
  // the blame view shows each author's up-to-date name even after a rename.
  private currentAuthorNames(): Map<string, string> {
    const map = new Map<string, string>();
    for (const e of this.presence?.getAll() ?? []) {
      const login = (e.state as { login?: string }).login;
      const name = e.state.user?.name;
      if (login && name) map.set(login, name);
    }
    const me = this.effectiveUser();
    if (me.login) map.set(me.login, me.name);
    return map;
  }

  private effectiveAuth(): { user: string; pass: string } {
    return { user: this.settings.authUser, pass: this.settings.authPass };
  }

  // Last-synced content hashes, persisted so conflicts can be detected across
  // restarts (kept in the plugin's own folder, not in the vault notes).
  private baseFilePath(): string {
    return `${this.manifest.dir}/sync-base.json`;
  }
  private async loadBaseHashes(): Promise<Record<string, string>> {
    try {
      const raw = await this.app.vault.adapter.read(this.baseFilePath());
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
    } catch {
      return {};
    }
  }
  private saveBaseHashes(record: Record<string, string>): void {
    void this.app.vault.adapter.write(this.baseFilePath(), JSON.stringify(record));
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
    configureLogger(this.settings.serverUrl, this.settings.authUser, this.manifest.version);
    // Version gate: an outdated client is blocked (and does not connect or sync)
    // until it updates, so everyone runs the same version.
    await this.enforceVersion();
    if (this.versionBlocked) return;

    {
      // Locked until we are actually connected: a connection is always required.
      this.setOffline(true);
      new Notice("Live Presence: Versuche Verbindung zur Datenbank aufzubauen …");
      let settled = false;
      const succeed = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        this.setOffline(false);
        logProblem("info", "verbunden", {
          coedit: this.settings.enableCoedit,
          vaultSync: this.settings.enableVaultSync,
        });
        const n = new Notice("Erfolgreich mit Live Presence verbunden");
        n.noticeEl.addClass("lp-notice-success");
      };
      const fail = (msg: string) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        this.setOffline(true);
        logProblem("error", "Verbindung fehlgeschlagen", { detail: msg });
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

    this.watchConnection();
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
      (path) => this.binding.isActive(path) || this.excalBinding.isActive(path),
      () => this.effectiveUser(),
      () => this.loadBaseHashes(),
      (record) => this.saveBaseHashes(record),
      (path, localText, remoteText) => this.notifyConflict(path, localText, remoteText),
      () => {}, // logging silenced for normal operation
      (path) => this.onNoteMaterialized(path),
      () => this.drawingCoeditEnabled(),
    );
    void this.vaultSync.start();
  }

  // Editing requires a live connection. While offline we lock all note editing
  // and show a fixed red banner (visible in every view); on reconnect we unlock.
  private watchConnection(): void {
    this.presence?.onStatus((status) => {
      if (status === "connected") this.setOffline(false);
      else if (status === "disconnected" || status === "error") this.setOffline(true);
    });
  }

  private ensureOfflineBanner(): HTMLElement {
    if (!this.offlineBanner) {
      const el = document.body.createDiv({ cls: "lp-offline-banner" });
      el.createSpan({ cls: "lp-offline-banner-dot", text: "●" });
      el.createSpan({
        text:
          "Sie sind offline – Bearbeitung gesperrt. Der Fortschritt wird nicht in der Cloud gespeichert. " +
          "Bitte solange in ein privates Dokument schreiben und die Inhalte nach dem Wiederverbinden einfügen.",
      });
      el.hide();
      this.offlineBanner = el;
      this.register(() => {
        el.remove();
        this.offlineBanner = null;
      });
    }
    return this.offlineBanner;
  }

  // Enforce that the client is at least the server-required version. An outdated
  // client is locked (no presence, sync or editing) and shown an update modal
  // until it updates. Never blocks when the version cannot be determined.
  private async enforceVersion(): Promise<void> {
    const info = await fetchRequiredVersion(this.settings.serverUrl);
    if (!info) return;
    if (!isOutdated(this.manifest.version, info.min)) return;
    if (!this.versionBlocked) {
      this.versionBlocked = true;
      logProblem("warn", "Version veraltet - blockiert", {
        current: this.manifest.version,
        min: info.min,
      });
      setEditingOnline(false);
      this.vaultSync?.stop();
      this.vaultSync = null;
      void this.binding.disengage();
      void this.excalBinding.disengage();
      this.presence?.destroy();
    }
    this.showUpdateModal(info);
  }

  private showUpdateModal(info: VersionInfo): void {
    if (this.updateModalOpen) return;
    this.updateModalOpen = true;
    new UpdateModal(
      this.app,
      this.manifest.version,
      info.latest,
      () => void this.performSelfUpdate(info.latest),
      () => void this.enforceVersion(),
      () => {
        this.updateModalOpen = false;
      },
    ).open();
  }

  // Update in place without BRAT: fetch the release files, write them into this
  // plugin's folder, then reload Obsidian so the new version takes effect.
  private async performSelfUpdate(version: string): Promise<void> {
    const dir = this.manifest.dir;
    if (!dir) {
      new Notice("Live Presence: Automatisches Update nicht möglich. Bitte über BRAT aktualisieren.");
      return;
    }
    const base = `https://github.com/${UPDATE_REPO}/releases/download/${version}`;
    const files = ["manifest.json", "main.js", "styles.css"];
    const notice = new Notice("Live Presence: Lade Update …", 0);
    try {
      // Download everything first; only write once all files are in hand.
      const contents: Record<string, string> = {};
      for (const f of files) {
        const res = await requestUrl({ url: `${base}/${f}`, method: "GET", throw: false });
        if (res.status !== 200 || typeof res.text !== "string" || res.text.length === 0) {
          throw new Error(`${f}: HTTP ${res.status}`);
        }
        contents[f] = res.text;
      }
      for (const f of files) {
        await this.app.vault.adapter.write(`${dir}/${f}`, contents[f]);
      }
      logProblem("info", "Self-Update geladen", { version });
      notice.setMessage("Live Presence: Aktualisiert. Obsidian wird neu geladen …");
      window.setTimeout(() => window.location.reload(), 900);
    } catch (err) {
      logProblem("error", "Self-Update fehlgeschlagen", { version, err: String(err) });
      notice.setMessage("Live Presence: Update fehlgeschlagen. Bitte über BRAT aktualisieren.");
      window.setTimeout(() => notice.hide(), 6000);
    }
  }

  // Connectivity check. Neither the WebSocket's connected flag (it lags on a
  // drop - stays true until TCP notices, so editing would wrongly unlock) nor
  // navigator.onLine (can be stuck false inside Obsidian) is reliable on its
  // own. So we actively probe the server via requestUrl (which, unlike fetch,
  // works inside Obsidian) with a short timeout. Online = server reachable AND
  // the WebSocket is up.
  private async heartbeat(): Promise<void> {
    if (!this.settings.serverUrl || !this.settings.authUser) return;
    const reachable = await this.probeReachable();
    const wsUp = this.presence?.isConnected() ?? false;
    const online = reachable && wsUp;
    if (!online && !this.versionBlocked) {
      logProblem("warn", "heartbeat offline", { reachable, wsUp, onLine: navigator.onLine });
    }
    this.setOffline(!online);
  }

  // Actively check the server is reachable right now, with a short timeout so a
  // dead connection is detected quickly instead of hanging.
  private async probeReachable(): Promise<boolean> {
    const url = `${this.settings.serverUrl.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:")}/version`;
    try {
      const res = await Promise.race([
        requestUrl({ url, method: "GET", throw: false }),
        new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error("timeout")), 3000)),
      ]);
      return (res as { status: number }).status === 200;
    } catch {
      return false;
    }
  }

  // Central driver for the offline state: locks editing and shows/hides the
  // fixed banner. Showing is delayed so a quick reconnect at startup does not
  // flash the banner. Does nothing when the plugin is not configured.
  private setOffline(offline: boolean): void {
    const configured = !!this.settings.serverUrl && !!this.settings.authUser;
    if (!configured) {
      this.lockedOffline = false;
      setEditingOnline(true);
      this.hideBannerNow();
      return;
    }
    if (this.versionBlocked) {
      setEditingOnline(false);
      return;
    }

    if (offline) {
      // Lock immediately; cancel any pending reconnect verification.
      if (this.verifyTimer !== null) {
        window.clearTimeout(this.verifyTimer);
        this.verifyTimer = null;
      }
      this.verifyNotice?.hide();
      this.verifyNotice = null;
      this.lockedOffline = true;
      setEditingOnline(false);
      this.scheduleBanner();
      return;
    }

    // Server reachable and the socket is up.
    if (!this.lockedOffline || this.verifyTimer !== null) return; // already online / verifying
    this.hideBannerNow();

    if (!this.hasConnected) {
      // First connection after start: no offline edits to reconcile, unlock now.
      this.hasConnected = true;
      this.lockedOffline = false;
      setEditingOnline(true);
      return;
    }

    // Reconnected after being offline: keep editing locked for a short window so
    // the note is re-synced from the server (and the server version adopted)
    // before writing resumes. Announce each step via a toast.
    this.hasConnected = true;
    setEditingOnline(false);
    this.verifyNotice = new Notice(
      "Live Presence: Wieder verbunden. Gleiche das Dokument mit dem Server ab …",
      0,
    );
    this.verifyTimer = window.setTimeout(() => {
      this.verifyTimer = null;
      this.verifyNotice?.hide();
      this.verifyNotice = null;
      this.lockedOffline = false;
      setEditingOnline(true);
      const ok = new Notice("Live Presence: Abgeglichen – Bearbeitung wieder möglich.");
      ok.noticeEl.addClass("lp-notice-success");
    }, 2500);
  }

  private scheduleBanner(): void {
    const banner = this.ensureOfflineBanner();
    if (this.offlineBannerVisible || this.offlineShowTimer !== null) return;
    this.offlineShowTimer = window.setTimeout(() => {
      this.offlineShowTimer = null;
      this.offlineBannerVisible = true;
      banner.show();
    }, 2000);
  }

  private hideBannerNow(): void {
    if (this.offlineShowTimer !== null) {
      window.clearTimeout(this.offlineShowTimer);
      this.offlineShowTimer = null;
    }
    if (this.offlineBannerVisible) {
      this.offlineBannerVisible = false;
      this.offlineBanner?.hide();
    }
  }

  // A placeholder note just finished downloading: start co-editing if it is the
  // active note (it was skipped while it was still a stub).
  private onNoteMaterialized(path: string): void {
    if (this.app.workspace.getActiveFile()?.path === path) this.evaluateCoedit();
    this.refreshCloudIcons(); // it is now downloaded -> drop its cloud badge
  }

  // Mark files that only exist on the server (never opened / not downloaded yet)
  // with a cloud badge in the file explorer, like OneDrive's online-only files.
  private refreshCloudIcons(): void {
    const sync = this.vaultSync;
    const items = document.querySelectorAll<HTMLElement>(".nav-file-title[data-path]");
    for (const el of Array.from(items)) {
      const path = el.getAttribute("data-path") ?? "";
      el.toggleClass("lp-cloud-file", !!sync && sync.isStub(path));
    }
  }

  // Inform the user that their local copy diverged from the server. The server
  // version always wins; this shows what differs and lets them copy their text.
  private notifyConflict(path: string, localText: string, remoteText: string): Promise<void> {
    return new Promise<void>((resolve) =>
      new ConflictInfoModal(this.app, path, localText, remoteText, resolve).open(),
    );
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
    const focusedPath = view?.file?.path ?? null;
    if (focusedPath) this.lastMarkdownPath = focusedPath;
    // The "effective" note stays the open note even when a sidebar (or the
    // roster / a button) takes focus - so clicking the sidebar does not throw us
    // out of the document.
    const notePath = this.activePath();
    const drawingPath = activeDrawingView(this.app)?.file?.path ?? null;
    const effective = notePath ?? drawingPath;

    // Co-editing follows one note. Disengage only when the bound note is gone
    // (closed) or a DIFFERENT note becomes effective - NOT when a sidebar merely
    // takes focus while the note stays open.
    if (this.binding.active) {
      const boundOpen = this.binding.path != null && this.isPathOpen(this.binding.path);
      const switchedNote = notePath != null && this.binding.path !== notePath;
      if (!boundOpen || switchedNote) void this.binding.disengage();
    }

    this.activeCm = view ? (getCmView(view) ?? null) : null;
    this.presence.setFile(effective);
    if (view && this.activeCm) {
      const sel = this.activeCm.state.selection.main;
      this.presence.setCursor({
        anchor: sel.anchor,
        head: sel.head,
        docLen: this.activeCm.state.doc.length,
      });
    } else if (!effective) {
      // Only drop our cursor when we truly have no note; when a sidebar has
      // focus but the note is still open, keep the last cursor so others still
      // see where we are.
      this.presence.setCursor(null);
    }
    this.refreshRemoteCursors();
    // Only re-render the version section when the note actually changed;
    // otherwise a focus change (e.g. clicking the sidebar) would recreate its
    // buttons between mousedown and click and swallow the first click.
    if (notePath !== this.lastVersionPath) {
      this.lastVersionPath = notePath;
      this.refreshRosterVersions();
    }
    this.evaluateCoedit();
    this.evaluateDrawingCoedit();
  }

  private refreshRosterVersions(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(ROSTER_VIEW_TYPE)) {
      if (leaf.view instanceof RosterView) leaf.view.refreshVersions();
    }
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
    // Keep the banner/lock in sync even if a status event was missed.
    if (this.presence) this.setOffline(!online);
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

  // Path of the current note (Markdown only), even when a sidebar has focus.
  private activePath(): string | null {
    // Prefer the active markdown editor - reliable even when getActiveFile lags
    // or returns null because a sidebar has focus.
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.file?.extension === "md") {
      this.lastMarkdownPath = view.file.path;
      return view.file.path;
    }
    const file = this.app.workspace.getActiveFile();
    if (file && file.extension === "md") {
      this.lastMarkdownPath = file.path;
      return file.path;
    }
    // A sidebar (or another non-note view) is focused: keep showing the last
    // opened note as long as it is still open in some tab.
    if (this.lastMarkdownPath && this.isPathOpen(this.lastMarkdownPath)) return this.lastMarkdownPath;
    return null;
  }

  private isPathOpen(path: string): boolean {
    return this.app.workspace
      .getLeavesOfType("markdown")
      .some((l) => (l.view as unknown as { file?: { path?: string } }).file?.path === path);
  }

  // Load and cache the time-aware blame of a note; returns the days with changes.
  private async loadHistory(path: string): Promise<DayInfo[]> {
    if (!this.settings.serverUrl) {
      this.historyCache = null;
      return [];
    }
    const entries = await listChangelog(this.settings.serverUrl, this.effectiveAuth(), path);
    const { runs, days } = reconstructHistory(entries);
    this.historyCache = { path, runs, days };
    return days;
  }

  // Colour the current text by author, aligned to the editor by length. When a
  // day is given, only the runs written on that day are coloured.
  private buildBlameOverlay(
    runs: TimedRun[],
    docLen: number,
    dayFilter?: string,
  ): { runs: OverlayRun[]; legend: { label: string; color: string }[] } | null {
    const total = runs.reduce((n, r) => n + r.text.length, 0);
    if (total !== docLen) return null;
    let pos = 0;
    const oruns: OverlayRun[] = [];
    const legend = new Map<string, string>();
    for (const r of runs) {
      const from = pos;
      const to = pos + r.text.length;
      pos = to;
      const day = new Date(r.t).toDateString();
      if (dayFilter && day !== dayFilter) continue;
      if (to > from) {
        oruns.push({
          from,
          to,
          color: withAlpha(r.color, 0.3),
          label: `${r.name} · ${new Date(r.t).toLocaleDateString()}`,
        });
      }
      if (!legend.has(r.name)) legend.set(r.name, r.color);
    }
    return { runs: oruns, legend: [...legend].map(([label, color]) => ({ label, color })) };
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

  overlayInfo(): { mode: "authors" | "day" | null; day: string | null } {
    return { mode: this.overlayMode, day: this.overlayDay };
  }

  clearOverlay(): void {
    this.activeCmView()?.dispatch({ effects: setOverlay.of(null) });
    this.overlayMode = null;
    this.overlayDay = null;
    this.refreshRosters();
  }

  async toggleAuthorsOverlay(): Promise<void> {
    if (this.overlayMode === "authors") {
      this.clearOverlay();
      return;
    }
    await this.applyOverlay(undefined, false);
  }

  async showDayOverlay(day: string): Promise<void> {
    await this.applyOverlay(day, false);
  }

  // Colour the note by author (dayFilter undefined) or highlight only one day's
  // changes. The blame comes from the change log, aligned to the editor.
  private async applyOverlay(dayFilter: string | undefined, silent: boolean): Promise<void> {
    const path = this.activePath();
    if (!path || !this.settings.serverUrl || !this.activeCmView()) {
      if (!silent) new Notice("Live Presence: Keine aktive Notiz.");
      return;
    }

    // Author colouring: build it straight from the live document so it always
    // matches the current text (the change log can be stale or empty).
    if (dayFilter === undefined) {
      const names = this.currentAuthorNames();
      // Reuse the already-open co-editing document if we have one - instant, no
      // new connection; otherwise open a short-lived connection to read it.
      const liveDoc = this.binding.liveDocFor(path);
      const blame = liveDoc
        ? blameFromDoc(liveDoc, names)
        : await buildLiveBlame(this.settings.serverUrl, this.effectiveAuth(), path, names);
      const cm = this.activeCmView();
      if (!cm) return;
      if (!blame || blame.runs.length === 0) {
        if (!silent) {
          new Notice("Live Presence: Autorenkennzeichnung ist für diese Notiz nicht verfügbar.");
        }
        return;
      }
      const docLen = cm.state.doc.length;
      // Clamp to the editor length instead of bailing, so it always renders.
      const runs = blame.runs
        .map((r) => ({ ...r, from: Math.min(r.from, docLen), to: Math.min(r.to, docLen) }))
        .filter((r) => r.from < r.to);
      cm.dispatch({
        effects: setOverlay.of({ runs, faded: [], legend: blame.legend, title: "Autoren" }),
      });
      this.overlayMode = "authors";
      this.overlayDay = null;
      this.refreshRosters();
      return;
    }

    // Day history (currently hidden) still comes from the change log.
    if (!this.historyCache || this.historyCache.path !== path) await this.loadHistory(path);
    const cache = this.historyCache;
    const cm = this.activeCmView();
    if (!cache || cache.path !== path || !cm) return;
    const built = this.buildBlameOverlay(cache.runs, cm.state.doc.length, dayFilter);
    if (!built) {
      if (!silent) new Notice("Live Presence: Verlauf noch nicht synchron – kurz warten und erneut versuchen.");
      return;
    }
    const title = `Änderungen am ${new Date(dayFilter).toLocaleDateString()}`;
    cm.dispatch({ effects: setOverlay.of({ runs: built.runs, faded: [], legend: built.legend, title }) });
    this.overlayMode = "day";
    this.overlayDay = dayFilter;
    this.refreshRosters();
  }

  private reapplyOverlayOnLeafChange(): void {
    const notePath = this.activePath();
    // Only react when the note actually changed. A mere focus change (clicking
    // the sidebar) must not re-apply/re-render, or it would recreate the sidebar
    // button between mousedown and click and swallow that click.
    if (notePath === this.lastOverlayPath) return;
    this.lastOverlayPath = notePath;
    this.historyCache = null; // blame is per note
    if (!this.overlayMode) return;
    if (!notePath || this.overlayMode === "day") {
      this.clearOverlay();
      return;
    }
    void this.applyOverlay(undefined, true);
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
