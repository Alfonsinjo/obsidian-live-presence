import { type App, type EventRef, Notice, TFile, normalizePath } from "obsidian";
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
import { type ChangeEntry, listChangelog, reconstructBase } from "../changelog";
import { logProblem } from "../logger";
import { type MergeResult, mergeThreeWay } from "../merge";
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

// On-demand loading: notes that exist on the server but not yet on this device
// are created as small placeholder ("stub") files so the vault tree is complete,
// and their real content is fetched only when the note is opened. The marker
// identifies a stub on disk; it must NEVER be pushed to the server.
const STUB_MARKER = "<!-- live-presence-stub -->";
function stubContent(path: string): string {
  const name = path.replace(/\.md$/i, "").split("/").pop() ?? path;
  return (
    `# ${name}\n\n` +
    "> [!info] Noch nicht geladen\n" +
    "> Diese Notiz liegt noch nicht auf diesem Gerät. Sie wird beim Öffnen automatisch vom Server geladen.\n\n" +
    `${STUB_MARKER}\n`
  );
}

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
  // so a failed push/pull is retried by the next reconcile pass. Persisted so
  // three-way merges survive an Obsidian restart.
  private localHashes = new Map<string, string>();
  // Last-synced text per path (in-memory), used as the merge base when available.
  private baseText = new Map<string, string>();
  // Cached file mtime, to avoid re-hashing unchanged files on every reconcile.
  private mtimes = new Map<string, number>();
  private pendingWrites = new Map<string, string>();
  private pushers = new Map<string, (path: string) => void>();
  private conflictsInProgress = new Set<string>();
  // Placeholder notes not yet downloaded. Never pushed; skipped by reconcile.
  private stubs = new Set<string>();
  private materializing = new Set<string>();

  private reconcileRunning = false;
  private reconcileTimer: number | null = null;
  private interval: number | null = null;
  private onlineHandler = () => this.scheduleReconcile();
  private saveBase = debounce(() => {
    const record: Record<string, string> = {};
    for (const [p, h] of this.localHashes) record[p] = h;
    this.saveBaseHashes(record);
  }, 2000);

  // Persistent connection to the document of the currently open non-CodeMirror
  // text file (e.g. Excalidraw), so its changes propagate live.
  private live: { path: string; doc: Y.Doc; provider: WebsocketProvider } | null = null;

  constructor(
    private app: App,
    private serverUrl: string,
    private auth: Auth,
    private isCoEditing: (path: string) => boolean,
    private getUser: () => { name: string; color: string },
    private loadBaseHashes: () => Promise<Record<string, string>>,
    private saveBaseHashes: (record: Record<string, string>) => void,
    private onConflict: (path: string, result: MergeResult) => Promise<"mine" | "theirs">,
    private log: (...args: unknown[]) => void,
    // Notified after a stub note has been downloaded, so co-editing can engage.
    private onMaterialized: (path: string) => void = () => {},
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    if (!this.serverUrl || !this.auth.user) return;
    this.running = true;

    // Restore the last-synced hashes so conflicts can be detected after a restart.
    try {
      const stored = await this.loadBaseHashes();
      for (const [p, h] of Object.entries(stored)) this.localHashes.set(p, h);
    } catch {
      // no stored base yet
    }

    this.indexDoc = new Y.Doc();
    this.indexProvider = new WebsocketProvider(this.serverUrl, INDEX_ROOM, this.indexDoc, {
      connect: true,
      params: { u: this.auth.user, p: this.auth.pass },
    });
    this.files = this.indexDoc.getMap("files");

    const synced = await this.waitForSync(this.indexProvider, SYNC_TIMEOUT);
    if (!this.running) return;
    this.log(`index synced=${synced}, entries=${this.files.size}`);

    await this.rebuildStubs(); // recognise placeholder notes left from a prior session
    await this.reconcilePass(); // initial bootstrap (stubs for remote-only notes)
    if (!this.running) return;
    void this.materializeActive(); // download whatever note is already open

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
      void this.materializeActive();
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

  // Last-synced content hash for a path, used by the co-editing binding as the
  // common ancestor when it takes over an open note that diverged from the
  // shared copy (so it can merge instead of overwrite).
  getBaseHash(path: string): string | undefined {
    return this.localHashes.get(path);
  }

  // Whether a path is currently a placeholder that has not been downloaded yet.
  isStub(path: string): boolean {
    return this.stubs.has(path);
  }

  // Rebuild the placeholder set from disk after a restart. Only small text files
  // can be stubs, so larger files are skipped without being read.
  private async rebuildStubs(): Promise<void> {
    this.stubs.clear();
    for (const file of this.app.vault.getFiles()) {
      if (!this.running) return;
      if (this.kindOf(file.path) !== "t" || file.stat.size > 1024) continue;
      try {
        if ((await this.app.vault.read(file)).includes(STUB_MARKER)) this.stubs.add(file.path);
      } catch {
        // unreadable; ignore
      }
    }
  }

  // Create a placeholder for a note that only exists on the server. It is added
  // to the stub set BEFORE the file is written so the resulting create event is
  // not pushed back to the server.
  private async createStub(path: string): Promise<void> {
    if (this.stubs.has(path) || this.app.vault.getAbstractFileByPath(path)) return;
    this.stubs.add(path);
    try {
      await this.ensureFolder(path);
      await this.app.vault.create(path, stubContent(path));
      const f = this.app.vault.getAbstractFileByPath(path);
      if (f instanceof TFile) this.mtimes.set(path, f.stat.mtime);
      this.log(`stub ${path}`);
    } catch {
      this.stubs.delete(path);
    }
  }

  // Download the active note's real content if it is still a placeholder.
  private async materializeActive(): Promise<void> {
    const path = this.app.workspace.getActiveFile()?.path;
    if (path && this.stubs.has(path)) await this.materialize(path);
  }

  // Fetch a placeholder note's real content (and the attachments it embeds) from
  // the server and replace the placeholder. A connection is required.
  private async materialize(path: string): Promise<void> {
    if (!this.running || !this.stubs.has(path) || this.materializing.has(path)) return;
    this.materializing.add(path);
    const name = path.replace(/\.md$/i, "").split("/").pop() ?? path;
    const notice = new Notice(`Lade „${name}" …`, 0);
    try {
      const content = await this.readText(path);
      // Keep the placeholder if we got nothing back: dropping it here without
      // writing real content would let the placeholder be pushed to the server.
      if (content === null || content.length === 0) {
        logProblem("warn", "Notiz laden fehlgeschlagen (leer/offline)", { path });
        notice.setMessage(`„${name}" konnte nicht geladen werden. Besteht eine Verbindung?`);
        window.setTimeout(() => notice.hide(), 5000);
        return;
      }
      this.stubs.delete(path); // real content is about to replace the placeholder
      await this.writeText(path, content);
      await this.materializeAttachments(content);
      notice.hide();
      this.log(`materialised ${path} (${content.length} chars)`);
      this.onMaterialized(path);
    } catch (err) {
      this.stubs.add(path);
      logProblem("error", "Notiz laden fehlgeschlagen", { path, err: String(err) });
      notice.setMessage(`„${name}" konnte nicht geladen werden.`);
      window.setTimeout(() => notice.hide(), 5000);
      this.log(`materialise failed for ${path}:`, err);
    } finally {
      this.materializing.delete(path);
    }
  }

  // Download the binary attachments a note embeds/links, so images and PDFs
  // appear as soon as the note is opened.
  private async materializeAttachments(content: string): Promise<void> {
    if (!this.files) return;
    const refs = new Set<string>();
    for (const m of content.matchAll(/!\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) refs.add(m[1].trim());
    for (const m of content.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
      refs.add(decodeURIComponent(m[1].split(/[#?]/)[0].trim()));
    }
    if (refs.size === 0) return;
    const wantBase = new Set<string>();
    const wantPath = new Set<string>();
    for (const r of refs) {
      wantPath.add(r.toLowerCase());
      wantBase.add((r.split("/").pop() ?? r).toLowerCase());
    }
    for (const [p, entry] of this.files.entries()) {
      if (!this.running) return;
      if (!entry || entry.d || this.kindOf(p) !== "b") continue;
      if (this.app.vault.getAbstractFileByPath(p)) continue; // already local
      const base = (p.split("/").pop() ?? p).toLowerCase();
      if (wantBase.has(base) || wantPath.has(p.toLowerCase())) await this.pullBinary(p, entry.h);
    }
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
        if (localPaths.has(path)) continue;
        // On-demand: notes get a placeholder and are downloaded when opened.
        // Binaries have no placeholder; they are fetched with the note that
        // embeds them.
        if (this.kindOf(path) === "t") await this.createStub(path);
      }
      this.saveBase();
    } finally {
      this.reconcileRunning = false;
    }
  }

  private async reconcileFile(file: TFile): Promise<void> {
    if (!this.files) return;
    const path = file.path;
    // A placeholder note is not real content: never push or merge it.
    if (this.stubs.has(path)) return;
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
      if (this.kindOf(path) === "t" && !this.baseText.has(path)) {
        this.baseText.set(path, normalizeLineEndings(await this.app.vault.read(file)));
      }
      return;
    }

    // Our copy changed since the last sync -> push it. For text, pushText
    // detects when the shared copy also diverged and performs a three-way
    // merge (never a blind overwrite), so neither side's text is lost. Only
    // the shared copy changed -> pull (safe, our copy is untouched).
    // Binary files have no line merge, so they keep last-writer-wins by mtime.
    if (current !== base) {
      const remoteChanged = !!entry && !entry.d && entry.h !== base && entry.h !== current;
      if (this.kindOf(path) === "b" && remoteChanged && entry && file.stat.mtime < entry.t) {
        await this.pull(path, entry); // remote binary is newer
      } else {
        await this.push(path, current); // push (text push merges on conflict)
      }
    } else if (entry && !entry.d && entry.h !== base) {
      await this.pull(path, entry);
    }
  }

  // Three-way merge for a note that diverged on both sides. Clean merges apply
  // automatically; overlapping conflicts are resolved by the user. Nothing is
  // ever discarded silently: the worst case keeps both versions with markers.
  private async mergeAndResolve(
    path: string,
    baseHash: string | undefined,
    local: string,
    remote: string,
  ): Promise<void> {
    if (this.conflictsInProgress.has(path)) return;
    this.conflictsInProgress.add(path);
    try {
      // Recover the common ancestor. Only trust the cached base text if it
      // still matches the recorded base hash; otherwise reconstruct it from the
      // change log so a stale cache can never turn a merge into an overwrite.
      let base = "";
      const cached = this.baseText.get(path);
      if (cached !== undefined && (baseHash === undefined || hashString(cached) === baseHash)) {
        base = cached;
      } else if (baseHash !== undefined) {
        const entries: ChangeEntry[] = await listChangelog(this.serverUrl, this.auth, path);
        base = reconstructBase(entries, baseHash) ?? "";
      }

      // Probe pass: find the overlapping regions without writing markers.
      const probe = mergeThreeWay(base, local, remote, "detect");
      if (probe.conflicts.length === 0) {
        // No overlap: combine both sides automatically.
        this.log(`auto-merged ${path}`);
        await this.applyMerged(path, probe.text);
        return;
      }
      // Overlap: let the user pick a winning side, then write it cleanly.
      const action = await this.onConflict(path, probe);
      const resolved = mergeThreeWay(base, local, remote, action === "theirs" ? "theirs" : "mine");
      this.log(`resolved conflict in ${path} -> ${action}`);
      await this.applyMerged(path, resolved.text);
    } finally {
      this.conflictsInProgress.delete(path);
    }
  }

  private async applyMerged(path: string, text: string): Promise<void> {
    await this.writeText(path, text); // materialise the merged result on disk
    // Raw push: the merged text already contains the remote changes, so it must
    // not be re-diffed against the shared copy (that would loop).
    await this.pushTextRaw(path, hashString(text), text);
  }

  private onLocalChange(path: string): void {
    if (!this.running) return;
    if (this.stubs.has(path)) return; // a placeholder must never be pushed
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
      this.baseText.set(path, content);
      this.mtimes.set(path, file.stat.mtime);
      this.saveBase();
      this.log(`live-pushed ${path} (${content.length} chars)`);
      return;
    }
    // push() owns localHashes/baseText now: a plain push sets them to h, a
    // conflict merge sets them to the merged hash instead. Do not overwrite.
    if (await this.push(path, h)) {
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
    const baseHash = this.localHashes.get(path);
    let conflictRemote: string | null = null;
    try {
      const synced = await this.waitForSync(provider, SYNC_TIMEOUT);
      if (!synced || !this.running) return false;
      const text = doc.getText("content");
      const remote = text.toString();
      // Conflict guard: if the shared copy diverged from the ancestor we last
      // synced while our copy also changed, we must NOT overwrite it. Compare
      // against the recorded base hash (survives restarts), not a live cache,
      // so this holds even if the file index has not caught up yet. When we
      // have no base at all, any differing non-empty shared copy is treated as
      // a conflict too, so a blind overwrite is impossible.
      const remoteDiffersFromBase =
        baseHash === undefined ? hashString(remote) !== hash : hashString(remote) !== baseHash;
      const localDiffersFromBase = baseHash === undefined || hash !== baseHash;
      if (remote.length > 0 && remoteDiffersFromBase && localDiffersFromBase) {
        conflictRemote = remote; // resolved after the connection is closed
      } else {
        registerAuthor(doc, this.getUser());
        this.seedIfEmpty(doc, provider, content);
        if (!this.running) return false;
        applyMinimalYTextUpdate(doc, text, content);
        await sleep(600); // allow the update to reach and be persisted by the server
        this.files.set(path, { k: "t", h: hash, t: Date.now() });
        this.localHashes.set(path, hash);
        this.baseText.set(path, content);
        this.saveBase();
        this.log(`pushed text ${path} (${content.length} chars)`);
      }
    } finally {
      provider.destroy();
      doc.destroy();
    }
    if (conflictRemote !== null) {
      await this.mergeAndResolve(path, baseHash, content, conflictRemote);
    }
    return true;
  }

  // Push exactly this content to the shared copy with no conflict check. Used
  // after a merge, where the content already contains the remote changes and
  // re-diffing it against the shared copy would loop.
  private async pushTextRaw(path: string, hash: string, content: string): Promise<boolean> {
    if (!this.files) return false;
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
      this.seedIfEmpty(doc, provider, content);
      if (!this.running) return false;
      applyMinimalYTextUpdate(doc, text, content);
      await sleep(600);
      this.files.set(path, { k: "t", h: hash, t: Date.now() });
      this.localHashes.set(path, hash);
      this.baseText.set(path, content);
      this.saveBase();
      this.log(`pushed text ${path} (${content.length} chars, merged)`);
      return true;
    } finally {
      provider.destroy();
      doc.destroy();
    }
  }

  // Seeding an empty document: only one client should insert the full text,
  // otherwise two concurrent seeds would duplicate content. Elect the lowest
  // client id; the others wait briefly for the content to arrive.
  private async seedIfEmpty(doc: Y.Doc, provider: WebsocketProvider, content: string): Promise<void> {
    const text = doc.getText("content");
    if (text.length !== 0 || content.length === 0) return;
    provider.awareness.setLocalStateField("seed", true);
    await sleep(500);
    if (!this.running) return;
    const self = doc.clientID;
    const others = [...provider.awareness.getStates().keys()].filter((id) => id !== self);
    const iSeed = others.length === 0 || self <= Math.min(...others);
    if (!iSeed) {
      for (let i = 0; i < 25 && text.length === 0; i++) {
        await sleep(100);
        if (!this.running) return;
      }
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
    this.localHashes.set(path, hash);
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
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      const current = normalizeLineEndings(await this.app.vault.read(existing));
      if (current === content) return;
      // Safety net: never blank a non-empty note through synchronisation.
      if (content.length === 0 && current.length > 0) {
        this.log(`refused to blank ${path} via sync`);
        return;
      }
      this.localHashes.set(path, hashString(content));
      this.baseText.set(path, content);
      this.saveBase();
      await this.app.vault.modify(existing, content);
      this.mtimes.set(path, existing.stat.mtime);
      this.log(`wrote text ${path} (${content.length} chars)`);
    } else {
      if (content.length === 0) return; // do not create empty notes through sync
      this.localHashes.set(path, hashString(content));
      this.baseText.set(path, content);
      this.saveBase();
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
        continue;
      }
      if (this.stubs.has(path)) continue; // still a placeholder; do not download
      const local = this.app.vault.getAbstractFileByPath(path);
      if (!(local instanceof TFile)) {
        // New note on the server -> placeholder (downloaded when opened).
        // Binaries are fetched with the note that embeds them.
        if (this.kindOf(path) === "t") void this.createStub(path);
        continue;
      }
      if (this.localHashes.get(path) !== entry.h) void this.pull(path, entry);
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
    // Deleting a placeholder only removes the local copy; the note stays on the
    // server (it was never really here). Do not tombstone it.
    if (this.stubs.has(path)) {
      this.stubs.delete(path);
      this.localHashes.delete(path);
      this.mtimes.delete(path);
      this.log(`removed stub ${path}`);
      return;
    }
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
      // push() owns localHashes (plain push -> h, merge -> merged hash).
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
