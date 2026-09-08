# Live Presence

Live Presence turns an Obsidian vault into a shared vault. Everyone connects to one WebSocket
server that you run yourself. The plugin distributes the notes, shows who is currently online and
which note each person is in, draws the other people's cursors, and lets two or more people type in
the same note at the same time.

It does not need a second sync plugin. Self-hosted LiveSync, Syncthing or a Git remote are not
involved any more: the vault travels over the same `wss://` connection that carries presence and
cursors.

Requires Obsidian 1.5.0 or newer, desktop only. Licence: MIT.

The plugin interface is German. This file documents setup and operation in English.

## What it does

* **Vault synchronisation.** All notes and attachments are distributed through the server. A note
  is downloaded when you open it; until then it exists locally as a placeholder and the file
  explorer shows a cloud symbol next to it, the way OneDrive marks online-only files.
* **Who is online.** A status bar item with the number of connected people, and a sidebar panel
  listing everyone grouped by the note they are in. Clicking a note opens it.
* **Live cursors.** Cursors and selections of the other people inside the note you have open, each
  in its own colour with a name label.
* **Real-time co-editing.** As soon as two people have the same note open, editing goes character
  by character through a shared CRDT (Yjs). It starts and stops on its own as people join and
  leave the note. Excalidraw drawings work the same way if the Excalidraw plugin is installed.
* **Author highlighting.** Colours each passage of the current note by who wrote it; hovering shows
  the name and the time.
* **A connection is required to write.** While the server is unreachable, note editing is blocked
  and a banner says so. This is deliberate: without it, offline edits would have to be merged
  later, which is where text gets lost.
* **One version for everyone.** The server publishes the minimum client version. An older client
  locks itself, offers a one-click update that it fetches from the server, and reloads Obsidian.
* **Problem reports.** A button in the sidebar sends a short description to the server log.

### Excalidraw drawings

A drawing is not shared as text. The body of an `.excalidraw.md` file is a single machine-generated
data block, usually LZ-compressed, so merging it line by line would wreck the drawing, and
replacing the whole file on every change would mean the last save wins and everyone else's strokes
are gone.

Instead the drawing's scene is shared element by element in a room of its own (`excal:<path>`,
separate from the note's text room). Excalidraw elements carry version metadata, so every element
is resolved on its own: higher version wins, ties are broken deterministically. That is the rule
Excalidraw uses for its own collaboration. Two people drawing different shapes never collide, two
people moving the same shape end up on one of the two movements instead of an average, and a
deletion travels as a tombstone so a peer that still has the shape cannot resurrect it.

Shapes are published about twenty times a second while they are being drawn, so a stroke grows on
the other screen instead of appearing when the pointer is released; a shape abandoned mid-gesture
is retracted again. An element that the local user is dragging, resizing or typing into is never
overwritten from the network. Incoming changes do not touch the local selection, viewport or undo
history.

Known limits: drawings get no author highlighting (that is built on shared text); with several
drawings open side by side, only the one in front is co-edited; and an element deleted while
disconnected can come back once when the connection returns.

## Server

The plugin needs two things behind one hostname:

* the **presence relay**, a small Node service based on `y-websocket` that keeps every room on disk
  (`y-leveldb`), validates each incoming connection against CouchDB, and writes an append-only
  change log for the author highlighting;
* a **CouchDB** instance, which holds the accounts (`_users`), the display names (`ksk_profiles`),
  the change log (`ksk_changelog`), binary attachments as content-addressed documents
  (`ksk_blobs`), the required client version (`ksk_config/client`) and the plugin files the
  self-update serves (`ksk_plugin/current`).

The relay source is in `presence-server/` of the deployment repository. A `docker compose` service
for it looks like this:

```yaml
services:
  presence:
    build: ./presence-server
    restart: unless-stopped
    environment:
      - COUCHDB_URL=http://couchdb:5984
      - YJS_DATA_DIR=/data/yjs
      - COUCHDB_USER=${COUCHDB_USER}
      - COUCHDB_PASSWORD=${COUCHDB_PASSWORD}
    volumes:
      - ./presence-server/data:/data/yjs
    ports:
      - "127.0.0.1:1234:1234"
```

Put both behind TLS so the plugin can use `wss://`. With Caddy, the relay goes under `/presence/`
and everything else to CouchDB:

```
your.host.example {
    tls /etc/caddy/certs/fullchain.pem /etc/caddy/certs/server.key

    handle_path /presence/* {
        reverse_proxy 127.0.0.1:1234
    }
    handle {
        reverse_proxy 127.0.0.1:5984
    }
}
```

The server URL for the plugin is then `wss://your.host.example/presence`.

Every WebSocket connection is rejected unless the account it sends is valid, so the relay is not
open to whoever reaches it. Keeping it inside a trusted network anyway (LAN, VPN, campus network
behind a firewall) is still the sensible thing to do.

Besides the WebSocket, the relay answers `GET /version` (minimum and latest client version),
`GET /plugin/<file>` (the plugin files for the self-update), `GET /checkuser?name=…` (whether an
account exists, so the login test can tell a wrong user from a wrong password), `POST /log`
(problem reports) and `GET /healthz`.

## Installation

Live Presence is not in the community plugin store. Install it with BRAT or by hand; after that it
updates itself from the server.

With BRAT:

1. Install and enable "Obsidian42 - BRAT" from the community plugin store.
2. Run the command "BRAT: Add a beta plugin for testing".
3. Enter the repository `Alfonsinjo/obsidian-live-presence`.
4. Enable Live Presence under Settings, Community plugins.

By hand:

1. Download `main.js`, `manifest.json` and `styles.css` from the latest release.
2. Copy them into `<your-vault>/.obsidian/plugins/live-presence/`.
3. Reload Obsidian and enable Live Presence.

## Configuration

Under Settings, Live Presence:

* **Server URL**: `wss://your.host.example/presence`, without a trailing slash.
* **Login user** and **Login password**: the CouchDB account. The plugin sends them as query
  parameters when it opens the connection, and uses them for the CouchDB databases listed above.
* **Display name**: asked once on the first connection and stored on the server with the account,
  so it follows you to another machine. The colour is derived from the name.
* **Real-time co-editing**: on by default. Turning it off leaves presence and cursors working.

Then press "Anmelden / Verbindung testen". It checks URL, account and password separately and says
which of them is wrong. On success it asks once more before the vault is reconciled with the
server, because that step downloads content and can overwrite local files.

## Building from source

Docker is required, Node.js on the host is not.

```bash
bash build.sh
```

This type-checks the sources and writes `main.js`. A release consists of `main.js`,
`manifest.json` and `styles.css`.

## Notes on compatibility

* Desktop only. The plugin uses the CodeMirror 6 editor API, which Obsidian mobile does not expose.
* Do not run a second sync plugin on the same vault. Two systems writing the same files will
  produce conflicts that neither of them can resolve.

## Licence

MIT, see the LICENSE file.
