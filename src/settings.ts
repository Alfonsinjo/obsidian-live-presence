import { type App, Notice, PluginSettingTab, Setting } from "obsidian";
import { ConnectModal } from "./connect-modal";
import { testConnection } from "./connection";
import type LivePresencePlugin from "./main";
import { colorFromName } from "./utils";

export class LivePresenceSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: LivePresencePlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Identität").setHeading();

    new Setting(containerEl)
      .setName("Anzeigename")
      .setDesc(
        "Ihr Vor- und Nachname. Wird beim ersten Verbinden abgefragt und auf dem Server zu Ihrem Konto " +
          "gespeichert. Die anderen sehen ihn in der Seitenleiste und an Ihrem Cursor.",
      )
      .addText((t) => {
        t.setValue(this.plugin.settings.userName || "").setDisabled(true);
      })
      .addButton((b) =>
        b.setButtonText("Namen ändern").onClick(async () => {
          await this.plugin.changeName();
          this.display();
        }),
      );

    new Setting(containerEl)
      .setName("Farbe")
      .setDesc("Wird automatisch aus Ihrem Namen abgeleitet.")
      .then((s) => {
        const swatch = s.controlEl.createDiv({ cls: "lp-color-swatch" });
        swatch.style.backgroundColor = colorFromName(this.plugin.settings.userName || "Anonym");
      });

    new Setting(containerEl).setName("Verbindung").setHeading();

    new Setting(containerEl)
      .setName("Server-URL")
      .setDesc(
        "Adresse Ihres Servers, z. B. wss://server.example/presence (ohne Schrägstrich am Ende).",
      )
      .addText((t) =>
        t
          .setPlaceholder("wss://…/presence")
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (v) => {
            this.plugin.settings.serverUrl = v.trim().replace(/\/+$/, "");
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Login-Benutzer")
      .setDesc("Ihr Konto auf dem Server.")
      .addText((t) =>
        t
          .setPlaceholder("benutzername")
          .setValue(this.plugin.settings.authUser)
          .onChange(async (v) => {
            this.plugin.settings.authUser = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    let passwordInput: HTMLInputElement | null = null;
    new Setting(containerEl)
      .setName("Login-Passwort")
      .setDesc("Passwort dieses Kontos. Wird nur zum Verbinden an den Server gesendet.")
      .addText((t) => {
        t.setPlaceholder("Passwort")
          .setValue(this.plugin.settings.authPass)
          .onChange(async (v) => {
            this.plugin.settings.authPass = v;
            await this.plugin.saveSettings();
          });
        t.inputEl.type = "password";
        passwordInput = t.inputEl;
      })
      .addToggle((tg) =>
        tg
          .setTooltip("Passwort anzeigen")
          .setValue(false)
          .onChange((show) => {
            if (passwordInput) passwordInput.type = show ? "text" : "password";
          }),
      );

    new Setting(containerEl).setName("Echtzeit-Co-Editing").setHeading();

    new Setting(containerEl)
      .setName("Co-Editing aktivieren")
      .setDesc(
        "Sobald zwei oder mehr Personen dieselbe Notiz geöffnet haben, wird sie gemeinsam bearbeitet, " +
          "Zeichen für Zeichen – Excalidraw-Zeichnungen ebenso. Wer online ist und wo die Cursor " +
          "stehen, sehen Sie auch ohne diese Option.",
      )
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.enableCoedit).onChange(async (v) => {
          this.plugin.settings.enableCoedit = v;
          await this.plugin.saveSettings();
          this.plugin.reconnect();
        }),
      );

    new Setting(containerEl).setName("Vault-Synchronisation").setHeading();

    new Setting(containerEl).setDesc(
      "Der ganze Vault läuft über diesen Server – ein zusätzliches Sync-Plugin brauchen Sie nicht. " +
        "Eine Notiz wird geladen, wenn Sie sie öffnen; bis dahin steht in der Dateiliste ein " +
        "Wolkensymbol davor.",
    );

    new Setting(containerEl)
      .setName("Anmelden")
      .setDesc(
        "Prüft Server-URL und Zugangsdaten und sagt, was nicht stimmt. Vor dem Abgleich mit dem " +
          "Server kommt noch eine Rückfrage.",
      )
      .addButton((b) =>
        b
          .setButtonText("Anmelden / Verbindung testen")
          .setCta()
          .onClick(async () => {
            b.setDisabled(true);
            b.setButtonText("Prüfe …");
            const res = await testConnection(
              this.plugin.settings.serverUrl,
              this.plugin.settings.authUser,
              this.plugin.settings.authPass,
            );
            b.setDisabled(false);
            b.setButtonText("Anmelden / Verbindung testen");
            if (!res.ok) {
              const n = new Notice(`Live Presence: ${res.reason}`, 8000);
              n.noticeEl.addClass("lp-notice-error");
              return;
            }
            const n = new Notice("Live Presence: Zugangsdaten korrekt.");
            n.noticeEl.addClass("lp-notice-success");
            new ConnectModal(this.app, () => this.plugin.reconnect()).open();
          }),
      );
  }
}
