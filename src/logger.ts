import { requestUrl } from "obsidian";

// Lightweight remote logging so problems that only happen on a client (e.g. a
// co-editing timeout) can be inspected on the server. Only warnings, errors and
// a few key info events are sent; everything also goes to the developer console.
// Best effort: a failed log send is never allowed to disrupt the plugin.

type Level = "info" | "warn" | "error";

let target: { httpBase: string; user: string; version: string } | null = null;
const queue: Array<Record<string, unknown>> = [];
let flushing = false;
let lastKey = "";
let lastAt = 0;

export function configureLogger(serverUrl: string, user: string, version: string): void {
  target = {
    httpBase: serverUrl.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:"),
    user,
    version,
  };
}

export function logProblem(level: Level, msg: string, ctx?: unknown): void {
  if (level === "error") console.error(`[Live Presence] ${msg}`, ctx ?? "");
  else console.warn(`[Live Presence] ${msg}`, ctx ?? "");

  // Drop repeats of the same message within a short window to avoid flooding.
  const key = `${level}:${msg}`;
  const now = Date.now();
  if (key === lastKey && now - lastAt < 10000) return;
  lastKey = key;
  lastAt = now;

  if (!target) return;
  queue.push({ level, msg, ctx: ctx ?? null, user: target.user, v: target.version, ts: now });
  while (queue.length > 50) queue.shift();
  void flush();
}

async function flush(): Promise<void> {
  if (flushing || !target) return;
  flushing = true;
  try {
    while (queue.length && target) {
      const entry = queue.shift();
      try {
        await requestUrl({
          url: `${target.httpBase}/log`,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(entry),
          throw: false,
        });
      } catch {
        // best effort; never disrupt the plugin because a log failed
      }
    }
  } finally {
    flushing = false;
  }
}
