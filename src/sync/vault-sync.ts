import { type App, type EventRef, TFile, normalizePath } from "obsidian";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import {
  applyMinimalYTextUpdate,
  debounce,
  hashBytes,
  hashString,
  normalizeLineEndings,
  registerAuthor,
  sleep,
} from "../utils";
import { blobExists, downloadBlob, uploadBlob } from "./blobs";

interface Auth {
  user: string;
  pass: string;
}

// One entry per file in the shared vault index.
interface IndexEntry {
  // Kind: "t" text (Markdown, stored as a Yjs document), "b" binary (stored as a blob).
  k: "t" | "b";
  // Content hash, so peers can tell whether their local copy is current.
  h: string;
  // Last change time (ms), used only as a tie-breaker.
  t: number;
  // Tombstone: 1 means deleted.
  d?: 1;
}

const INDEX_ROOM = "vault-index";
const SYNC_TIMEOUT = 8000;
const RECONCILE_INTERVAL = 60000;

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
};

// Distributes the whole vault across devices through the self-hosted relay.
// Markdown notes travel as Yjs documents (one per note, shared with the real-time
// co-editing binding); binary files (PDFs, images, ...) travel as content-addressed
// blobs. A shared index document lists every file and its current version. A
// periodic and reconnect-triggered reconcile makes it resilient to being offline.
export class VaultSync {
  private indexDoc: Y.Doc | null = null;
  private indexProvider: WebsocketProvider | null = null;
  private files: Y.Map<IndexEntry> | null = null;
  private eventRefs: EventRef[] = [];
  private leafRef: EventRef | null = null;
  private running = false;

  // "Base" hash last successfully synchronised per path; only updated on success,
  // so a failed push/pull is retried by the next reconcile pass.
  private localHashes = new Map<string, string>();
  // Cached file mtime, to avoid re-hashing unchanged files on every reconcile.
  private mtimes = new Map<string, number>();
  private pendingWrites = new Map<string, string>();
  private pushers = new Map<string, (path: string) => void>();

  private reconcileRunning = false;
  private reconcileTimer: number | null = null;
  private interval: number | null = null;
  private onlineHandler = () => this.scheduleReconcile();

  // Persistent connection to the document of the currently open non-CodeMirror
  // text file (e.g. Excalidraw), so its changes propagate live.
  private live: { path: string; doc: Y.Doc; provider: WebsocketProvider } | null = null;

  constructor(
    private app: App,
    private serverUrl: string,
    private auth: Auth,
    private isCoEditing: (path: string) => boolean,
    private getUser: () => { name: string; color: string },
    private log: (...args: unknown[]) => void,
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    if (!this.serverUrl || !this.auth.user) return;
    this.running = true;

    this.indexDoc = new Y.Doc();
    this.indexProvider = new WebsocketProvider(this.serverUrl, INDEX_ROOM, this.indexDoc, {
      connect: true,
      params: { u: this.auth.user, p: this.auth.pass },
    });
    this.files = this.indexDoc.getMap("files");

    const synced = await this.waitForSync(this.indexProvider, SYNC_TIMEOUT);
    if (!this.running) return;
    this.log(`index synced=${synced}, entries=${this.files.size}`);

    await this.reconcilePass(); // initial bootstrap and push of local files
    if (!this.running) return;

    this.files.observe((e) => this.onIndexChange(e));
    this.eventRefs.push(
      this.app.vault.on("create", (f) => {
        if (f instanceof TFile) this.onLocalChange(f.path);
      }),
      this.app.vault.on("modify", (f) => {
        if (f instanceof TFile) this.onLocalChange(f.path);
      }),
      this.app.vault.on("delete", (f) => {
        if (f instanceof TFile) this.onLocalDelete(f.path);
      }),
      this.app.vault.on("rename", (f, oldPath) => {
        if (f instanceof TFile) void this.onLocalRename(f, oldPath);
      }),
    );
    this.leafRef = this.app.workspace.on("active-leaf-change", () => {
      this.flushPending();
      void this.syncLiveDoc();
    });
    this.indexProvider.on("status", (e: { status: string }) => {
      if (e.status === "connected") this.scheduleReconcile();
    });
    window.addEventListener("online", this.onlineHandler);
    this.interval = window.setInterval(() => this.scheduleReconcile(), RECONCILE_INTERVAL);

    void this.syncLiveDoc();
    this.log("vault sync running");
  }

  stop(): void {
    this.running = false;
    for (const ref of this.eventRefs) this.app.vault.offref(ref);
    this.eventRefs = [];
    if (this.leafRef) {
      this.app.workspace.offref(this.leafRef);
      this.leafRef = null;
    }
    window.removeEventListener("online", this.onlineHandler);
    if (this.interval !== null) {
      window.clearInterval(this.interval);
      this.interval = null;
    }
    if (this.reconcileTimer !== null) {
      window.clearTimeout(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    this.pendingWrites.clear();
    this.pushers.clear();
    this.teardownLive();
    if (this.indexProvider) {
      this.indexProvider.destroy();
      this.indexProvider = null;
    }
    if (this.indexDoc) {
      this.indexDoc.destroy();
      this.indexDoc = null;
    }
    this.files = null;
  }

  private kindOf(path: string): "t" | "b" {
    return path.toLowerCase().endsWith(".md") ? "t" : "b";
  }

  private mimeFor(path: string): string {
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    return MIME[ext] ?? "application/octet-stream";
  }

  private isOpenInEditor(path: string): boolean {
    return this.app.workspace
      .getLeavesOfType("markdown")
      .some((l) => (l.view as unknown as { file?: TFile }).file?.path === path);
  }

  private async localHash(file: TFile): Promise<string> {
    if (this.kindOf(file.path) === "t") {
      return hashString(normalizeLineEndings(await this.app.vault.read(file)));
    }
    return hashBytes(new Uint8Array(await this.app.vault.readBinary(file)));
  }

  // Full reconcile: take the union of local and remote files, push local changes,
  // pull remote changes, and never delete on this path. Debounced and guarded so
  // overlapping runs cannot pile up.
  private scheduleReconcile(): void {
    if (this.reconcileTimer !== null) window.clearTimeout(this.reconcileTimer);
    this.reconcileTimer = window.setTimeout(() => {
      this.reconcileTimer = null;
      void this.reconcilePass();
    }, 1500);
  }

  private async reconcilePass(): Promise<void> {
    if (!this.running || !this.files || this.reconcileRunning) return;
    this.reconcileRunning = true;
    try {
      const local = this.app.vault.getFiles();
      const localPaths = new Set<string>();
      for (const file of local) {
        if (!this.running) return;
        localPaths.add(file.path);
        await this.reconcileFile(file);
      }
      for (const path of [...this.files.keys()]) {
        if (!this.running) return;
        const entry = this.files.get(path);
        if (!entry || entry.d) continue;
        if (!localPaths.has(path)) await this.pull(path, entry);
      }
    } finally {
      this.reconcileRunning = false;
    }
  }

  private async reconcileFile(file: TFile): Promise<void> {
    if (!this.files) return;
    const path = file.path;
    // A live co-editing session owns this file's document; leave it alone.
    if (this.isCoEditing(path)) return;
    const base = this.localHashes.get(path);
    const entry = this.files.get(path);

    // Only re-hash when the file actually changed on disk.
    let current = base;
    if (base === undefined || this.mtimes.get(path) !== file.stat.mtime) {
      current = await this.localHash(file);
      this.mtimes.set(path, file.stat.mtime);
    }
    if (current === undefined) return;

    if (entry && !entry.d && entry.h === current) {
      this.localHashes.set(path, current); // already in sync
      return;
    }

    if (current !== base) {
      // Local content changed since our last successful sync.
      if (!entry || entry.d || file.stat.mtime >= entry.t) {
        if (await this.push(path, current)) this.localHashes.set(path, current);
      } else {
        await this.pull(path, entry); // remote is newer
      }
    } else if (entry && !entry.d && entry.h !== base) {
      await this.pull(path, entry); // remote changed while we were unchanged
    }
  }

  private onLocalChange(path: string): void {
    if (!this.running) return;
    if (this.kindOf(path) === "t" && this.isCoEditing(path)) return;
    let push = this.pushers.get(path);
    if (!push) {
      push = debounce((p: string) => void this.pushLocalFile(p), 600);
      this.pushers.set(path, push);
    }
    push(path);
  }

  private async pushLocalFile(path: string): Promise<void> {
    if (!this.running) return;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    const h = await this.localHash(file);
    if (this.localHashes.get(path) === h) return; // unchanged, or our own write
    // Straight through the open document for immediate delivery.
    if (this.live && this.live.path === path && this.kindOf(path) === "t") {
      const content = normalizeLineEndings(await this.app.vault.read(file));
      applyMinimalYTextUpdate(this.live.doc, this.live.doc.getText("content"), content);
      this.files?.set(path, { k: "t", h, t: Date.now() });
      this.localHashes.set(path, h);
      this.mtimes.set(path, file.stat.mtime);
      this.log(`live-pushed ${path} (${content.length} chars)`);
      return;
    }
    if (await this.push(path, h)) {
      this.localHashes.set(path, h);
      this.mtimes.set(path, file.stat.mtime);
    }
  }

  private async push(path: string, hash: string): Promise<boolean> {
    return this.kindOf(path) === "t" ? this.pushText(path, hash) : this.pushBlob(path, hash);
  }

  private async pushText(path: string, hash: string): Promise<boolean> {
    if (!this.files) return false;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return false;
    const content = normalizeLineEndings(await this.app.vault.read(file));
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(this.serverUrl, this.roomFor(path), doc, {
      connect: true,
      params: { u: this.auth.user, p: this.auth.pass },
    });
    try {
      const synced = await this.waitForSync(provider, SYNC_TIMEOUT);
      if (!synced || !this.running) return false;
      registerAuthor(doc, this.getUser());
      const text = doc.getText("content");
      // Seeding an empty document: only one client should insert the full text,
      // otherwise two concurrent seeds would produce duplicated content. Elect
      // the lowest client id; the others wait for the content to arrive.
      if (text.length === 0 && content.length > 0) {
        provider.awareness.setLocalStateField("seed", true);
        await sleep(500);
        if (!this.running) return false;
        const self = doc.clientID;
        const others = [...provider.awareness.getStates().keys()].filter((id) => id !== self);
        const iSeed = others.length === 0 || self <= Math.min(...others);
        if (!iSeed) {
          for (let i = 0; i < 25 && text.length === 0; i++) {
            await sleep(100);
            if (!this.running) return false;
          }
        }
      }
      applyMinimalYTextUpdate(doc, text, content);
      await sleep(600); // allow the update to reach and be persisted by the server
      this.files.set(path, { k: "t", h: hash, t: Date.now() });
      this.log(`pushed text ${path} (${content.length} chars)`);
      return true;
    } finally {
      provider.destroy();
      doc.destroy();
    }
  }

  private async pushBlob(path: string, hash: string): Promise<boolean> {
    if (!this.files) return false;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return false;
    const data = await this.app.vault.readBinary(file);
    const already = await blobExists(this.serverUrl, this.auth.user, this.auth.pass, hash);
    if (!already) {
      const ok = await uploadBlob(this.serverUrl, this.auth.user, this.auth.pass, hash, data, this.mimeFor(path));
      if (!ok) {
        this.log(`blob upload failed for ${path}`);
        return false;
      }
    }
    this.files.set(path, { k: "b", h: hash, t: Date.now() });
    this.log(`pushed blob ${path} (${data.byteLength} bytes${already ? ", deduped" : ""})`);
    return true;
  }

  private async pull(path: string, entry: IndexEntry): Promise<void> {
    if (entry.k === "b") await this.pullBinary(path, entry.h);
    else await this.pullText(path);
  }

  private async pullText(path: string): Promise<void> {
    const content = await this.readText(path);
    if (content === null) return;
    if (content.length === 0) {
      this.log(`skip empty pull for ${path}`);
      return;
    }
    if (this.isOpenInEditor(path)) {
      this.pendingWrites.set(path, content);
      this.log(`deferred write for open file ${path}`);
      return;
    }
    await this.writeText(path, content);
  }

  private async readText(path: string): Promise<string | null> {
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(this.serverUrl, this.roomFor(path), doc, {
      connect: true,
      params: { u: this.auth.user, p: this.auth.pass },
    });
    try {
      const synced = await this.waitForSync(provider, SYNC_TIMEOUT);
      if (!synced) return null;
      await sleep(150);
      return doc.getText("content").toString();
    } finally {
      provider.destroy();
      doc.destroy();
    }
  }

  private async writeText(path: string, content: string): Promise<void> {
    this.localHashes.set(path, hashString(content));
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      const current = normalizeLineEndings(await this.app.vault.read(existing));
      if (current === content) return;
      await this.app.vault.modify(existing, content);
      this.mtimes.set(path, existing.stat.mtime);
      this.log(`wrote text ${path} (${content.length} chars)`);
    } else {
      await this.ensureFolder(path);
      await this.app.vault.create(path, content);
      this.log(`created text ${path} (${content.length} chars)`);
    }
  }

  private async pullBinary(path: string, hash: string): Promise<void> {
    const data = await downloadBlob(this.serverUrl, this.auth.user, this.auth.pass, hash);
    if (!data || data.byteLength === 0) {
      this.log(`blob download failed/empty for ${path}`);
      return;
    }
    this.localHashes.set(path, hash);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.modifyBinary(existing, data);
      this.mtimes.set(path, existing.stat.mtime);
      this.log(`wrote blob ${path} (${data.byteLength} bytes)`);
    } else {
      await this.ensureFolder(path);
      await this.app.vault.createBinary(path, data);
      this.log(`created blob ${path} (${data.byteLength} bytes)`);
    }
  }

  private async ensureFolder(path: string): Promise<void> {
    const dir = normalizePath(path.split("/").slice(0, -1).join("/"));
    if (!dir || dir === "." || dir === "/") return;
    if (this.app.vault.getAbstractFileByPath(dir)) return;
    try {
      await this.app.vault.createFolder(dir);
    } catch {
      // already exists or created concurrently
    }
  }

  private flushPending(): void {
    if (this.pendingWrites.size === 0) return;
    for (const [path, content] of [...this.pendingWrites]) {
      if (this.isOpenInEditor(path)) continue;
      this.pendingWrites.delete(path);
      void this.writeText(path, content);
    }
  }

  private onIndexChange(event: Y.YMapEvent<IndexEntry>): void {
    if (!this.running || !this.files) return;
    if (event.transaction.local) return; // ignore our own updates
    for (const path of event.keysChanged) {
      const entry = this.files.get(path);
      if (!entry) continue;
      if (entry.d) {
        void this.applyRemoteDelete(path);
      } else if (this.localHashes.get(path) !== entry.h) {
        void this.pull(path, entry);
      }
    }
  }

  private async applyRemoteDelete(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    if (this.isOpenInEditor(path)) return; // do not pull the rug from under an open note
    this.localHashes.delete(path);
    this.mtimes.delete(path);
    await this.app.fileManager.trashFile(file);
    this.log(`trashed ${path} (deleted remotely)`);
  }

  private onLocalDelete(path: string): void {
    if (!this.running || !this.files) return;
    this.files.set(path, { k: this.kindOf(path), h: "", t: Date.now(), d: 1 });
    this.localHashes.delete(path);
    this.mtimes.delete(path);
    this.log(`tombstoned ${path}`);
  }

  private async onLocalRename(file: TFile, oldPath: string): Promise<void> {
    if (!this.running || !this.files) return;
    this.files.set(oldPath, { k: this.kindOf(oldPath), h: "", t: Date.now(), d: 1 });
    this.localHashes.delete(oldPath);
    this.mtimes.delete(oldPath);
    const h = await this.localHash(file);
    if (await this.push(file.path, h)) {
      this.localHashes.set(file.path, h);
      this.mtimes.set(file.path, file.stat.mtime);
    }
    this.log(`renamed ${oldPath} -> ${file.path}`);
  }

  // Path of the active file when it is a text file shown in a non-CodeMirror view
  // (Excalidraw and similar), which cannot use the co-editing binding.
  private activeLiveTextPath(): string | null {
    const view = this.app.workspace.activeLeaf?.view as unknown as {
      getViewType?: () => string;
      file?: TFile;
    };
    const path = view?.file?.path;
    const type = view?.getViewType?.();
    if (path && type && type !== "markdown" && this.kindOf(path) === "t") return path;
    return null;
  }

  private teardownLive(): void {
    if (!this.live) return;
    this.live.provider.destroy();
    this.live.doc.destroy();
    this.live = null;
  }

  private async syncLiveDoc(): Promise<void> {
    if (!this.running) return;
    const path = this.activeLiveTextPath();
    if (this.live?.path === path) return;
    this.teardownLive();
    if (!path) return;

    const doc = new Y.Doc();
    const provider = new WebsocketProvider(this.serverUrl, this.roomFor(path), doc, {
      connect: true,
      params: { u: this.auth.user, p: this.auth.pass },
    });
    this.live = { path, doc, provider };

    const synced = await this.waitForSync(provider, SYNC_TIMEOUT);
    if (!this.running || this.live?.path !== path) {
      provider.destroy();
      doc.destroy();
      return;
    }
    const text = doc.getText("content");
    registerAuthor(doc, this.getUser());

    const remote = text.toString();
    if (remote.length > 0 && this.localHashes.get(path) !== hashString(remote)) {
      void this.writeText(path, remote);
    }

    text.observe((e) => {
      if (e.transaction.local) return;
      const content = text.toString();
      if (content.length === 0) return;
      if (this.localHashes.get(path) === hashString(content)) return;
      void this.writeText(path, content);
    });
    this.log(`live doc connected for ${path}`);
  }

  private roomFor(path: string): string {
    return `doc:${encodeURIComponent(path)}`;
  }

  private waitForSync(provider: WebsocketProvider, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (provider.synced) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => resolve(false), ms);
      provider.once("sync", (isSynced: boolean) => {
        clearTimeout(timer);
        resolve(isSynced);
      });
    });
  }
}
