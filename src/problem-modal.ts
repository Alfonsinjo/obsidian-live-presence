import { type App, Modal, Notice } from "obsidian";
import { logProblem } from "./logger";

const CONTACT = "thomas.stabel@rptu.de";

// Lets a user report a problem. The report is sent two ways: logged on the
// server (so the developer sees it centrally) and opened in the user's mail
// client, pre-filled to the contact address.
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
      text: "Beschreiben Sie das Problem kurz. Ihre Meldung geht an Thomas Stabel.",
    });
    const ta = contentEl.createEl("textarea", { cls: "lp-conflict-text" });
    ta.rows = 8;
    ta.placeholder = "Was ist passiert? Was war zu erwarten?";

    const actions = contentEl.createDiv({ cls: "lp-conflict-actions" });
    actions.createEl("button", { text: "Senden", cls: "mod-cta" }).onClickEvent(() => this.send(ta.value));
    actions.createEl("button", { text: "Abbrechen" }).onClickEvent(() => this.close());

    contentEl.createEl("p", {
      cls: "lp-conflict-hint",
      text: `Öffnet Ihr E-Mail-Programm an ${CONTACT}; die Meldung wird zusätzlich am Server hinterlegt.`,
    });
    window.setTimeout(() => ta.focus(), 0);
  }

  private send(text: string): void {
    const body = text.trim();
    if (!body) {
      new Notice("Bitte zuerst das Problem beschreiben.");
      return;
    }
    // 1) Central server log (reliable even without a mail client).
    logProblem("warn", `Problemmeldung: ${body}`, { reporter: this.reporter });
    // 2) Open the user's mail client, pre-filled.
    const subject = encodeURIComponent(`Live Presence Problem (${this.version})`);
    const mailBody = encodeURIComponent(`${body}\n\n---\nVon: ${this.reporter}\nVersion: ${this.version}`);
    const a = document.createElement("a");
    a.href = `mailto:${CONTACT}?subject=${subject}&body=${mailBody}`;
    a.click();

    new Notice("Vielen Dank. Ihre Meldung wurde gesendet.");
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
