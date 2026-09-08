import { type App, Modal } from "obsidian";

// Shown before whole-vault synchronisation starts. Makes clear that the local
// vault is reconciled with the server copy and local files can be overwritten,
// so the user confirms before any download replaces local data.
export class ConnectModal extends Modal {
  private decided = false;

  constructor(
    app: App,
    private onConfirm: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText("Vault mit dem Server abgleichen");
    contentEl.createEl("p", {
      text:
        "Der geöffnete Vault wird mit dem Server abgeglichen. Dabei werden Inhalte vom Server " +
        "geladen, und lokale Dateien können dabei überschrieben werden.",
    });
    contentEl.createEl("p", {
      text:
        "Prüfen Sie deshalb, ob der richtige Vault offen ist. Was hier lokal liegt und noch " +
        "nicht auf dem Server ist, sichern Sie besser vorher.",
    });

    const actions = contentEl.createDiv({ cls: "lp-conflict-actions" });
    actions
      .createEl("button", { text: "Abgleichen und verbinden", cls: "mod-cta" })
      .onClickEvent(() => this.finish(true));
    actions.createEl("button", { text: "Abbrechen" }).onClickEvent(() => this.finish(false));
  }

  private finish(confirmed: boolean): void {
    if (this.decided) return;
    this.decided = true;
    if (confirmed) this.onConfirm();
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
