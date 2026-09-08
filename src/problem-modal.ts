import { type App, Modal, Notice } from "obsidian";
import { logProblem } from "./logger";

// Lets a user report a problem. The report is recorded on the server (in the log
// the developer inspects centrally); no email is sent.
export class ProblemModal extends Modal {
  constructor(
    app: App,
    private version: string,
    private reporter: string,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText("Problem melden");
    contentEl.createEl("p", {
      text: "Beschreiben Sie kurz, was passiert ist. Die Meldung geht an den Entwickler.",
    });
    const ta = contentEl.createEl("textarea", { cls: "lp-conflict-text" });
    ta.rows = 8;
    ta.placeholder = "Was ist passiert? Was hätten Sie erwartet?";

    const actions = contentEl.createDiv({ cls: "lp-conflict-actions" });
    actions.createEl("button", { text: "Senden", cls: "mod-cta" }).onClickEvent(() => this.send(ta.value));
    actions.createEl("button", { text: "Abbrechen" }).onClickEvent(() => this.close());

    window.setTimeout(() => ta.focus(), 0);
  }

  private send(text: string): void {
    const body = text.trim();
    if (!body) {
      new Notice("Bitte beschreiben Sie zuerst das Problem.");
      return;
    }
    logProblem("warn", `Problemmeldung: ${body}`, { reporter: this.reporter, version: this.version });
    new Notice("Vielen Dank, die Meldung ist angekommen.");
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
