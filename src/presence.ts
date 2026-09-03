import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import type { Awareness } from "y-protocols/awareness";
import type { PresenceState, RemoteEntry } from "./types";
import { debounce } from "./utils";

// Connection to the shared "presence" room. Carries awareness only
// (who is here, active file, cursor); never document content.
export class PresenceConnection {
  private doc: Y.Doc;
  private provider: WebsocketProvider | null = null;
  awareness: Awareness | null = null;
  private changeCbs: Array<() => void> = [];
  private statusCbs: Array<(status: string) => void> = [];

  // Coalesce change notifications so we do not redraw on every keystroke.
  private emitChange = debounce(() => {
    for (const cb of this.changeCbs) cb();
  }, 60);

  constructor(
    private serverUrl: string,
    private user: { name: string; color: string },
    private auth: { user: string; pass: string },
  ) {
    this.doc = new Y.Doc();
  }

  connect(): void {
    if (this.provider) return;
    this.provider = new WebsocketProvider(this.serverUrl, "presence", this.doc, {
      connect: true,
      // Credentials are validated by the server against CouchDB before the upgrade.
      params: { u: this.auth.user, p: this.auth.pass },
    });
    this.awareness = this.provider.awareness;
    this.setState({ user: this.user, login: this.auth.user, file: null, cursor: null, ts: Date.now() });
    this.awareness.on("change", this.emitChange);
    this.provider.on("status", (e: { status: string }) => {
      if (e.status === "connected") {
        // Re-assert our state after a reconnect.
        this.touch();
        this.emitChange();
      }
      for (const cb of this.statusCbs) cb(e.status);
    });
    this.provider.on("connection-error", () => {
      for (const cb of this.statusCbs) cb("error");
    });
  }

  private setState(s: PresenceState): void {
    this.awareness?.setLocalState(s as unknown as Record<string, unknown>);
  }

  private patch(p: Partial<PresenceState>): void {
    const cur =
      (this.awareness?.getLocalState() as unknown as PresenceState) ?? {
        user: this.user,
        login: this.auth.user,
        file: null,
        cursor: null,
        ts: 0,
      };
    this.setState({ ...cur, ...p, ts: Date.now() });
  }

  setUser(user: { name: string; color: string }): void {
    this.user = user;
    this.patch({ user });
  }
  setFile(file: string | null): void {
    this.patch({ file });
  }
  setCursor(cursor: PresenceState["cursor"]): void {
    this.patch({ cursor });
  }
  touch(): void {
    this.patch({});
  }

  get clientId(): number {
    return this.doc.clientID;
  }

  getRemotes(): RemoteEntry[] {
    return this.collect(true);
  }
  getAll(): RemoteEntry[] {
    return this.collect(false);
  }

  private collect(excludeSelf: boolean): RemoteEntry[] {
    if (!this.awareness) return [];
    const selfId = this.awareness.clientID;
    const out: RemoteEntry[] = [];
    this.awareness.getStates().forEach((state, clientId) => {
      if (excludeSelf && clientId === selfId) return;
      const s = state as unknown as PresenceState;
      if (!s || !s.user) return;
      out.push({ clientId, state: s });
    });
    return out;
  }

  isConnected(): boolean {
    return this.provider?.wsconnected ?? false;
  }

  onChange(cb: () => void): void {
    this.changeCbs.push(cb);
  }

  // Reports provider status ("connecting" | "connected" | "disconnected" | "error").
  onStatus(cb: (status: string) => void): void {
    this.statusCbs.push(cb);
  }

  destroy(): void {
    this.awareness?.setLocalState(null);
    this.provider?.destroy();
    this.provider = null;
    this.awareness = null;
    this.doc.destroy();
  }
}
