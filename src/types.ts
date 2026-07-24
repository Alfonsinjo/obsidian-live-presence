export interface LivePresenceSettings {
  // Base URL of the relay, e.g. wss://host/presence (no trailing slash).
  serverUrl: string;
  // Full name shown in the roster and next to the cursor.
  userName: string;
  // Fixed colour (hex/hsl); empty means derive it from the name.
  color: string;
  // CouchDB login (same account as LiveSync). Required to connect.
  authUser: string;
  authPass: string;
  // Real-time co-editing (shared text). Off by default; presence and cursors work without it.
  enableCoedit: boolean;
}

export const DEFAULT_SETTINGS: LivePresenceSettings = {
  serverUrl: "",
  userName: "",
  color: "",
  authUser: "",
  authPass: "",
  enableCoedit: false,
};

// Cursor/selection as absolute character offsets.
export interface CursorState {
  anchor: number;
  head: number;
  docLen: number;
}

export interface AwarenessUser {
  name: string;
  color: string;
}

// What each client publishes via Yjs awareness.
export interface PresenceState {
  user: AwarenessUser;
  file: string | null;
  cursor: CursorState | null;
  ts: number;
}

export interface RemoteEntry {
  clientId: number;
  state: PresenceState;
}
