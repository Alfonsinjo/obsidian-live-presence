# Live Presence

Live Presence shows who else is currently in your Obsidian vault, which note each person is working on, and the live cursors of others, in real time. It is fully self-hosted and connects to a server that you operate yourself, so no data leaves your network.

Version: 0.1.0 (Phase 1)

Requires: Obsidian 1.5.0 or newer, desktop only.

License: MIT

Note: The plugin user interface is currently in German. Setup and configuration are documented here in English.

## Purpose

Obsidian is local-first and designed for a single user. Teams that share a vault through a file synchronisation tool such as Self-hosted LiveSync, Syncthing, or Git can edit the same notes, but they work without awareness of one another. It is not visible that a colleague has opened the same note, changes appear only after the synchronisation delay, and there is no overview of who is currently active.

Commercial and cloud-based tools such as Relay or Peerdraft provide this awareness, but they route data through external servers and usually require a subscription.

Live Presence adds the missing awareness layer, consisting of a live roster and live cursors, while remaining fully self-hosted and free of charge. It runs alongside whatever file synchronisation you already use. In Phase 1 it exchanges only presence and cursor information and never writes to your files, so it cannot interfere with your synchronisation.

## Features

Phase 1 (this release):

* Automatic connection when the vault is opened. No session needs to be started manually.
* A presence roster, consisting of a status bar indicator and a sidebar panel that lists everyone currently online, grouped by the note they are in. Selecting a note opens it.
* Live cursors and selections of other people inside the note that is currently open, each shown in a distinct colour with a name label.
* Awareness only. The plugin exchanges presence and cursor information exclusively and never transfers file contents, so it coexists with any file synchronisation plugin.

Co-editing (experimental):

* The command "Co-editing for the current file on/off" binds the open note to a shared Yjs document, so text is edited character by character in real time with correct remote cursors. It is manual for now: engage it on the same note on each side.
* While a note is co-edited, pause your file-sync plugin for it. Automatic engagement when two or more people open the same file, and automatic coordination with the file-sync plugin, are planned.

## How it works

Each client connects to a shared Yjs relay (y-websocket) and publishes its awareness state, which consists of name, colour, active file, and cursor position. Every other client receives this state and renders the roster and the remote cursors. The relay only forwards messages. It stores nothing between sessions, and in Phase 1 it never carries document text. Because you host the relay yourself, all data remains within your own infrastructure.

## Requirements

Live Presence requires a self-hosted Yjs relay, the standard @y/websocket-server. A minimal Docker configuration is:

```yaml
services:
  presence:
    image: node:22-alpine
    command: npx -y @y/websocket-server
    environment:
      - HOST=0.0.0.0
      - PORT=1234
    ports:
      - "127.0.0.1:1234:1234"
    restart: unless-stopped
```

Publish the relay over TLS so that the plugin can connect via wss. An example using Caddy:

```
your.host.example {
    handle_path /presence/* {
        reverse_proxy 127.0.0.1:1234
    }
}
```

The resulting server URL for the plugin is `wss://your.host.example/presence`.

Keep the relay reachable only from a trusted network, for example a LAN, VPN, or campus network protected by a firewall. The relay itself has no authentication; the network boundary provides access control.

## Installation

Live Presence is not available in the community plugin store. It can be installed with BRAT (recommended) or manually.

Using BRAT:

1. Install and enable "Obsidian42 - BRAT" from the community plugin store.
2. Run the command "BRAT: Add a beta plugin for testing".
3. Enter the repository `Alfonsinjo/obsidian-live-presence`.
4. Enable Live Presence under Settings, Community plugins.

Manually:

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release.
2. Copy them into `<your-vault>/.obsidian/plugins/live-presence/`.
3. Reload Obsidian and enable Live Presence.

## Configuration

Under Settings, Live Presence:

* Display name: full name, shown in the roster and next to your cursor.
* Colour: an optional fixed colour (hsl or hex). If left empty, a colour is derived from the name.
* Server URL: the address of your relay, for example `wss://your.host.example/presence`, without a trailing slash.
* Login user / Login password: optional credentials. If your relay requires authentication, enter them here; they are sent to the relay when connecting.

The plugin does not connect until a server URL has been entered.

## Authentication (optional)

The plain relay accepts any connection reachable on the network. If you want only known accounts to connect, run a relay that validates the credentials the plugin sends (query parameters `u` and `p`) before accepting the WebSocket upgrade. A common approach is to validate them against an existing account store; for example, against a CouchDB instance using `POST /_session`, which pairs naturally with the Self-hosted LiveSync backend so one account works for both. Users then enter that account under Login user / Login password.

## Building from source

Docker is required. Node.js does not need to be installed on the host.

```bash
bash build.sh
```

This produces `main.js`. For a release, attach `main.js`, `manifest.json`, and `styles.css` as assets.

## Compatibility

* Obsidian 1.5.0 or newer, desktop only. The plugin uses the CodeMirror 6 editor API and is therefore not available on mobile.
* Runs alongside file synchronisation plugins such as Self-hosted LiveSync, Syncthing, or Git. In Phase 1 it never writes files.

## License

MIT. See the LICENSE file.
