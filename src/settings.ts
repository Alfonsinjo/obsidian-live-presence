import { type App, PluginSettingTab, Setting } from "obsidian";
import type LivePresencePlugin from "./main";

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
      .setName("Farbe (optional)")
      .setDesc("Feste Farbe als hsl(...) oder #hex. Leer = automatisch aus dem Namen.")
      .addText((t) =>
        t
          .setPlaceholder("automatisch")
          .setValue(this.plugin.settings.color)
          .onChange(async (v) => {
            this.plugin.settings.color = v.trim();
            await this.plugin.saveSettings();
          }),
      );

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
      .setName("Neu verbinden")
      .setDesc("Übernimmt Name, Login und Server sofort und verbindet neu.")
      .addButton((b) =>
        b.setButtonText("Neu verbinden").onClick(() => {
          this.plugin.reconnect();
        }),
      );
  }
}
