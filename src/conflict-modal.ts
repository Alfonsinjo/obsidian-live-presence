import { type App, Modal } from "obsidian";
import type { MergeResult } from "./merge";

// Shown when a note was changed on both sides at the same lines. Lets the user
// merge (keeping both, with markers) or keep only their own version.
export class ConflictModal extends Modal {
  private decided = false;

  constructor(
    app: App,
    private path: string,
    private result: MergeResult,
    private onResolve: (action: "merge" | "discard") => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText(`Konflikt: ${this.path}`);
    contentEl.createEl("p", {
      text: "Diese Notiz wurde gleichzeitig an denselben Stellen geändert. Nicht überlappende Änderungen wurden bereits automatisch zusammengeführt. Für die folgenden Stellen bitte entscheiden:",
    });

    for (const c of this.result.conflicts) {
      const block = contentEl.createDiv({ cls: "lp-conflict-block" });
      const mine = block.createDiv({ cls: "lp-conflict-side" });
      mine.createDiv({ cls: "lp-conflict-label", text: "Deine Version" });
      mine.createEl("pre", { cls: "lp-conflict-mine", text: c.local.join("\n") || "(leer)" });
      const other = block.createDiv({ cls: "lp-conflict-side" });
      other.createDiv({ cls: "lp-conflict-label", text: "Andere Version" });
      other.createEl("pre", { cls: "lp-conflict-other", text: c.remote.join("\n") || "(leer)" });
    }

    const actions = contentEl.createDiv({ cls: "lp-conflict-actions" });
    const mergeBtn = actions.createEl("button", { text: "Zusammenführen (beide behalten)", cls: "mod-cta" });
    mergeBtn.onClickEvent(() => this.finish("merge"));
    actions.createEl("button", { text: "Meine Version behalten" }).onClickEvent(() => this.finish("discard"));

    contentEl.createEl("p", {
      cls: "lp-conflict-hint",
      text: "Beim Zusammenführen bleiben beide Fassungen mit Markierungen (<<<<<<< / >>>>>>>) erhalten, sodass nichts verloren geht.",
    });
  }

  private finish(action: "merge" | "discard"): void {
    if (this.decided) return;
    this.decided = true;
    this.onResolve(action);
    this.close();
  }

  onClose(): void {
    // Default to a lossless merge if the user closes without choosing.
    if (!this.decided) {
      this.decided = true;
      this.onResolve("merge");
    }
    this.contentEl.empty();
  }
}
