import { requestUrl } from "obsidian";

export interface VersionInfo {
  min: string;
  latest: string;
}

// Fetch the required/latest client version the server publishes, so an outdated
// client can be forced to update. Returns null if it cannot be determined (e.g.
// offline) - callers must then NOT block, to avoid locking people out on a hiccup.
export async function fetchRequiredVersion(serverUrl: string): Promise<VersionInfo | null> {
  const httpBase = serverUrl.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:");
  try {
    const res = await requestUrl({ url: `${httpBase}/version`, method: "GET", throw: false });
    if (res.status === 200 && res.json && typeof res.json.min === "string") {
      return { min: String(res.json.min), latest: String(res.json.latest || res.json.min) };
    }
  } catch {
    // unreachable
  }
  return null;
}

// True when `current` is older than `required` (dotted numeric versions).
export function isOutdated(current: string, required: string): boolean {
  return compareVersions(current, required) < 0;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
