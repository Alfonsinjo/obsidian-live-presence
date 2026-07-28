import { ItemView, type WorkspaceLeaf, setIcon } from "obsidian";
import type { RemoteEntry } from "./types";

export const ROSTER_VIEW_TYPE = "live-presence-roster";

interface RosterCallbacks {
  getEntries: () => RemoteEntry[];
  getSelfId: () => number;
  onOpenFile: (path: string) => void;
  getActivePath: () => string | null;
  onOpenHistory: () => void;
  onToggleAuthors: () => void;
  onClearOverlay: () => void;
  overlayInfo: () => { mode: "authors" | "asof" | null };
  loadFrames: (path: string) => Promise<number[]>;
  onScrubTo: (index: number) => void;
}

// Sidebar view: who is online (grouped by file), and below it the version
// controls for the current note (author highlight, history, and a playback
// scrubber over the recorded timeline).
export class RosterView extends ItemView {
  private presenceEl!: HTMLElement;
  private versionEl!: HTMLElement;
  private frames: { path: string | null; times: number[] } | null = null;
  private playTimer: number | null = null;

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
    void this.ensureFrames(false);
  }

  // Presence updates only re-render the presence section, so they never disturb
  // the playback scrubber below.
  refresh(): void {
    this.renderPresence();
    void this.ensureFrames(false);
  }

  // Called when the version/overlay state changed deliberately (button click).
  refreshVersions(): void {
    this.renderVersions();
  }

  private stopPlay(): void {
    if (this.playTimer !== null) {
      window.clearInterval(this.playTimer);
      this.playTimer = null;
    }
  }

  private async ensureFrames(force: boolean): Promise<void> {
    const path = this.cb.getActivePath();
    if (!force && this.frames?.path === path) return;
    const times = path ? await this.cb.loadFrames(path) : [];
    this.frames = { path, times };
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
    this.stopPlay();
    root.empty();
    root.createEl("h4", { text: "Verlauf (aktuelle Notiz)", cls: "lp-section-top" });

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
    this.iconButton(actions, "history", "Verlauf (Sitzungen) öffnen", false).onClickEvent(() =>
      this.cb.onOpenHistory(),
    );
    if (info.mode) {
      this.iconButton(actions, "eye-off", "Hervorhebung im Text ausschalten", false).onClickEvent(() =>
        this.cb.onClearOverlay(),
      );
    }

    const times = this.frames && this.frames.path === path ? this.frames.times : null;
    if (times === null) {
      root.createDiv({ cls: "lp-roster-empty", text: "Lade Verlauf …" });
      return;
    }
    if (times.length <= 1) {
      root.createDiv({ cls: "lp-roster-empty", text: "Noch kein aufgezeichneter Verlauf." });
      return;
    }

    const max = times.length - 1;
    const pb = root.createDiv({ cls: "lp-pb" });
    const row = pb.createDiv({ cls: "lp-pb-row" });
    const playBtn = this.iconButton(row, "play", "Verlauf abspielen", false);
    const timeLabel = row.createSpan({ cls: "lp-pb-label" });

    const slider = pb.createEl("input", { cls: "lp-pb-slider" });
    slider.type = "range";
    slider.min = "0";
    slider.max = String(max);
    slider.value = String(max);

    const setLabel = (i: number) =>
      timeLabel.setText(i >= max ? "aktueller Stand" : `Stand: ${new Date(times[i]).toLocaleString()}`);

    slider.oninput = () => {
      this.stopPlay();
      setIcon(playBtn, "play");
      const i = Number(slider.value);
      setLabel(i);
      this.cb.onScrubTo(i);
    };

    playBtn.onClickEvent(() => {
      if (this.playTimer !== null) {
        this.stopPlay();
        setIcon(playBtn, "play");
        return;
      }
      if (Number(slider.value) >= max) {
        slider.value = "0";
        setLabel(0);
        this.cb.onScrubTo(0);
      }
      setIcon(playBtn, "pause");
      this.playTimer = window.setInterval(() => {
        let v = Number(slider.value);
        if (v >= max) {
          this.stopPlay();
          setIcon(playBtn, "play");
          return;
        }
        v += 1;
        slider.value = String(v);
        setLabel(v);
        this.cb.onScrubTo(v);
      }, 700);
    });

    setLabel(max);
  }

  async onClose(): Promise<void> {
    this.stopPlay();
  }
}
