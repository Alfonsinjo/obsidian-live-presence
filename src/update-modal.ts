import { type App, Modal } from "obsidian";

// Shown when the client is older than the version the server requires. Everyone
// must run the same version, so the tool stays locked until the user updates.
export class UpdateModal extends Modal {
  constructor(
    app: App,
    private current: string,
    private latest: string,
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
        "Es ist eine neuere Version von Live Presence verfügbar. Damit alle dieselbe Version verwenden, " +
        "ist ein Update nötig, bevor du weiterarbeiten kannst. Die Verbindung ist bis dahin pausiert.",
    });
    const v = contentEl.createEl("p");
    v.createEl("strong", { text: "Deine Version: " });
    v.appendText(`${this.current}  •  `);
    v.createEl("strong", { text: "Erforderlich: " });
    v.appendText(this.latest);

    contentEl.createEl("p", { text: "So aktualisierst du:" });
    const ol = contentEl.createEl("ol");
    ol.createEl("li", { text: "Befehlspalette öffnen (Strg/Cmd + P)." });
    ol.createEl("li", { text: "„BRAT: Check for updates to all beta plugins" + "\" ausführen." });
    ol.createEl("li", { text: "Anschließend Obsidian neu laden (Knopf unten)." });

    const actions = contentEl.createDiv({ cls: "lp-conflict-actions" });
    actions
      .createEl("button", { text: "Obsidian neu laden", cls: "mod-cta" })
      .onClickEvent(() => window.location.reload());
    actions.createEl("button", { text: "Erneut prüfen" }).onClickEvent(() => this.onRecheck());
  }

  onClose(): void {
    this.contentEl.empty();
    this.onClosed();
  }
}
