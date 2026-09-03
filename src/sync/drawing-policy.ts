// How whole-vault sync must treat Excalidraw drawings.
//
// A drawing has two transports at once and they must not fight:
//
//   * the drawing room ("excal:<path>") carries the scene element by element and
//     is the authority while anyone has the drawing open;
//   * the file's text room ("doc:<path>") carries the file only so that peers who
//     do NOT have it open still receive it, and so a new device can get it at all.
//
// Left to its normal rules, whole-vault sync would break this. Two clients that
// merged the same scene still write byte-different files (each Excalidraw autosave
// serialises its own viewport, its own element order, and re-compresses the data
// block), so a content-hash comparison reports "both sides changed" forever: the
// clients would push over each other in a loop, and each pull would rewrite a file
// that the drawing has open. Worse, the text path would line-merge a compressed
// data block, which cannot survive a merge.
//
// So drawings get a narrower contract: the file is published when it is genuinely
// new or when a co-editing session ends, and it is fetched only when the local copy
// is missing. Byte differences between two semantically equal drawings are ignored
// on purpose. Everything here is a pure decision function, so the rules are testable
// on their own.

export type DrawingAction =
  // Do nothing: the drawing room owns the content.
  | "ignore"
  // Send the local file so peers (and new devices) can get this drawing.
  | "publish"
  // Fetch it: we have no local copy at all.
  | "fetch";

export interface DrawingState {
  // Is there a local file for this path?
  existsLocally: boolean;
  // Does the shared index list the path (any entry, including a tombstone)?
  inIndex: boolean;
  // Is the index entry a tombstone (deleted elsewhere)?
  tombstone: boolean;
  // Is a co-editing session for this drawing currently attached?
  engaged: boolean;
}

// A local file change (an Excalidraw autosave, usually). Autosave fires on a timer
// and on every blur, and its bytes differ from every peer's, so publishing here
// would be the loop described above. The one case worth publishing is a drawing the
// shared index has never heard of: without that, a newly created drawing would stay
// invisible to everyone else.
export function onLocalDrawingChange(state: DrawingState): DrawingAction {
  if (state.tombstone) return "ignore";
  if (!state.inIndex) return "publish";
  return "ignore";
}

// The periodic full pass over the vault.
export function onDrawingReconcile(state: DrawingState): DrawingAction {
  if (state.tombstone) return "ignore"; // deletion is handled by the delete path
  if (!state.existsLocally) return "fetch";
  if (!state.inIndex) return "publish";
  return "ignore";
}

// An index entry changed on the server.
export function onDrawingIndexChange(state: DrawingState): DrawingAction {
  if (state.tombstone) return "ignore"; // deletion is handled by the delete path
  // A local copy exists: whatever the entry says about its bytes is irrelevant,
  // because the scene itself travels through the drawing room.
  if (state.existsLocally) return "ignore";
  return "fetch";
}

// A co-editing session just ended (drawing closed, or co-editing switched off).
// This is the moment the at-rest copy is refreshed, so peers who never opened the
// drawing still end up with the current version.
export function onDrawingDisengage(state: DrawingState): DrawingAction {
  if (!state.existsLocally) return "ignore";
  if (state.tombstone) return "ignore";
  return "publish";
}

// Drawings must never go through the three-way line merge used for notes: their
// body is one machine-generated (usually LZ-compressed) block, and a line merge of
// it produces a file that no longer opens. A drawing is published as-is; conflicting
// edits were already resolved element by element in the drawing room.
export function drawingUsesRawPush(): true {
  return true;
}
