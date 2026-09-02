import { ItemView, type WorkspaceLeaf, setIcon } from "obsidian";
import type { RemoteEntry } from "./types";

export const ROSTER_VIEW_TYPE = "live-presence-roster";

export interface SidebarDay {
  day: string;
  label: string;
  authors: string[];
}

interface RosterCallbacks {
  getEntries: () => RemoteEntry[];
  getSelfId: () => number;
  onOpenFile: (path: string) => void;
  getActivePath: () => string | null;
  onToggleAuthors: () => void;
  onClearOverlay: () => void;
  overlayInfo: () => { mode: "authors" | "day" | null; day: string | null };
  loadDays: (path: string) => Promise<SidebarDay[]>;
  onSelectDay: (day: string) => void;
}

// Sidebar view: who is online (grouped by file), and below it the history of the
// current note: author highlighting plus a per-day list of changes to review.
export class RosterView extends ItemView {
  private presenceEl!: HTMLElement;
  private versionEl!: HTMLElement;

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
    this.contentEl.addClass("lp-roster");
    this.presenceEl = this.contentEl.createDiv();
    this.versionEl = this.contentEl.createDiv();
    this.renderPresence();
    this.renderVersions();
  }

  // Presence updates only re-render the presence section.
  refresh(): void {
    this.renderPresence();
  }

  // Called when the version/overlay state changed deliberately (button click).
  refreshVersions(): void {
    this.renderVersions();
  }

  private iconButton(parent: HTMLElement, icon: string, label: string, active: boolean): HTMLElement {
    const btn = parent.createEl("button", { cls: "clickable-icon lp-icon-btn" });
    setIcon(btn, icon);
    btn.setAttribute("aria-label", label);
    btn.setAttribute("title", label);
    if (active) btn.addClass("lp-btn-active");
    return btn;
  }

  private renderPresence(): void {
    const root = this.presenceEl;
    root.empty();
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

  private renderVersions(): void {
    const root = this.versionEl;
    root.empty();
    root.createEl("h4", { text: "Wer hat was geschrieben", cls: "lp-section-top" });

    const path = this.cb.getActivePath();
    if (!path) {
      root.createDiv({ cls: "lp-roster-empty", text: "Keine Notiz geöffnet." });
      return;
    }

    const label = path.replace(/\.md$/, "").split("/").pop() ?? path;
    root.createDiv({ cls: "lp-ver-file", text: label }).setAttr("title", path);

    const info = this.cb.overlayInfo();
    const actions = root.createDiv({ cls: "lp-ver-actions" });
    this.iconButton(actions, "users", "Autoren im Text hervorheben", info.mode === "authors").onClickEvent(
      () => this.cb.onToggleAuthors(),
    );
    if (info.mode) {
      this.iconButton(actions, "eye-off", "Hervorhebung im Text ausschalten", false).onClickEvent(() =>
        this.cb.onClearOverlay(),
      );
    }
    root.createDiv({
      cls: "lp-ver-hint",
      text: "Farbige Markierung zeigt, wer welche Passage geschrieben hat (per Zeiger für Details).",
    });
    // The per-day version history is temporarily hidden and returns in a later
    // update once it is reliable.
  }
}
