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

function hslToHex(h: number, s: number, l: number): string {
  const sN = s / 100;
  const lN = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sN * Math.min(lN, 1 - lN);
  const f = (n: number) => lN - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x: number) =>
    Math.round(255 * x)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

// Stable, well-spread colour derived from a name, as a hex value.
export function colorFromName(name: string): string {
  let hash = 0;
  const s = name || "?";
  for (let i = 0; i < s.length; i++) {
    hash = (hash << 5) - hash + s.charCodeAt(i);
    hash |= 0;
  }
  return hslToHex(Math.abs(hash) % 360, 60, 45);
}

// Turn a colour into an rgba()/hsla() string with the given alpha (selection background).
export function withAlpha(color: string, alpha: number): string {
  const c = color.trim();
  let r: number | null = null;
  let g = 0;
  let b = 0;
  if (/^#[0-9a-f]{6}$/i.test(c)) {
    r = parseInt(c.slice(1, 3), 16);
    g = parseInt(c.slice(3, 5), 16);
    b = parseInt(c.slice(5, 7), 16);
  } else if (/^#[0-9a-f]{3}$/i.test(c)) {
    r = parseInt(c[1] + c[1], 16);
    g = parseInt(c[2] + c[2], 16);
    b = parseInt(c[3] + c[3], 16);
  }
  if (r !== null) return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  const hsl = c.match(/^hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/i);
  if (hsl) return `hsla(${hsl[1]}, ${hsl[2]}%, ${hsl[3]}%, ${alpha})`;
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
