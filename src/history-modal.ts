import { type App, Modal } from "obsidian";
import { type Version, diffLines, listVersions } from "./history";

interface Auth {
  user: string;
  pass: string;
}

// Timeline of a note's stored versions with a line-level diff (green added,
// red removed) between a version and the one before it.
export class HistoryModal extends Modal {
  constructor(
    app: App,
    private serverUrl: string,
    private auth: Auth,
    private path: string,
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const { contentEl, titleEl } = this;
    titleEl.setText(`Verlauf: ${this.path}`);
    contentEl.createEl("p", { text: "Lade …" });

    const versions = await listVersions(this.serverUrl, this.auth, this.path);
    contentEl.empty();

    if (versions.length === 0) {
      contentEl.createEl("p", {
        text: "Für diese Notiz gibt es noch keine gespeicherten Versionen. Sie entstehen automatisch beim Bearbeiten; du kannst über den Befehl „Version dieser Notiz merken“ auch selbst eine anlegen.",
      });
      return;
    }

    const layout = contentEl.createDiv({ cls: "lp-history" });
    const list = layout.createDiv({ cls: "lp-history-list" });
    const detail = layout.createDiv({ cls: "lp-history-detail" });

    const show = (index: number) => {
      for (const el of Array.from(list.children)) el.removeClass("is-active");
      // The list is rendered newest first, so map the version index accordingly.
      list.children[versions.length - 1 - index]?.addClass("is-active");
      detail.empty();

      const cur = versions[index];
      const prev = index > 0 ? versions[index - 1] : null;
      const heading = detail.createEl("div", { cls: "lp-history-heading" });
      heading.setText(
        prev
          ? `Änderungen zu „${this.stamp(cur.t)}“ (gespeichert von ${cur.by || "?"})`
          : `Erste Version — ${this.stamp(cur.t)} von ${cur.by || "?"}`,
      );

      const ops = diffLines(prev ? prev.text : "", cur.text);
      const pre = detail.createEl("pre", { cls: "lp-history-diff" });
      for (const op of ops) {
        const line = pre.createDiv({ cls: "lp-diff-line" });
        line.setText(op.text.length ? op.text : " ");
        if (op.type === "added") line.addClass("lp-diff-added");
        else if (op.type === "removed") line.addClass("lp-diff-removed");
      }
    };

    for (let i = versions.length - 1; i >= 0; i--) {
      const v: Version = versions[i];
      const row = list.createDiv({ cls: "lp-history-item" });
      row.createDiv({ cls: "lp-history-when", text: this.stamp(v.t) });
      row.createDiv({ cls: "lp-history-who", text: v.by || "" });
      row.onClickEvent(() => show(i));
    }

    show(versions.length - 1);
  }

  private stamp(t: number): string {
    return new Date(t).toLocaleString();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
