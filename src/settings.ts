import { type App, PluginSettingTab, Setting } from "obsidian";
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
      .setDesc("Deine Cursor-Farbe. Vorbelegt anhand deines Namens.")
      .addColorPicker((cp) =>
        cp
          .setValue(this.plugin.settings.color || colorFromName(this.plugin.settings.userName || "Anonym"))
          .onChange(async (v) => {
            this.plugin.settings.color = v;
            await this.plugin.saveSettings();
          }),
      );

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

    new Setting(containerEl)
      .setName("Anmelden")
      .setDesc("Mit den obigen Daten verbinden und die Verbindung testen. Das Ergebnis erscheint als Hinweis.")
      .addButton((b) =>
        b
          .setButtonText("Anmelden / Verbindung testen")
          .setCta()
          .onClick(() => {
            this.plugin.reconnect();
          }),
      );
  }
}
