import { type App, Modal } from "obsidian";

// Shown when the client is older than the version the server requires. Everyone
// must run the same version, so the tool stays locked until the user updates.
// Offers a one-click self-update; BRAT stays available as a fallback.
export class UpdateModal extends Modal {
  constructor(
    app: App,
    private current: string,
    private latest: string,
    private onUpdate: () => void,
    private onRecheck: () => void,
    private onClosed: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText("Update erforderlich");

    contentEl.createEl("p", {
      text:
        "Eine neue Version ist erforderlich, damit alle dieselbe verwenden. " +
        "Die Bearbeitung ist bis zum Update pausiert.",
    });
    const v = contentEl.createEl("p");
    v.createEl("strong", { text: "Ihre Version: " });
    v.appendText(`${this.current}  •  `);
    v.createEl("strong", { text: "Neue Version: " });
    v.appendText(this.latest);

    const actions = contentEl.createDiv({ cls: "lp-conflict-actions" });
    actions
      .createEl("button", { text: "Jetzt aktualisieren", cls: "mod-cta" })
      .onClickEvent(() => this.onUpdate());
    actions.createEl("button", { text: "Erneut prüfen" }).onClickEvent(() => this.onRecheck());

    contentEl.createEl("p", {
      cls: "lp-conflict-hint",
      text: "Aktualisiert die App direkt und startet Obsidian neu.",
    });
  }

  onClose(): void {
    this.contentEl.empty();
    this.onClosed();
  }
}
