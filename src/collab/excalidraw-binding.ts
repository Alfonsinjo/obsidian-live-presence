import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import {
  type ExcalElement,
  type LocalGuardState,
  elementsToPublish,
  isExpiredTombstone,
  reconcileElements,
  sceneFingerprint,
} from "./excalidraw-reconcile";

// Real-time co-editing for Excalidraw drawings.
//
// A drawing cannot use the CodeMirror binding: it is not text in an editor, it is
// a scene rendered by the Excalidraw plugin's own React view, and its file body is
// a machine-managed (usually LZ-compressed) data block. Merging that as text does
// not degrade the drawing, it destroys it - a merged LZ payload decompresses to
// nothing. So instead of sharing the file's text, this binding shares the scene's
// *elements*, one shared-map entry per element id, and lets Excalidraw's own
// version metadata decide who wins per element (see excalidraw-reconcile.ts).
//
// Consequences of that choice, which shape everything below:
//   - Two people drawing different shapes never conflict at all.
//   - Two people moving the same shape converge on one deterministic result, and
//     one whole movement wins rather than the two being averaged into a position
//     that neither person drew.
//   - Deletions travel as tombstones (`isDeleted: true`), never as map removals:
//     a removal loses against a concurrent edit and the shape comes back.
//   - The room is separate from the file's text room ("excal:" vs "doc:"), so the
//     stream of drawing updates cannot pollute the note change log.
//
// Everything Obsidian- and Excalidraw-specific is behind SceneHost, so the whole
// synchronisation path can be tested headlessly with two simulated peers.

export interface Auth {
  user: string;
  pass: string;
}
export interface User {
  // Stable identity (the login name), NOT the per-connection client id.
  // Excalidraw derives a collaborator's cursor colour from this, so anything that
  // changes on reconnect would make people change colour constantly.
  id: string;
  name: string;
  color: string;
}

// A remote participant as Excalidraw wants it (appState.collaborators).
export interface Collaborator {
  username: string;
  id: string;
  socketId: string;
  color: { background: string; stroke: string };
  pointer?: { x: number; y: number; tool: "pointer" };
  button: "up" | "down";
  selectedElementIds: Record<string, true>;
  userState: "active" | "idle" | "away";
}

// The drawing, as far as this binding is concerned. Implemented for real against
// an Excalidraw view in excalidraw-host.ts, and with a plain object in tests.
export interface SceneHost {
  // All elements including tombstones (isDeleted), which are needed to propagate
  // deletions. Must return Excalidraw's own element objects, not copies: the
  // reconciler relies on unchanged elements keeping their identity.
  getElements(): ExcalElement[];
  // Replace the scene without touching the local user's selection, viewport or
  // undo history.
  applyElements(elements: ExcalElement[]): void;
  // Ids the local user is currently manipulating; those must not be overwritten
  // from the network mid-gesture.
  getGuard(): LocalGuardState;
  // Ids of elements still being drawn (a freehand stroke in progress, a multi-point
  // line). These are deliberately not published until finished - see PUBLISH below.
  getInProgressIds(): string[];
  // Whether the local pointer is pressed, forwarded to peers as the button state.
  isPointerDown(): boolean;
  // Show the remote pointers/selections.
  setCollaborators(collaborators: Map<string, Collaborator>): void;
  // Local pointer in scene coordinates, for our own awareness broadcast.
  getPointer(): { x: number; y: number } | null;
  // Ids the local user has selected, broadcast so peers can see it.
  getSelection(): string[];
  // Subscribe to local scene changes. Must return an unsubscribe function.
  onSceneChange(cb: () => void): () => void;
  // Tell the drawing it has unsaved changes, so its own autosave persists what
  // arrived from the network.
  markDirty(): void;
}

// What a peer publishes about itself in the drawing room.
interface ExcalAwareness {
  user: User;
  pointer: { x: number; y: number } | null;
  selected: string[];
  down: boolean;
}

// Injectable connection, so tests can wire two peers together without a server.
export interface RoomConnection {
  doc: Y.Doc;
  awareness: {
    clientID: number;
    setLocalState(state: unknown): void;
    getStates(): Map<number, unknown>;
    on(event: "change", cb: () => void): void;
    off(event: "change", cb: () => void): void;
  };
  waitForSync(ms: number): Promise<boolean>;
  destroy(): void;
}
export type Connector = (room: string, auth: Auth) => RoomConnection;

// PUBLISH: how often local scene changes go out while drawing. Excalidraw reports
// a change on every pointer move (and even on plain hover), so this has to be
// throttled; 20/s is indistinguishable from instant and keeps the relay's on-disk
// update log to a few MB per session instead of tens.
const PUBLISH_INTERVAL_MS = 50;
// Pointer/selection broadcast rate. Awareness is not persisted, so this is cheap -
// but it must not be unthrottled either: re-rendering collaborators on every
// single move resets touch gestures and breaks text input on tablets.
const POINTER_INTERVAL_MS = 50;
const COLLAB_RENDER_INTERVAL_MS = 50;
const SYNC_TIMEOUT_MS = 8000;
// Expired tombstones are cleared out occasionally, not on every tick.
const TOMBSTONE_SWEEP_INTERVAL_MS = 300000;

// Origin tag for our own transactions, so we can ignore the echo of our writes.
const LOCAL_ORIGIN = "live-presence-local";

export function roomForDrawing(path: string): string {
  return `excal:${encodeURIComponent(path)}`;
}

export class ExcalidrawBinding {
  private conn: RoomConnection | null = null;
  private host: SceneHost | null = null;
  private elements: Y.Map<ExcalElement> | null = null;
  path: string | null = null;
  private user: User | null = null;
  private gen = 0;

  private unsubscribeScene: (() => void) | null = null;
  private publishTimer: ReturnType<typeof setInterval> | null = null;
  private pointerTimer: ReturnType<typeof setInterval> | null = null;
  private collabRenderTimer: ReturnType<typeof setTimeout> | null = null;
  private awarenessHandler: (() => void) | null = null;
  private observer: ((event: Y.YMapEvent<ExcalElement>, tr: Y.Transaction) => void) | null = null;

  // Set when the local scene changed since we last published.
  private dirty = false;
  // Guards against re-entry: Excalidraw fires its change callback synchronously
  // from inside updateScene, so applying a remote scene would immediately look
  // like a local edit and be written straight back to the room. An origin tag on
  // the transaction does not catch this, because that re-entrant change really is
  // local.
  private applying = false;
  // Fingerprint of the scene as of our last completed publish pass, i.e. the last
  // point at which the room held everything of ours. Used only to skip redundant
  // work - never to decide that publishing can be skipped for correctness, which
  // is a mistake that loses a joining peer's own elements.
  private publishedFingerprint = "";
  // Last pointer/selection we broadcast, to avoid pointless awareness churn.
  private lastPointerKey = "";
  private lastCollabRender = 0;
  // Signature of the collaborator set we last handed to the drawing, so an
  // unchanged set is not pushed again.
  private lastCollabKey = "";
  private lastTombstoneSweep = 0;

  constructor(
    private connector: Connector,
    private log: (level: "warn" | "error", msg: string, ctx?: unknown) => void = () => {},
  ) {}

  isActive(path: string): boolean {
    return this.conn !== null && this.path === path;
  }

  get active(): boolean {
    return this.conn !== null;
  }

  async engage(host: SceneHost, path: string, auth: Auth, user: User): Promise<boolean> {
    await this.disengage();
    const gen = ++this.gen;

    let conn: RoomConnection;
    try {
      conn = this.connector(roomForDrawing(path), auth);
    } catch (err) {
      this.log("error", "Excalidraw-Co-Editing konnte nicht verbinden", { path, err: String(err) });
      return false;
    }

    this.conn = conn;
    this.host = host;
    this.path = path;
    this.user = user;
    this.elements = conn.doc.getMap<ExcalElement>("elements");

    const synced = await conn.waitForSync(SYNC_TIMEOUT_MS);
    if (this.gen !== gen) return false;
    if (!synced) {
      this.log("warn", "Excalidraw-Co-Editing Zeitüberschreitung", { path });
      await this.disengage();
      return false;
    }

    // Initial reconciliation. Unlike shared text this needs no seed election:
    // per-element last-writer-wins is order independent, so both sides can merge
    // in any order and still end up with the same scene.
    this.mergeFromShared();
    // Forced: the merge above just changed our scene, and a fingerprint-based
    // skip here would silently drop the elements we brought with us.
    this.publishLocalChanges(true);
    this.lastTombstoneSweep = Date.now();

    // Incoming changes.
    this.observer = (_event, tr) => {
      if (tr.origin === LOCAL_ORIGIN) return;
      this.mergeFromShared();
    };
    this.elements.observe(this.observer);

    // Outgoing changes, coalesced.
    this.unsubscribeScene = host.onSceneChange(() => {
      if (this.applying) return;
      this.dirty = true;
    });
    this.publishTimer = setInterval(() => this.tick(), PUBLISH_INTERVAL_MS);

    // Presence inside the drawing.
    this.awarenessHandler = () => this.scheduleCollaboratorRender();
    conn.awareness.on("change", this.awarenessHandler);
    this.broadcastPointer(true);
    this.pointerTimer = setInterval(() => this.broadcastPointer(false), POINTER_INTERVAL_MS);
    // No sweep timer: y-protocols removes the state of a client that stops
    // reporting and emits a change for it, which is what drives the render.

    return true;
  }

  async disengage(): Promise<void> {
    this.gen++;
    const conn = this.conn;
    const host = this.host;
    const observer = this.observer;
    const elements = this.elements;

    this.conn = null;
    this.host = null;
    this.elements = null;
    this.path = null;
    this.user = null;
    this.dirty = false;
    this.applying = false;
    this.publishedFingerprint = "";
    this.lastPointerKey = "";
    this.lastCollabKey = "";

    if (this.publishTimer !== null) clearInterval(this.publishTimer);
    if (this.pointerTimer !== null) clearInterval(this.pointerTimer);
    // Also the throttling timer: left running, it would fire against the next
    // drawing's connection after a quick switch between two drawings.
    if (this.collabRenderTimer !== null) clearTimeout(this.collabRenderTimer);
    this.publishTimer = null;
    this.pointerTimer = null;
    this.collabRenderTimer = null;

    if (this.unsubscribeScene) {
      try {
        this.unsubscribeScene();
      } catch {
        // view may be gone already
      }
      this.unsubscribeScene = null;
    }
    if (elements && observer) elements.unobserve(observer);
    this.observer = null;

    if (conn && this.awarenessHandler) conn.awareness.off("change", this.awarenessHandler);
    this.awarenessHandler = null;

    // Leave no stale cursor behind for the peers, and none of theirs for us.
    if (conn) {
      try {
        conn.awareness.setLocalState(null);
      } catch {
        // ignore
      }
    }
    if (host) {
      try {
        host.setCollaborators(new Map());
      } catch {
        // view may be gone already
      }
    }
    if (conn) conn.destroy();
  }

  // --- element flow ---------------------------------------------------------

  // One synchronisation step. Merging on every tick (not only when a remote
  // update arrives) is what makes the binding self-healing: an element that was
  // withheld because the local user was dragging it, or one whose local copy
  // turned out not to be the newer of the two, is picked up on the next tick
  // instead of leaving the two sides permanently apart. Reconciliation returns
  // "nothing changed" for an already-merged scene, so an idle drawing costs one
  // array walk per tick and produces no traffic.
  private tick(): void {
    this.mergeFromShared();
    if (this.dirty) {
      this.dirty = false;
      this.publishLocalChanges();
    }
    this.sweepTombstones();
  }

  // Take everything from the shared map that is newer than our copy.
  private mergeFromShared(): void {
    const host = this.host;
    const shared = this.elements;
    if (!host || !shared || this.applying) return;

    const remote: ExcalElement[] = [];
    // Copies: the stored objects belong to the shared document, and Excalidraw
    // mutates scene elements in place. Handing it our stored value would corrupt
    // the room's own state.
    shared.forEach((el) => remote.push({ ...el }));
    if (remote.length === 0) return;

    const local = host.getElements();
    const { elements, changed } = reconcileElements(local, remote, host.getGuard());
    if (!changed) return;

    this.applying = true;
    try {
      host.applyElements(elements);
      host.markDirty();
    } finally {
      this.applying = false;
    }
    // Ask for one publish pass afterwards. It normally finds nothing (what we
    // merged came from the room), but it is the safety net that re-asserts a
    // local element the room turns out not to have.
    this.dirty = true;
  }

  // Publish everything of ours the shared map does not have in at least as new a
  // version. Runs in one transaction tagged as local, so our own observer ignores it.
  private publishLocalChanges(force = false): void {
    const host = this.host;
    const shared = this.elements;
    const conn = this.conn;
    if (!host || !shared || !conn) return;

    const local = host.getElements();
    const fingerprint = sceneFingerprint(local);
    if (!force && fingerprint === this.publishedFingerprint) return;

    // An unfinished stroke is deliberately not streamed. A single 300-point
    // freehand stroke published point by point produces roughly a megabyte of
    // updates; published once when the pointer is released it is a few kilobytes,
    // and nobody misses the intermediate states of someone else's stroke. The
    // release fires a change of its own, so the finished stroke goes out then.
    const inProgress = new Set(host.getInProgressIds());
    const publishable = inProgress.size === 0 ? local : local.filter((el) => !inProgress.has(el.id));

    const current = new Map<string, ExcalElement>();
    shared.forEach((el, id) => current.set(id, el));
    const outgoing = elementsToPublish(publishable, current);
    // Only claim to be in sync once nothing is being held back, otherwise the
    // finished stroke would be skipped as "already published".
    if (inProgress.size === 0) this.publishedFingerprint = fingerprint;
    if (outgoing.length === 0) return;

    conn.doc.transact(() => {
      // Copies, and this is not optional. Y.Map stores a plain object by
      // reference and hands the same reference back, while Excalidraw mutates
      // its scene elements in place. Storing the live object would make the
      // shared value change silently underneath us: Yjs would broadcast
      // nothing, and every later comparison would find local and shared equal.
      // The visible effect is shapes that appear and vanish but never move.
      for (const el of outgoing) shared.set(el.id, { ...el });
    }, LOCAL_ORIGIN);
  }

  // Publish immediately, e.g. right before the drawing is closed, so the last
  // strokes are not lost in the throttle window.
  flush(): void {
    this.dirty = false;
    this.publishLocalChanges(true);
  }

  // Drop tombstones nobody can still contradict, so a long-lived drawing room
  // does not grow for ever. Only one peer needs to do it; doing it from several
  // is harmless (deleting an absent key is a no-op).
  private sweepTombstones(): void {
    const shared = this.elements;
    const conn = this.conn;
    if (!shared || !conn) return;
    const now = Date.now();
    if (now - this.lastTombstoneSweep < TOMBSTONE_SWEEP_INTERVAL_MS) return;
    this.lastTombstoneSweep = now;

    const expired: string[] = [];
    shared.forEach((el, id) => {
      if (isExpiredTombstone(el, now)) expired.push(id);
    });
    if (expired.length === 0) return;
    conn.doc.transact(() => {
      for (const id of expired) shared.delete(id);
    }, LOCAL_ORIGIN);
  }

  // --- presence flow --------------------------------------------------------

  private broadcastPointer(force: boolean): void {
    const host = this.host;
    const conn = this.conn;
    const user = this.user;
    if (!host || !conn || !user) return;

    const pointer = host.getPointer();
    const selected = host.getSelection();
    const down = host.isPointerDown();
    const key = `${pointer ? `${Math.round(pointer.x)},${Math.round(pointer.y)}` : "-"}|${down ? "d" : "u"}|${selected.join(",")}`;
    if (!force && key === this.lastPointerKey) return;
    this.lastPointerKey = key;

    const state: ExcalAwareness = { user, pointer, selected, down };
    conn.awareness.setLocalState(state as unknown as Record<string, unknown>);
  }

  // Collaborator rendering goes through updateScene, so it is throttled: peers
  // report their pointers many times a second and re-rendering on each report
  // would both waste work and interfere with touch gestures.
  private scheduleCollaboratorRender(): void {
    if (this.collabRenderTimer !== null) return;
    const since = Date.now() - this.lastCollabRender;
    if (since >= COLLAB_RENDER_INTERVAL_MS) {
      this.renderCollaborators();
      return;
    }
    this.collabRenderTimer = setTimeout(() => {
      this.collabRenderTimer = null;
      this.renderCollaborators();
    }, COLLAB_RENDER_INTERVAL_MS - since);
  }

  private renderCollaborators(): void {
    const host = this.host;
    const conn = this.conn;
    if (!host || !conn) return;
    this.lastCollabRender = Date.now();

    const map = new Map<string, Collaborator>();
    conn.awareness.getStates().forEach((raw, clientId) => {
      // Our own state is in here too, and it changes every time we move the
      // mouse - which is why the result is compared before being applied.
      if (clientId === conn.awareness.clientID) return;
      const s = raw as ExcalAwareness | null;
      if (!s || !s.user) return;
      map.set(String(clientId), toCollaborator(String(clientId), s));
    });

    // Applying collaborators goes through updateScene, and doing that when
    // nothing about the peers changed is the re-render that interferes with
    // touch gestures and text entry.
    const key = collaboratorKey(map);
    if (key === this.lastCollabKey) return;
    this.lastCollabKey = key;
    host.setCollaborators(map);
  }
}

// Compact signature of a collaborator set: identity, pointer, press state and
// selection - everything the drawing actually renders.
function collaboratorKey(map: Map<string, Collaborator>): string {
  const parts: string[] = [];
  for (const [id, c] of [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const p = c.pointer ? `${Math.round(c.pointer.x)},${Math.round(c.pointer.y)}` : "-";
    parts.push(`${id}:${c.username}:${p}:${c.button}:${Object.keys(c.selectedElementIds).join("+")}`);
  }
  return parts.join("|");
}

export function toCollaborator(socketId: string, s: ExcalAwareness): Collaborator {
  const selectedElementIds: Record<string, true> = {};
  for (const elementId of s.selected ?? []) selectedElementIds[elementId] = true;
  return {
    username: s.user.name,
    // Stable across reconnects, unlike socketId - Excalidraw hashes this into the
    // cursor colour and uses it to deduplicate the participant list.
    id: s.user.id || socketId,
    socketId,
    color: { background: s.user.color, stroke: s.user.color },
    pointer: s.pointer ? { x: s.pointer.x, y: s.pointer.y, tool: "pointer" } : undefined,
    button: s.down ? "down" : "up",
    selectedElementIds,
    userState: "active",
  };
}

// Default connector: a WebSocket room on the relay, authenticated like every
// other room (credentials checked by the server before the upgrade).
export function websocketConnector(serverUrl: string): Connector {
  return (room, auth) => {
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(serverUrl, room, doc, {
      connect: true,
      params: { u: auth.user, p: auth.pass },
    });
    return {
      doc,
      awareness: provider.awareness as unknown as RoomConnection["awareness"],
      waitForSync: (ms: number) =>
        new Promise<boolean>((resolve) => {
          if (provider.synced) {
            resolve(true);
            return;
          }
          const timer = setTimeout(() => resolve(false), ms);
          provider.once("sync", (isSynced: boolean) => {
            clearTimeout(timer);
            resolve(isSynced);
          });
        }),
      destroy: () => {
        provider.destroy();
        doc.destroy();
      },
    };
  };
}
