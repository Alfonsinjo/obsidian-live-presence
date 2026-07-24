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
      .setDesc("Vor- und Nachname. Erscheint im Roster und an deinem Cursor bei den anderen.")
      .addText((t) =>
        t
          .setPlaceholder("Vorname Nachname")
          .setValue(this.plugin.settings.userName)
          .onChange(async (v) => {
            this.plugin.settings.userName = v.trim();
            await this.plugin.saveSettings();
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
      });

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
