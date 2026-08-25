import * as Y from "yjs";
import type { ChangeEntry } from "./changelog";
import { base64ToBytes, colorFromName } from "./utils";

interface YItem {
  deleted: boolean;
  content: { str?: string };
  id: { client: number; clock: number };
  right: YItem | null;
}

// A run of current text attributed to one author on one day.
export interface TimedRun {
  text: string;
  name: string;
  color: string;
  t: number;
}

export interface DayInfo {
  day: string; // Date.toDateString() key
  label: string;
  authors: string[];
}

// Replay the change log to attribute each run of the current text to the author
// (client id -> name/colour from the authors map) and the time it was written
// (from the clock range each logged update introduced).
export function reconstructHistory(entries: ChangeEntry[]): { runs: TimedRun[]; days: DayInfo[] } {
  const doc = new Y.Doc({ gc: false });
  const timeIndex = new Map<number, { start: number; end: number; time: number }[]>();

  for (const e of entries) {
    const update = base64ToBytes(e.u);
    try {
      const meta = Y.parseUpdateMeta(update);
      for (const [client, from] of meta.from) {
        const to = meta.to.get(client) ?? from;
        const arr = timeIndex.get(client) ?? [];
        arr.push({ start: from, end: to, time: e.t1 });
        timeIndex.set(client, arr);
      }
    } catch {
      // ignore updates we cannot parse for timing
    }
    Y.applyUpdate(doc, update);
  }

  const authors = doc.getMap("authors");
  const nameOf = (client: number): { name: string; color: string } => {
    const a = authors.get(String(client)) as { name?: string; color?: string } | undefined;
    const name = a?.name || "Unbekannt";
    return { name, color: a?.color || colorFromName(name) };
  };
  const timeOf = (client: number, clock: number): number => {
    const arr = timeIndex.get(client);
    if (!arr) return 0;
    for (const iv of arr) if (clock >= iv.start && clock < iv.end) return iv.time;
    return arr.length ? arr[arr.length - 1].time : 0;
  };

  const text = doc.getText("content") as unknown as { _start: YItem | null };
  const runs: TimedRun[] = [];
  let item = text._start;
  while (item) {
    if (!item.deleted && typeof item.content?.str === "string") {
      const { name, color } = nameOf(item.id.client);
      const t = timeOf(item.id.client, item.id.clock);
      const day = new Date(t).toDateString();
      const last = runs[runs.length - 1];
      if (last && last.name === name && new Date(last.t).toDateString() === day) {
        last.text += item.content.str;
      } else {
        runs.push({ text: item.content.str, name, color, t });
      }
    }
    item = item.right;
  }

  const dayMap = new Map<string, { t: number; authors: Set<string> }>();
  for (const r of runs) {
    const day = new Date(r.t).toDateString();
    const entry = dayMap.get(day) ?? { t: r.t, authors: new Set<string>() };
    entry.authors.add(r.name);
    if (r.t < entry.t) entry.t = r.t;
    dayMap.set(day, entry);
  }
  const days: DayInfo[] = [...dayMap.entries()]
    .sort((a, b) => a[1].t - b[1].t)
    .map(([day, info]) => ({ day, label: new Date(info.t).toLocaleDateString(), authors: [...info.authors] }));

  return { runs, days };
}
