import { type App, Modal } from "obsidian";
import { type Session, buildSessions, listChangelog } from "./changelog";
import { diffLines } from "./history";

interface Auth {
  user: string;
  pass: string;
}

// Ten minutes of inactivity starts a new session.
const SESSION_GAP_MS = 10 * 60 * 1000;

// Timeline of editing sessions with a line-level diff of what changed in each.
export class SessionTimelineModal extends Modal {
  constructor(
    app: App,
    private serverUrl: string,
    private auth: Auth,
    private path: string,
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const { contentEl, titleEl } = this;
    titleEl.setText(`Verlauf: ${this.path}`);
    contentEl.createEl("p", { text: "Lade …" });

    const entries = await listChangelog(this.serverUrl, this.auth, this.path);
    const sessions = buildSessions(entries, SESSION_GAP_MS);
    contentEl.empty();

    if (sessions.length === 0) {
      contentEl.createEl("p", {
        text: "Für diese Notiz gibt es noch keinen aufgezeichneten Verlauf. Sobald bearbeitet wird, entstehen automatisch Sitzungen.",
      });
      return;
    }

    const layout = contentEl.createDiv({ cls: "lp-history" });
    const list = layout.createDiv({ cls: "lp-history-list" });
    const detail = layout.createDiv({ cls: "lp-history-detail" });

    const show = (index: number) => {
      for (const el of Array.from(list.children)) el.removeClass("is-active");
      list.children[sessions.length - 1 - index]?.addClass("is-active");
      detail.empty();

      const s = sessions[index];
      const heading = detail.createEl("div", { cls: "lp-history-heading" });
      heading.setText(`${this.range(s)} — ${s.authors.join(", ")}`);

      const ops = diffLines(s.startText, s.endText);
      const pre = detail.createEl("pre", { cls: "lp-history-diff" });
      let changed = false;
      for (const op of ops) {
        const line = pre.createDiv({ cls: "lp-diff-line" });
        line.setText(op.text.length ? op.text : " ");
        if (op.type === "added") {
          line.addClass("lp-diff-added");
          changed = true;
        } else if (op.type === "removed") {
          line.addClass("lp-diff-removed");
          changed = true;
        }
      }
      if (!changed) detail.createEl("p", { text: "Keine Textänderungen in dieser Sitzung." });
    };

    for (let i = sessions.length - 1; i >= 0; i--) {
      const s = sessions[i];
      const row = list.createDiv({ cls: "lp-history-item" });
      row.createDiv({ cls: "lp-history-when", text: this.range(s) });
      row.createDiv({ cls: "lp-history-who", text: s.authors.join(", ") });
      row.onClickEvent(() => show(i));
    }

    show(sessions.length - 1);
  }

  private range(s: Session): string {
    const start = new Date(s.startT);
    const end = new Date(s.endT);
    const startStr = start.toLocaleString();
    // Same day: show only the end time, otherwise the full end timestamp.
    const endStr =
      start.toDateString() === end.toDateString()
        ? end.toLocaleTimeString()
        : end.toLocaleString();
    return `${startStr} – ${endStr}`;
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
