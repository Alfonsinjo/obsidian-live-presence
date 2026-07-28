import { ItemView, type WorkspaceLeaf } from "obsidian";
import type { RemoteEntry } from "./types";

export const ROSTER_VIEW_TYPE = "live-presence-roster";

interface VersionInfo {
  t: number;
  by: string;
}

interface RosterCallbacks {
  getEntries: () => RemoteEntry[];
  getSelfId: () => number;
  onOpenFile: (path: string) => void;
  getActivePath: () => string | null;
  loadVersions: (path: string) => Promise<VersionInfo[]>;
  onSaveVersion: () => Promise<void>;
  onOpenHistory: () => void;
  onOpenPlayback: () => void;
  onToggleAuthors: () => void;
  onShowSince: (t: number) => void;
  onClearOverlay: () => void;
  overlayInfo: () => { mode: "authors" | "since" | null; sinceT: number | null };
}

// Sidebar view: who is online (grouped by file) and, below it, the version
// history of the currently open note with quick actions.
export class RosterView extends ItemView {
  private versions: { path: string | null; items: VersionInfo[] } | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private cb: RosterCallbacks,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return ROSTER_VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Live Presence";
  }
  getIcon(): string {
    return "users";
  }

  async onOpen(): Promise<void> {
    this.render();
    void this.ensureVersions(false);
  }

  refresh(): void {
    this.render();
    void this.ensureVersions(false);
  }

  // Reload the version list only when the active note changed (or when forced),
  // so frequent presence updates do not hit the server repeatedly.
  private async ensureVersions(force: boolean): Promise<void> {
    const path = this.cb.getActivePath();
    if (!force && this.versions?.path === path) return;
    const items = path ? await this.cb.loadVersions(path) : [];
    this.versions = { path, items };
    this.render();
  }

  private render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("lp-roster");

    this.renderPresence(root);
    this.renderVersions(root);
  }

  private renderPresence(root: HTMLElement): void {
    root.createEl("h4", { text: "Gerade im Vault" });

    const entries = this.cb.getEntries();
    if (entries.length === 0) {
      root.createDiv({ cls: "lp-roster-empty", text: "Niemand online." });
      return;
    }

    const selfId = this.cb.getSelfId();
    const byFile = new Map<string | null, RemoteEntry[]>();
    for (const e of entries) {
      const key = e.state.file ?? null;
      const arr = byFile.get(key);
      if (arr) arr.push(e);
      else byFile.set(key, [e]);
    }

    const files = Array.from(byFile.keys()).sort((a, b) => {
      if (a === null) return 1;
      if (b === null) return -1;
      return a.localeCompare(b);
    });

    for (const file of files) {
      const users = byFile.get(file) ?? [];
      if (file === null) {
        root.createDiv({ cls: "lp-roster-file lp-nofile", text: "(keine Datei geöffnet)" });
      } else {
        const label = file.replace(/\.md$/, "").split("/").pop() ?? file;
        const fileEl = root.createDiv({ cls: "lp-roster-file", text: label });
        fileEl.setAttr("title", file);
        fileEl.onClickEvent(() => this.cb.onOpenFile(file));
      }
      for (const e of users) {
        const row = root.createDiv({ cls: "lp-roster-user" });
        if (e.clientId === selfId) row.addClass("lp-self");
        const dot = row.createSpan({ cls: "lp-roster-dot" });
        dot.style.backgroundColor = e.state.user.color;
        const name = e.state.user.name || "Anonym";
        row.createSpan({ text: e.clientId === selfId ? `${name} (du)` : name });
      }
    }
  }

  private renderVersions(root: HTMLElement): void {
    root.createEl("h4", { text: "Versionen & Verlauf (aktuelle Notiz)", cls: "lp-section-top" });

    const path = this.cb.getActivePath();
    if (!path) {
      root.createDiv({ cls: "lp-roster-empty", text: "Keine Notiz geöffnet." });
      return;
    }

    const label = path.replace(/\.md$/, "").split("/").pop() ?? path;
    root.createDiv({ cls: "lp-ver-file", text: label }).setAttr("title", path);

    const info = this.cb.overlayInfo();

    const actions = root.createDiv({ cls: "lp-ver-actions" });
    const saveBtn = actions.createEl("button", { text: "Version merken" });
    saveBtn.onClickEvent(async () => {
      saveBtn.setAttr("disabled", "true");
      await this.cb.onSaveVersion();
      await this.ensureVersions(true);
    });
    const authBtn = actions.createEl("button", {
      text: info.mode === "authors" ? "Autoren im Text ✓" : "Autoren im Text",
    });
    if (info.mode === "authors") authBtn.addClass("lp-btn-active");
    authBtn.onClickEvent(() => this.cb.onToggleAuthors());
    actions.createEl("button", { text: "Verlauf" }).onClickEvent(() => this.cb.onOpenHistory());
    actions.createEl("button", { text: "Wiedergabe" }).onClickEvent(() => this.cb.onOpenPlayback());
    if (info.mode) {
      actions.createEl("button", { text: "Hervorhebung aus" }).onClickEvent(() => this.cb.onClearOverlay());
    }

    root.createDiv({
      cls: "lp-ver-hint",
      text: "Klicke eine Version an, um die Änderungen seither im Text zu markieren.",
    });

    const list = root.createDiv({ cls: "lp-ver-list" });
    const items = this.versions && this.versions.path === path ? this.versions.items : null;
    if (items === null) {
      list.createDiv({ cls: "lp-roster-empty", text: "Lade …" });
      return;
    }
    if (items.length === 0) {
      list.createDiv({ cls: "lp-roster-empty", text: "Noch keine Versionen." });
      return;
    }
    for (const v of items.slice(-8).reverse()) {
      const row = list.createDiv({ cls: "lp-ver-item lp-ver-clickable" });
      if (info.mode === "since" && info.sinceT === v.t) row.addClass("lp-btn-active");
      row.createSpan({ cls: "lp-ver-when", text: new Date(v.t).toLocaleString() });
      if (v.by) row.createSpan({ cls: "lp-ver-by", text: v.by });
      row.setAttr("title", "Änderungen seit dieser Version im Text markieren");
      row.onClickEvent(() => {
        if (info.mode === "since" && info.sinceT === v.t) this.cb.onClearOverlay();
        else this.cb.onShowSince(v.t);
      });
    }
  }
}
