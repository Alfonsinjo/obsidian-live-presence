import { requestUrl } from "obsidian";

// Derive the CouchDB base URL from the presence server URL:
// wss://host/presence -> https://host
function couchBase(serverUrl: string): string {
  return serverUrl
    .replace(/^wss:/i, "https:")
    .replace(/^ws:/i, "http:")
    .replace(/\/presence\/?$/i, "");
}

function authHeader(user: string, pass: string): string {
  return `Basic ${btoa(`${user}:${pass}`)}`;
}

// Reads the display name stored for this account in the ksk_profiles database.
export async function fetchProfileName(
  serverUrl: string,
  user: string,
  pass: string,
): Promise<string | null> {
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
      return typeof name === "string" && name.length > 0 ? name : null;
    }
  } catch {
    // network/DNS error -> treat as "no profile yet"
  }
  return null;
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
