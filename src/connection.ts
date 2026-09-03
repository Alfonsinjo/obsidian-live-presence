import { requestUrl } from "obsidian";
import { authHeader, couchBase } from "./profile";

export interface ConnectionCheck {
  ok: boolean;
  reason: string;
}

// Tests the configured login and reports exactly what is wrong so setup mistakes
// are easy to fix: a missing field, an unreachable or wrong server URL, an
// unrecognised username, or a wrong password.
export async function testConnection(
  serverUrl: string,
  user: string,
  pass: string,
): Promise<ConnectionCheck> {
  if (!serverUrl) return { ok: false, reason: "Bitte zuerst die Server-URL eintragen." };
  if (!/^wss?:\/\//i.test(serverUrl))
    return { ok: false, reason: "Die Server-URL muss mit wss:// beginnen (z. B. wss://…/presence)." };
  if (!user) return { ok: false, reason: "Bitte den Login-Benutzer eintragen." };
  if (!pass) return { ok: false, reason: "Bitte das Login-Passwort eintragen." };

  const base = couchBase(serverUrl);

  // 1) Is the server reachable, and is it actually the right server? Send the
  // credentials, because the server requires a valid user even for the root
  // endpoint (require_valid_user), so an unauthenticated request answers 401.
  // A 401 with a CouchDB signature still proves we reached the right server.
  let welcome: {
    status: number;
    json?: { couchdb?: string; error?: string };
    headers?: Record<string, string>;
  };
  try {
    welcome = await requestUrl({
      url: `${base}/`,
      method: "GET",
      headers: { Authorization: authHeader(user, pass) },
      throw: false,
    });
  } catch {
    return {
      ok: false,
      reason: "Server-URL nicht erreichbar. Bitte die URL und die Netzwerkverbindung prüfen.",
    };
  }
  const serverHdr = String(welcome.headers?.server ?? welcome.headers?.Server ?? "");
  const looksLikeCouch =
    welcome.json?.couchdb === "Welcome" ||
    welcome.json?.error === "unauthorized" ||
    /couchdb/i.test(serverHdr);
  if (welcome.status === 200 && welcome.json?.couchdb !== "Welcome") {
    return { ok: false, reason: "Die Server-URL zeigt nicht auf den richtigen Server. Bitte die URL prüfen." };
  }
  if (!looksLikeCouch && welcome.status !== 401 && welcome.status !== 403) {
    return { ok: false, reason: "Die Server-URL zeigt nicht auf den richtigen Server. Bitte die URL prüfen." };
  }

  // 2) Authenticate.
  let sess: { status: number };
  try {
    sess = await requestUrl({
      url: `${base}/_session`,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: user, password: pass }),
      throw: false,
    });
  } catch {
    return {
      ok: false,
      reason: "Server-URL nicht erreichbar. Bitte die URL und die Netzwerkverbindung prüfen.",
    };
  }
  if (sess.status === 200) return { ok: true, reason: "Erfolgreich verbunden." };
  if (sess.status === 403) {
    return {
      ok: false,
      reason:
        "Konto vorübergehend gesperrt (zu viele Fehlversuche). Bitte ein bis zwei Minuten warten und erneut versuchen.",
    };
  }
  if (sess.status === 401) {
    const exists = await usernameExists(serverUrl, user);
    if (exists === false)
      return { ok: false, reason: "Benutzername nicht erkannt. Bitte den Login-Benutzer prüfen." };
    if (exists === true)
      return { ok: false, reason: "Passwort falsch. Bitte das Login-Passwort prüfen." };
    return { ok: false, reason: "Benutzername oder Passwort falsch. Bitte beides prüfen." };
  }
  return { ok: false, reason: `Unerwartete Antwort vom Server (Status ${sess.status}).` };
}

// Asks the relay whether the username exists (admin lookup) to tell an unknown
// user apart from a wrong password. Returns null if the check is unavailable.
async function usernameExists(serverUrl: string, user: string): Promise<boolean | null> {
  const httpBase = serverUrl.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:");
  try {
    const res = await requestUrl({
      url: `${httpBase}/checkuser?name=${encodeURIComponent(user)}`,
      method: "GET",
      throw: false,
    });
    if (res.status === 200 && typeof res.json?.exists === "boolean") return res.json.exists;
  } catch {
    // relay check unavailable
  }
  return null;
}
