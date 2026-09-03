import type { App, TFile, WorkspaceLeaf } from "obsidian";
import type { Collaborator, SceneHost } from "./excalidraw-binding";
import type { ExcalElement, LocalGuardState } from "./excalidraw-reconcile";
import { sceneFingerprint } from "./excalidraw-reconcile";

// Adapter between the Excalidraw plugin's view and our SceneHost interface.
//
// The Excalidraw plugin (zsviczian/obsidian-excalidraw-plugin) is not a
// dependency and its view class is not exported, so everything here is reached
// through documented-by-usage runtime surfaces and guarded with feature checks:
// if a future version drops one of them, co-editing switches itself off instead
// of throwing. This is deliberately the only file that knows those details.

export const EXCALIDRAW_VIEW_TYPE = "excalidraw";

// Only the members we use. `captureUpdate: "NEVER"` keeps a remote change out of
// the local user's undo history - the value is a plain string upstream, so no
// import from Excalidraw is needed.
interface ExcalidrawApi {
  getSceneElementsIncludingDeleted?: () => readonly ExcalElement[];
  getSceneElements?: () => readonly ExcalElement[];
  getAppState?: () => Record<string, unknown> | undefined;
  updateScene?: (data: {
    elements?: readonly ExcalElement[];
    collaborators?: Map<string, Collaborator>;
    captureUpdate?: string;
  }) => void;
  onIncrement?: Subscribe;
  onChange?: Subscribe;
  onPointerDown?: Subscribe;
  onPointerUp?: Subscribe;
}

// Excalidraw's imperative subscriptions all return an unsubscribe function. Only
// onIncrement passes an argument we care about (the increment's "durable" kind),
// so one signature covers all of them.
type Subscribe = (cb: (event?: { type?: string }) => void) => (() => void) | undefined;

interface ExcalidrawViewLike {
  _loaded?: boolean;
  file?: TFile | null;
  excalidrawAPI?: ExcalidrawApi;
  currentPosition?: { x: number; y: number };
  getViewType?: () => string;
  setDirty?: () => void;
}

// How often the scene is polled when the Excalidraw build offers no change
// subscription at all. Only a fallback; the subscriptions are the normal path.
const POLL_INTERVAL_MS = 150;

// A drawing by path or by frontmatter, matching how the Excalidraw plugin itself
// decides. Used to keep drawings out of the text-based sync paths even when no
// Excalidraw view is open.
export function isDrawingFile(app: App, path: string): boolean {
  if (/\.excalidraw(\.md)?$/i.test(path)) return true;
  const file = app.vault.getAbstractFileByPath(path);
  if (!file || !("extension" in file)) return false;
  const fm = app.metadataCache.getFileCache(file as TFile)?.frontmatter;
  return fm != null && fm["excalidraw-plugin"] != null;
}

// The active drawing that is ready to be co-edited, or null.
export function activeDrawingView(app: App): ExcalidrawViewLike | null {
  const leaf: WorkspaceLeaf | null = app.workspace.getMostRecentLeaf?.() ?? null;
  const candidate = (leaf?.view ?? null) as ExcalidrawViewLike | null;
  if (candidate && isReadyDrawing(candidate)) return candidate;
  // The most recent leaf can be a sidebar; fall back to scanning drawing leaves.
  for (const l of app.workspace.getLeavesOfType(EXCALIDRAW_VIEW_TYPE)) {
    const view = l.view as unknown as ExcalidrawViewLike;
    if (isReadyDrawing(view)) return view;
  }
  return null;
}

function isReadyDrawing(view: ExcalidrawViewLike | null): boolean {
  if (!view) return false;
  if (view.getViewType?.() !== EXCALIDRAW_VIEW_TYPE) return false;
  // The plugin's own readiness test: the view is mounted and its scene API exists.
  return view._loaded === true && view.excalidrawAPI != null;
}

// Build a SceneHost for one open drawing. Returns null when the view does not
// expose the pieces we need, so the caller can skip co-editing for it.
export function createSceneHost(view: ExcalidrawViewLike): SceneHost | null {
  const api = view.excalidrawAPI;
  if (!api || typeof api.updateScene !== "function") return null;
  const readAll = api.getSceneElementsIncludingDeleted ?? api.getSceneElements;
  if (typeof readAll !== "function") return null;

  // Whether the pointer is currently down. Combined with the selection this is
  // what protects a shape being dragged: Excalidraw's appState names the element
  // being created or resized, but a plain drag only shows up as a selection.
  let pointerDown = false;

  return {
    getElements(): ExcalElement[] {
      // Excalidraw's own objects, deliberately NOT copies: the reconciler returns
      // unchanged elements by reference, and Excalidraw caches each element's
      // rendered shape per object. Handing it fresh copies would invalidate every
      // cache entry on every merge (upstream issue #9038).
      return [...readAll.call(api)];
    },

    applyElements(elements: ExcalElement[]): void {
      // No appState: the local user's selection, viewport, zoom and active tool
      // stay exactly as they are. No history entry either.
      api.updateScene?.({ elements, captureUpdate: "NEVER" });
    },

    getGuard(): LocalGuardState {
      const state = api.getAppState?.() ?? {};
      const idOf = (key: string): string | null => {
        const value = state[key] as { id?: string } | null | undefined;
        return value?.id ?? null;
      };
      const selected = state["selectedElementIds"] as Record<string, boolean> | undefined;
      return {
        editingTextElementId: idOf("editingTextElement") ?? idOf("editingElement"),
        resizingElementId: idOf("resizingElement"),
        newElementId: idOf("newElement") ?? idOf("draggingElement"),
        // While the pointer is held down, everything selected is being moved.
        draggingElementIds: pointerDown && selected ? Object.keys(selected) : [],
      };
    },

    getInProgressIds(): string[] {
      // A stroke or multi-point line that is still being drawn. Excalidraw names
      // it in appState while the gesture runs; publishing every intermediate
      // point of it would cost orders of magnitude more traffic than sending the
      // finished shape once.
      const state = api.getAppState?.() ?? {};
      const ids: string[] = [];
      for (const key of ["newElement", "multiElement", "draggingElement"]) {
        const id = (state[key] as { id?: string } | null | undefined)?.id;
        if (id) ids.push(id);
      }
      return ids;
    },

    isPointerDown(): boolean {
      return pointerDown;
    },

    setCollaborators(collaborators: Map<string, Collaborator>): void {
      api.updateScene?.({ collaborators, captureUpdate: "NEVER" });
    },

    getPointer(): { x: number; y: number } | null {
      const p = view.currentPosition;
      return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null;
    },

    getSelection(): string[] {
      const selected = api.getAppState?.()?.["selectedElementIds"] as
        | Record<string, boolean>
        | undefined;
      return selected ? Object.keys(selected) : [];
    },

    onSceneChange(cb: () => void): () => void {
      const unsubscribers: Array<() => void> = [];

      const track = (fn: Subscribe | undefined, handler: (event?: { type?: string }) => void): boolean => {
        if (typeof fn !== "function") return false;
        try {
          const off = fn.call(api, handler);
          if (typeof off === "function") unsubscribers.push(off);
          return true;
        } catch {
          return false;
        }
      };

      // Pointer state feeds the drag guard above.
      track(api.onPointerDown, () => {
        pointerDown = true;
      });
      track(api.onPointerUp, () => {
        pointerDown = false;
        cb();
      });

      // onChange is the right source here even though it fires on every pointer
      // move: we throttle ourselves, and we *want* the intermediate positions -
      // they are what makes a shape appear to glide on the other screen instead
      // of jumping only once the drag is released. Increments are the fallback,
      // since they report committed changes only.
      let subscribed = track(api.onChange, cb);
      if (!subscribed && typeof api.onIncrement === "function") {
        subscribed = track(api.onIncrement, (event) => {
          if (event && event.type !== undefined && event.type !== "durable") return;
          cb();
        });
      }

      if (!subscribed) {
        // Last resort: watch the scene ourselves. Correct, just chattier.
        let last = sceneFingerprint(readAll.call(api));
        const timer = window.setInterval(() => {
          const now = sceneFingerprint(readAll.call(api));
          if (now === last) return;
          last = now;
          cb();
        }, POLL_INTERVAL_MS);
        unsubscribers.push(() => window.clearInterval(timer));
      }

      return () => {
        for (const off of unsubscribers) {
          try {
            off();
          } catch {
            // view may already be gone
          }
        }
      };
    },

    markDirty(): void {
      // Lets the drawing's own autosave write the merged scene to disk.
      try {
        view.setDirty?.();
      } catch {
        // older builds without the helper simply autosave on their own schedule
      }
    },
  };
}
