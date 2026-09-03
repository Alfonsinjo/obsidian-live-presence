import { type App, Modal, Notice } from "obsidian";

// Shown when the local copy of a note diverged from the server. The server
// version always wins; this modal informs the user and lets them copy their own
// text first (e.g. to paste it elsewhere) before the server version is applied.
export class ConflictInfoModal extends Modal {
  private done = false;

  constructor(
    app: App,
    private path: string,
    private localText: string,
    private onDone: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    const name = this.path.replace(/\.md$/, "").split("/").pop() ?? this.path;
    titleEl.setText("Konflikt mit der Server-Version");

    contentEl.createEl("p", {
      text:
        `Deine lokale Fassung von „${name}" weicht von der Version auf dem Server ab. ` +
        "Es wird immer die Version vom Server verwendet.",
    });
    contentEl.createEl("p", {
      text: "Kopiere bei Bedarf deinen Text unten heraus, bevor die Server-Version übernommen wird.",
    });

    const ta = contentEl.createEl("textarea", { cls: "lp-conflict-text" });
    ta.value = this.localText;
    ta.readOnly = true;
    ta.rows = 10;

    const actions = contentEl.createDiv({ cls: "lp-conflict-actions" });
    actions.createEl("button", { text: "Text kopieren" }).onClickEvent(async () => {
      try {
        await navigator.clipboard.writeText(this.localText);
        new Notice("Text kopiert.");
      } catch {
        ta.select();
      }
    });
    actions
      .createEl("button", { text: "Server-Version übernehmen", cls: "mod-cta" })
      .onClickEvent(() => this.finish());

    contentEl.createEl("p", {
      cls: "lp-conflict-hint",
      text:
        "Wenn du deinen Text zuerst sichern möchtest, kopiere ihn oben heraus und schließe Obsidian, " +
        "bevor du fortfährst. Andernfalls wird die Server-Version übernommen.",
    });
  }

  private finish(): void {
    if (this.done) return;
    this.done = true;
    this.onDone();
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.done) {
      this.done = true;
      this.onDone();
    }
  }
}
