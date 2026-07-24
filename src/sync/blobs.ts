import { requestUrl } from "obsidian";
import { authHeader, couchBase } from "../profile";

// Binary files (PDFs, images, ...) are stored content-addressed in a dedicated
// CouchDB database: the document id is the content hash, and the bytes live in an
// attachment. Identical content is therefore stored once (natural deduplication).
const BLOB_DB = "ksk_blobs";

function docUrl(serverUrl: string, hash: string): string {
  return `${couchBase(serverUrl)}/${BLOB_DB}/${encodeURIComponent(hash)}`;
}

export async function blobExists(
  serverUrl: string,
  user: string,
  pass: string,
  hash: string,
): Promise<boolean> {
  try {
    const res = await requestUrl({
      url: docUrl(serverUrl, hash),
      method: "GET",
      headers: { Authorization: authHeader(user, pass) },
      throw: false,
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

export async function uploadBlob(
  serverUrl: string,
  user: string,
  pass: string,
  hash: string,
  data: ArrayBuffer,
  contentType: string,
): Promise<boolean> {
  try {
    const res = await requestUrl({
      url: `${docUrl(serverUrl, hash)}/blob`,
      method: "PUT",
      headers: {
        Authorization: authHeader(user, pass),
        "Content-Type": contentType || "application/octet-stream",
      },
      body: data,
      throw: false,
    });
    // 201 created, 200 ok, 409 means another client stored the same content first.
    return res.status === 201 || res.status === 200 || res.status === 409;
  } catch {
    return false;
  }
}

export async function downloadBlob(
  serverUrl: string,
  user: string,
  pass: string,
  hash: string,
): Promise<ArrayBuffer | null> {
  try {
    const res = await requestUrl({
      url: `${docUrl(serverUrl, hash)}/blob`,
      method: "GET",
      headers: { Authorization: authHeader(user, pass) },
      throw: false,
    });
    if (res.status !== 200) return null;
    return res.arrayBuffer;
  } catch {
    return null;
  }
}
