import { type Extension, type Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, type Panel, showPanel } from "@codemirror/view";

export interface OverlayRun {
  from: number;
  to: number;
  color: string;
  label: string;
}

export interface FadedRange {
  from: number;
  to: number;
}

export interface OverlayData {
  // Author-coloured background runs (with a hover label).
  runs: OverlayRun[];
  // Ranges to grey out (text that did not yet exist at the chosen time).
  faded: FadedRange[];
  legend: { label: string; color: string }[];
  title: string;
}

export const setOverlay = StateEffect.define<OverlayData | null>();

const overlayField = StateField.define<OverlayData | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setOverlay)) return e.value;
    if (!value || !tr.docChanged) return value;
    // Keep the overlay aligned across edits (e.g. incoming co-editing changes)
    // by mapping the offsets, instead of dropping it on every change.
    const runs = value.runs
      .map((r) => ({ ...r, from: tr.changes.mapPos(r.from, 1), to: tr.changes.mapPos(r.to, -1) }))
      .filter((r) => r.from < r.to);
    const faded = value.faded
      .map((f) => ({ ...f, from: tr.changes.mapPos(f.from, 1), to: tr.changes.mapPos(f.to, -1) }))
      .filter((f) => f.from < f.to);
    return { ...value, runs, faded };
  },
});

const overlayDecorations = EditorView.decorations.compute([overlayField], (state): DecorationSet => {
  const data = state.field(overlayField);
  if (!data) return Decoration.none;
  const ranges: Range<Decoration>[] = [];
  for (const r of data.runs) {
    if (r.from < r.to) {
      ranges.push(
        Decoration.mark({
          attributes: { style: `background-color:${r.color};`, title: r.label },
        }).range(r.from, r.to),
      );
    }
  }
  for (const f of data.faded) {
    if (f.from < f.to) {
      ranges.push(Decoration.mark({ class: "lp-faded" }).range(f.from, f.to));
    }
  }
  // Let CodeMirror sort the (disjoint) ranges.
  return Decoration.set(ranges, true);
});

function buildPanel(data: OverlayData): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "lp-overlay-panel";
  const title = document.createElement("span");
  title.className = "lp-overlay-title";
  title.textContent = data.title;
  dom.appendChild(title);
  for (const item of data.legend) {
    const chip = document.createElement("span");
    chip.className = "lp-overlay-chip";
    const dot = document.createElement("span");
    dot.className = "lp-overlay-dot";
    dot.style.backgroundColor = item.color;
    chip.appendChild(dot);
    chip.appendChild(document.createTextNode(item.label));
    dom.appendChild(chip);
  }
  return dom;
}

const overlayPanel = showPanel.compute([overlayField], (state): (() => Panel) | null => {
  const data = state.field(overlayField);
  if (!data) return null;
  return () => ({ dom: buildPanel(data), top: true });
});

export function inlineOverlayExtension(): Extension {
  return [overlayField, overlayDecorations, overlayPanel];
}
