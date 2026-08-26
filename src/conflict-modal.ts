import { type App, Modal } from "obsidian";
import type { MergeResult } from "./merge";

// Shown when a note was changed on both sides at the same lines. The user picks
// one side; the chosen version replaces the spot cleanly (no markers are ever
// written into the document).
export class ConflictModal extends Modal {
  private decided = false;

  constructor(
    app: App,
    private path: string,
    private result: MergeResult,
    private onResolve: (action: "mine" | "theirs") => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText(`Konflikt: ${this.path}`);
    contentEl.createEl("p", {
      text:
        "Dieselben Zeilen wurden von dir und einer anderen Person gleichzeitig unterschiedlich geändert. " +
        "Nicht überlappende Änderungen wurden bereits automatisch übernommen. Bitte für die folgende(n) Stelle(n) entscheiden:",
    });

    for (const c of this.result.conflicts) {
      const block = contentEl.createDiv({ cls: "lp-conflict-block" });

      const other = block.createDiv({ cls: "lp-conflict-row" });
      other.createDiv({ cls: "lp-conflict-label", text: "Andere Version (aktuell im Dokument)" });
      other.createEl("pre", { cls: "lp-conflict-other", text: c.remote.join("\n") || "(leer)" });

      block.createDiv({ cls: "lp-conflict-arrow", text: "↓ beim Übernehmen ersetzt durch" });

      const mine = block.createDiv({ cls: "lp-conflict-row" });
      mine.createDiv({ cls: "lp-conflict-label", text: "Deine Version" });
      mine.createEl("pre", { cls: "lp-conflict-mine", text: c.local.join("\n") || "(leer)" });
    }

    const actions = contentEl.createDiv({ cls: "lp-conflict-actions" });
    const mineBtn = actions.createEl("button", { text: "Deine Version übernehmen", cls: "mod-cta" });
    mineBtn.onClickEvent(() => this.finish("mine"));
    actions
      .createEl("button", { text: "Verwerfen (andere Version behalten)" })
      .onClickEvent(() => this.finish("theirs"));

    contentEl.createEl("p", {
      cls: "lp-conflict-hint",
      text:
        "Übernehmen ersetzt die Stelle sauber durch deine Version. Verwerfen behält die andere Version. " +
        "Es werden keine Markierungen ins Dokument geschrieben; die jeweils andere Fassung bleibt im Verlauf erhalten.",
    });
  }

  private finish(action: "mine" | "theirs"): void {
    if (this.decided) return;
    this.decided = true;
    this.onResolve(action);
    this.close();
  }

  onClose(): void {
    // If closed without choosing, keep the user's own version (their work is
    // preserved; the other side stays recoverable from the change log).
    if (!this.decided) {
      this.decided = true;
      this.onResolve("mine");
    }
    this.contentEl.empty();
  }
}
