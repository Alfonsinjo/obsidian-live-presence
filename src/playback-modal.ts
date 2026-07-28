import { type App, Modal } from "obsidian";
import { type Frame, buildFrames, listChangelog } from "./changelog";
import { diffLines } from "./history";

interface Auth {
  user: string;
  pass: string;
}

// Scrub through a note's history over time; optionally play it back. Each step
// shows the document as it was, with the lines added at that step highlighted.
export class PlaybackModal extends Modal {
  private frames: Frame[] = [];
  private timer: number | null = null;

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
    titleEl.setText(`Wiedergabe: ${this.path}`);
    contentEl.createEl("p", { text: "Lade …" });

    const entries = await listChangelog(this.serverUrl, this.auth, this.path);
    this.frames = buildFrames(entries);
    contentEl.empty();

    if (this.frames.length <= 1) {
      contentEl.createEl("p", { text: "Für diese Notiz gibt es noch keinen aufgezeichneten Verlauf." });
      return;
    }

    const max = this.frames.length - 1;

    const controls = contentEl.createDiv({ cls: "lp-playback-controls" });
    const playBtn = controls.createEl("button", { text: "▶ Abspielen" });
    const label = controls.createSpan({ cls: "lp-playback-label" });

    const slider = contentEl.createEl("input", { cls: "lp-playback-slider" });
    slider.type = "range";
    slider.min = "0";
    slider.max = String(max);
    slider.value = String(max);

    const pre = contentEl.createEl("pre", { cls: "lp-history-diff lp-playback-text" });

    const renderAt = (i: number) => {
      label.setText(`${new Date(this.frames[i].t).toLocaleString()}  ·  Schritt ${i}/${max}`);
      pre.empty();
      const prev = i > 0 ? this.frames[i - 1].text : "";
      for (const op of diffLines(prev, this.frames[i].text)) {
        if (op.type === "removed") continue; // show the document as it was at this step
        const line = pre.createDiv({ cls: "lp-diff-line" });
        line.setText(op.text.length ? op.text : " ");
        if (op.type === "added") line.addClass("lp-diff-added");
      }
    };

    const stop = () => {
      if (this.timer !== null) {
        window.clearInterval(this.timer);
        this.timer = null;
      }
      playBtn.setText("▶ Abspielen");
    };

    slider.oninput = () => {
      stop();
      renderAt(Number(slider.value));
    };

    playBtn.onClickEvent(() => {
      if (this.timer !== null) {
        stop();
        return;
      }
      if (Number(slider.value) >= max) slider.value = "0";
      playBtn.setText("⏸ Pause");
      this.timer = window.setInterval(() => {
        let v = Number(slider.value);
        if (v >= max) {
          stop();
          return;
        }
        v += 1;
        slider.value = String(v);
        renderAt(v);
      }, 700);
    });

    renderAt(max);
  }

  onClose(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.contentEl.empty();
  }
}
