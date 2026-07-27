import { requestUrl } from "obsidian";

// Derive the CouchDB base URL from the presence server URL:
// wss://host/presence -> https://host
export function couchBase(serverUrl: string): string {
  return serverUrl
    .replace(/^wss:/i, "https:")
    .replace(/^ws:/i, "http:")
    .replace(/\/presence\/?$/i, "");
}

export function authHeader(user: string, pass: string): string {
  return `Basic ${btoa(`${user}:${pass}`)}`;
}

export interface ProfileResult {
  // Whether the server answered at all (false means unreachable/offline).
  reachable: boolean;
  // The stored display name, or null if the server has none yet.
  name: string | null;
}

// Reads the display name stored for this account in the ksk_profiles database.
// Distinguishes "server unreachable" from "no profile stored yet" so callers do
// not keep asking for the name whenever the server happens to be offline.
export async function fetchProfileName(
  serverUrl: string,
  user: string,
  pass: string,
): Promise<ProfileResult> {
  const url = `${couchBase(serverUrl)}/ksk_profiles/${encodeURIComponent(user)}`;
  try {
    const res = await requestUrl({
      url,
      method: "GET",
      headers: { Authorization: authHeader(user, pass) },
      throw: false,
    });
    if (res.status === 200) {
      const name = res.json?.name;
      return { reachable: true, name: typeof name === "string" && name.length > 0 ? name : null };
    }
    // Server answered (e.g. 404 no profile, 401 auth) -> reachable, but no usable name.
    return { reachable: true, name: null };
  } catch {
    // network/DNS error -> server not reachable
    return { reachable: false, name: null };
  }
}

// Stores the display name for this account (each account may only write its own).
export async function saveProfileName(
  serverUrl: string,
  user: string,
  pass: string,
  name: string,
): Promise<boolean> {
  const url = `${couchBase(serverUrl)}/ksk_profiles/${encodeURIComponent(user)}`;
  const headers = { Authorization: authHeader(user, pass), "Content-Type": "application/json" };
  try {
    const cur = await requestUrl({ url, method: "GET", headers, throw: false });
    const body: Record<string, unknown> = { _id: user, name };
    if (cur.status === 200 && cur.json?._rev) body._rev = cur.json._rev;
    const res = await requestUrl({ url, method: "PUT", headers, body: JSON.stringify(body), throw: false });
    return res.status === 201 || res.status === 200;
  } catch {
    return false;
  }
}
