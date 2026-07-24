import type { EditorView } from "@codemirror/view";
import type * as Y from "yjs";

export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): (...args: A) => void {
  let t: ReturnType<typeof setTimeout> | null = null;
  return (...args: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn(...args);
    }, ms);
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Stable, well-spread colour derived from a name (HSL).
export function colorFromName(name: string): string {
  let hash = 0;
  const s = name || "?";
  for (let i = 0; i < s.length; i++) {
    hash = (hash << 5) - hash + s.charCodeAt(i);
    hash |= 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 60%, 45%)`;
}

// Add an alpha channel to an hsl() colour (used for the selection background).
export function withAlpha(color: string, alpha: number): string {
  const m = color.match(/^hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/i);
  if (m) return `hsla(${m[1]}, ${m[2]}%, ${m[3]}%, ${alpha})`;
  return color;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n|\r/g, "\n");
}

// Apply the minimal prefix/suffix diff of newContent onto a Y.Text.
export function applyMinimalYTextUpdate(doc: Y.Doc, text: Y.Text, newContent: string): void {
  const oldContent = text.toString();
  if (oldContent === newContent) return;

  let prefix = 0;
  const minLen = Math.min(oldContent.length, newContent.length);
  while (prefix < minLen && oldContent[prefix] === newContent[prefix]) prefix++;

  let oldSuffix = oldContent.length;
  let newSuffix = newContent.length;
  while (
    oldSuffix > prefix &&
    newSuffix > prefix &&
    oldContent[oldSuffix - 1] === newContent[newSuffix - 1]
  ) {
    oldSuffix--;
    newSuffix--;
  }

  doc.transact(() => {
    if (oldSuffix > prefix) text.delete(prefix, oldSuffix - prefix);
    if (newSuffix > prefix) text.insert(prefix, newContent.slice(prefix, newSuffix));
  });
}

// Same minimal diff, but applied to the editor as a single CodeMirror transaction.
export function applyMinimalCmUpdate(view: EditorView, newContent: string): void {
  const old = view.state.doc.toString();
  if (old === newContent) return;

  let prefix = 0;
  const minLen = Math.min(old.length, newContent.length);
  while (prefix < minLen && old[prefix] === newContent[prefix]) prefix++;

  let oldSuffix = old.length;
  let newSuffix = newContent.length;
  while (oldSuffix > prefix && newSuffix > prefix && old[oldSuffix - 1] === newContent[newSuffix - 1]) {
    oldSuffix--;
    newSuffix--;
  }

  view.dispatch({
    changes: { from: prefix, to: oldSuffix, insert: newContent.slice(prefix, newSuffix) },
  });
}
