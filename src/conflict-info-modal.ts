import { type App, Modal, Notice } from "obsidian";

// Simple line diff: lines that are only in `a` and lines that are only in `b`.
// LCS-based; capped so a huge note cannot make it expensive.
function lineDiff(a: string, b: string): { localOnly: string[]; remoteOnly: string[] } {
  const al = a.split("\n");
  const bl = b.split("\n");
  const n = al.length;
  const m = bl.length;
  if ((n + 1) * (m + 1) > 4_000_000) {
    return { localOnly: al, remoteOnly: bl }; // too large: show both wholesale
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = al[i] === bl[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const localOnly: string[] = [];
  const remoteOnly: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (al[i] === bl[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      localOnly.push(al[i]);
      i++;
    } else {
      remoteOnly.push(bl[j]);
      j++;
    }
  }
  while (i < n) localOnly.push(al[i++]);
  while (j < m) remoteOnly.push(bl[j++]);
  return { localOnly, remoteOnly };
}

// Shown when the local copy of a note genuinely diverged from the server (both
// sides changed independently). The server version always wins; this modal
// shows exactly what differs and lets the user copy their own text first.
export class ConflictInfoModal extends Modal {
  private done = false;

  constructor(
    app: App,
    private path: string,
    private localText: string,
    private remoteText: string,
    private onDone: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    const name = this.path.replace(/\.md$/, "").split("/").pop() ?? this.path;
    titleEl.setText("Konflikt mit der Server-Version");

    contentEl.createEl("p", {
      text:
        `Deine lokale Fassung von „${name}" weicht von der Version auf dem Server ab. ` +
        "Es wird immer die Version vom Server verwendet. Unten siehst du, was sich unterscheidet.",
    });

    const { localOnly, remoteOnly } = lineDiff(this.localText, this.remoteText);
    const block = contentEl.createDiv({ cls: "lp-conflict-block" });

    const mineRow = block.createDiv({ cls: "lp-conflict-row" });
    mineRow.createDiv({ cls: "lp-conflict-label", text: "Nur in deiner Version:" });
    mineRow.createEl("pre", {
      cls: "lp-conflict-mine",
      text: localOnly.join("\n") || "(keine zusätzlichen Zeilen)",
    });

    const otherRow = block.createDiv({ cls: "lp-conflict-row" });
    otherRow.createDiv({ cls: "lp-conflict-label", text: "Auf dem Server (wird übernommen):" });
    otherRow.createEl("pre", {
      cls: "lp-conflict-other",
      text: remoteOnly.join("\n") || "(keine zusätzlichen Zeilen)",
    });

    contentEl.createEl("p", {
      text: "Deine vollständige lokale Fassung zum Herauskopieren:",
    });
    const ta = contentEl.createEl("textarea", { cls: "lp-conflict-text" });
    ta.value = this.localText;
    ta.readOnly = true;
    ta.rows = 8;

    const actions = contentEl.createDiv({ cls: "lp-conflict-actions" });
    actions.createEl("button", { text: "Text kopieren" }).onClickEvent(async () => {
      try {
        await navigator.clipboard.writeText(this.localText);
        new Notice("Text kopiert.");
      } catch {
        ta.select();
      }
    });
    actions
      .createEl("button", { text: "Server-Version übernehmen", cls: "mod-cta" })
      .onClickEvent(() => this.finish());

    contentEl.createEl("p", {
      cls: "lp-conflict-hint",
      text:
        "Wenn du deinen Text zuerst sichern möchtest, kopiere ihn heraus und schließe Obsidian, " +
        "bevor du fortfährst. Andernfalls wird die Server-Version übernommen.",
    });
  }

  private finish(): void {
    if (this.done) return;
    this.done = true;
    this.onDone();
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.done) {
      this.done = true;
      this.onDone();
    }
  }
}
