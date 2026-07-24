import { type App, Modal, Setting } from "obsidian";

// Asks the user for their full name once (on first activation).
export class NameModal extends Modal {
  private value: string;
  private submitted = false;

  constructor(
    app: App,
    initial: string,
    private onSubmit: (name: string) => void,
  ) {
    super(app);
    this.value = initial;
  }

  onOpen(): void {
    this.titleEl.setText("Live Presence: Dein Name");
    this.contentEl.createEl("p", {
      text: "Bitte Vor- und Nachnamen eingeben. Er wird gespeichert und den anderen im Roster und am Cursor angezeigt.",
    });
    new Setting(this.contentEl).setName("Vor- und Nachname").addText((t) => {
      t.setPlaceholder("Vorname Nachname").setValue(this.value);
      t.onChange((v) => {
        this.value = v;
      });
      window.setTimeout(() => t.inputEl.focus(), 0);
      t.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") this.submit();
      });
    });
    new Setting(this.contentEl).addButton((b) =>
      b
        .setButtonText("Speichern")
        .setCta()
        .onClick(() => this.submit()),
    );
  }

  private submit(): void {
    const name = this.value.trim();
    if (!name) return;
    this.submitted = true;
    this.close();
    this.onSubmit(name);
  }

  onClose(): void {
    this.contentEl.empty();
    // If dismissed without saving, resolve the waiting promise with empty.
    if (!this.submitted) this.onSubmit("");
  }
}
