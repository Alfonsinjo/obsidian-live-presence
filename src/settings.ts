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
        "Dein Vor- und Nachname. Wird beim ersten Verbinden abgefragt und im Konto (Server) gespeichert; erscheint im Roster und am Cursor.",
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
      .setDesc("Wird automatisch und eindeutig aus deinem Namen abgeleitet.")
      .then((s) => {
        const swatch = s.controlEl.createDiv({ cls: "lp-color-swatch" });
        swatch.style.backgroundColor = colorFromName(this.plugin.settings.userName || "Anonym");
      });

    new Setting(containerEl).setName("Verbindung").setHeading();

    new Setting(containerEl)
      .setName("Server-URL")
      .setDesc("WebSocket-Basis des Presence-Servers (ohne Schrägstrich am Ende).")
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
      .setDesc("Dein CouchDB-Benutzer (dasselbe Konto wie bei LiveSync).")
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
        "Bearbeitet dieselbe Notiz zeichenweise in Echtzeit, sobald zwei oder mehr Personen sie geöffnet haben. " +
          "Standardmäßig aus. Anwesenheit und Cursor funktionieren unabhängig davon.",
      )
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.enableCoedit).onChange(async (v) => {
          this.plugin.settings.enableCoedit = v;
          await this.plugin.saveSettings();
          this.plugin.reconnect();
        }),
      );

    new Setting(containerEl).setName("Vault-Synchronisation (experimentell)").setHeading();

    new Setting(containerEl)
      .setName("Ganzen Vault über den Relay synchronisieren")
      .setDesc(
        "Verteilt den Vault über den eigenen Server (Ersatz für externe Synchronisation). " +
          "Notizen werden bei Bedarf geladen: es erscheinen zunächst Platzhalter, der Inhalt wird erst " +
          "beim Öffnen einer Notiz heruntergeladen (eingebundene Bilder/PDFs kommen mit). " +
          "Experimentell: nur mit Testdaten verwenden. Nach dem Umschalten Obsidian neu laden.",
      )
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.enableVaultSync).onChange(async (v) => {
          this.plugin.settings.enableVaultSync = v;
          await this.plugin.saveSettings();
          this.plugin.reconnect();
        }),
      );

    new Setting(containerEl)
      .setName("Anmelden")
      .setDesc(
        "Prüft die obigen Daten und meldet genau, was nicht stimmt (Server-URL, Benutzername oder Passwort). " +
          "Bei aktiver Vault-Synchronisation folgt vor dem Abgleich eine Sicherheitsabfrage.",
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
            if (this.plugin.settings.enableVaultSync) {
              new ConnectModal(this.app, () => this.plugin.reconnect()).open();
            } else {
              this.plugin.reconnect();
            }
          }),
      );
  }
}
