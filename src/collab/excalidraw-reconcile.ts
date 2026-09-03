// Element-level reconciliation for Excalidraw scenes.
//
// Excalidraw elements carry their own version metadata (`version`, `versionNonce`,
// `updated`, `isDeleted`), and upstream Excalidraw resolves concurrent edits of the
// same element with a deterministic rule: the higher `version` wins, ties are broken
// by the lower `versionNonce`. That rule is reimplemented here (upstream's
// `reconcileElements` is not exported by the Obsidian plugin's Excalidraw build), so
// two people drawing at the same time converge on the same scene without a merge
// dialog and without losing either side's work.
//
// Everything in this module is pure: no Obsidian, no Yjs, no DOM. That keeps it
// testable headlessly, which matters because this is the code path that decides
// whether someone's drawing survives.

// Only the fields we actually reason about; a real element has many more and they
// are carried through untouched.
export interface ExcalElement {
  id: string;
  version: number;
  versionNonce: number;
  updated?: number;
  isDeleted?: boolean;
  // Fractional index that defines z-order in newer Excalidraw versions.
  index?: string;
  [key: string]: unknown;
}

// The parts of Excalidraw's appState that protect an element the local user is
// currently manipulating. Any of these being the element's id means a remote
// update for it must wait, otherwise the element would jump out from under the
// user's pointer mid-gesture.
export interface LocalGuardState {
  editingTextElementId?: string | null;
  resizingElementId?: string | null;
  newElementId?: string | null;
  draggingElementIds?: readonly string[];
}

const EMPTY_GUARD: LocalGuardState = {};

// True when the local copy of an element must be kept and the remote one dropped.
// Mirrors upstream `shouldDiscardRemoteElement`, extended by the dragging guard.
export function shouldDiscardRemoteElement(
  local: ExcalElement | undefined,
  remote: ExcalElement,
  guard: LocalGuardState = EMPTY_GUARD,
): boolean {
  if (!local) return false;
  if (
    local.id === guard.editingTextElementId ||
    local.id === guard.resizingElementId ||
    local.id === guard.newElementId ||
    guard.draggingElementIds?.includes(local.id) === true
  ) {
    return true;
  }
  if (local.version > remote.version) return true;
  // Same version on both sides: decide deterministically so every peer picks the
  // same winner. Lower versionNonce wins (upstream's rule); on a full tie the
  // local copy is kept, which is equivalent because the contents match.
  if (local.version === remote.version && local.versionNonce <= remote.versionNonce) return true;
  return false;
}

// Put elements in z-order.
//
// Newer Excalidraw versions order the scene by a fractional index string rather
// than by array position. Two people inserting into the same gap can generate the
// same index, so the element id breaks the tie - without that, two peers holding
// the same elements could still render them in a different order. Scenes whose
// elements predate the index field keep their array order untouched.
function orderByIndex(elements: ExcalElement[]): ExcalElement[] {
  if (!elements.every((el) => typeof el.index === "string")) return elements;
  return [...elements].sort((a, b) => {
    const ai = a.index as string;
    const bi = b.index as string;
    if (ai !== bi) return ai < bi ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
}

// Merge remote elements into the local scene.
//
// Returns the full element array to hand to `updateScene` (Excalidraw always
// replaces the whole array), including tombstones: an element deleted remotely
// arrives as `isDeleted: true` and must stay in the array, otherwise the deletion
// cannot propagate further and the element would come back on the next sync.
//
// Elements that did not change are returned as the *same object reference* they
// came in as. That is not cosmetic: Excalidraw caches the rendered shape per
// element object, so handing it fresh copies of an unchanged scene invalidates
// every cache entry and re-renders everything (upstream issue #9038, worst with
// freehand strokes).
export function reconcileElements(
  localElements: readonly ExcalElement[],
  remoteElements: readonly ExcalElement[],
  guard: LocalGuardState = EMPTY_GUARD,
): { elements: ExcalElement[]; changed: boolean } {
  const localById = new Map<string, ExcalElement>();
  for (const el of localElements) localById.set(el.id, el);

  const chosen = new Map<string, ExcalElement>();
  let changed = false;

  for (const remote of remoteElements) {
    const local = localById.get(remote.id);
    if (shouldDiscardRemoteElement(local, remote, guard)) {
      if (local) chosen.set(local.id, local);
      continue;
    }
    chosen.set(remote.id, remote);
    changed = true;
  }

  const out: ExcalElement[] = [];
  for (const local of localElements) {
    out.push(chosen.get(local.id) ?? local);
    chosen.delete(local.id);
  }
  // Remote-only elements, in the order the remote side listed them.
  for (const remote of remoteElements) {
    const pending = chosen.get(remote.id);
    if (pending) {
      out.push(pending);
      chosen.delete(remote.id);
    }
  }

  return { elements: orderByIndex(out), changed };
}

// A tombstone can be dropped from the shared map once it is old enough that no
// peer can still be holding a live copy of that element. Excalidraw uses the same
// 24 hour window for the elements it broadcasts. Keeping tombstones forever would
// make a busy drawing's room grow without bound; dropping them earlier would let a
// peer that was offline resurrect a deleted shape.
export const TOMBSTONE_TTL_MS = 86_400_000;

export function isExpiredTombstone(el: ExcalElement, now: number = Date.now()): boolean {
  if (el.isDeleted !== true) return false;
  const updated = typeof el.updated === "number" ? el.updated : 0;
  // No timestamp at all: keep it, rather than risk resurrecting the element.
  if (updated === 0) return false;
  return updated < now - TOMBSTONE_TTL_MS;
}

// Which of our elements are newer than what the shared map holds, i.e. what this
// client still has to publish. Comparing with the same rule used for incoming
// elements keeps both directions symmetric and stops the two sides from
// ping-ponging a value neither considers newer.
export function elementsToPublish(
  localElements: readonly ExcalElement[],
  shared: ReadonlyMap<string, ExcalElement>,
): ExcalElement[] {
  const out: ExcalElement[] = [];
  for (const local of localElements) {
    const remote = shared.get(local.id);
    if (!remote) {
      out.push(local);
      continue;
    }
    if (isNewer(local, remote)) out.push(local);
  }
  return out;
}

// Strictly newer under the version/nonce rule (the inverse of "remote wins").
export function isNewer(a: ExcalElement, b: ExcalElement): boolean {
  if (a.version > b.version) return true;
  if (a.version < b.version) return false;
  if (a.versionNonce === b.versionNonce) return false;
  return a.versionNonce < b.versionNonce;
}

// Cheap fingerprint of a scene's element state, used to skip no-op work. Deleted
// elements are included on purpose (unlike Excalidraw's own scene version hash),
// because a deletion is a change we must react to.
export function sceneFingerprint(elements: readonly ExcalElement[]): string {
  let h = 0;
  for (const el of elements) {
    // Mixing id, version and nonce is enough: any real edit bumps version+nonce.
    h = (h * 31 + hashPart(el.id)) | 0;
    h = (h * 31 + el.version) | 0;
    h = (h * 31 + el.versionNonce) | 0;
    h = (h * 31 + (el.isDeleted ? 1 : 0)) | 0;
  }
  return `${elements.length}:${(h >>> 0).toString(16)}`;
}

function hashPart(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
