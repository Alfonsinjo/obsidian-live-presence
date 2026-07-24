import { type Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { clamp, withAlpha } from "./utils";

export interface RemoteCursor {
  name: string;
  color: string;
  anchor: number;
  head: number;
}

// Set by the plugin to update the remote cursors shown in an editor.
export const setRemoteCursors = StateEffect.define<RemoteCursor[]>();

class CaretWidget extends WidgetType {
  constructor(
    readonly color: string,
    readonly name: string,
  ) {
    super();
  }
  eq(other: CaretWidget): boolean {
    return other.color === this.color && other.name === this.name;
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "lp-remote-caret";
    wrap.style.setProperty("--lp-color", this.color);
    const label = document.createElement("span");
    label.className = "lp-remote-label";
    label.textContent = this.name;
    wrap.appendChild(label);
    return wrap;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

function build(cursors: RemoteCursor[], docLen: number): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const c of cursors) {
    const a = clamp(c.anchor, 0, docLen);
    const h = clamp(c.head, 0, docLen);
    const from = Math.min(a, h);
    const to = Math.max(a, h);
    if (from !== to) {
      ranges.push(
        Decoration.mark({
          class: "lp-remote-sel",
          attributes: { style: `background-color:${withAlpha(c.color, 0.25)}` },
        }).range(from, to),
      );
    }
    ranges.push(
      Decoration.widget({
        widget: new CaretWidget(c.color, c.name),
        side: 1,
      }).range(h),
    );
  }
  // The `true` flag lets Decoration.set sort the ranges.
  return Decoration.set(ranges, true);
}

export const remoteCursorsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setRemoteCursors)) {
        deco = build(e.value, tr.state.doc.length);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});
