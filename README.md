# Drift

A quiet, compact web client for Transmission. Built for desktop, comfortable on a phone. Static assets only: no Node process, database, CDN, analytics, or additional backend.

## Features

- Compact, searchable transfer list with filters, sorting, keyboard navigation, range selection, batch actions, and desktop context menus. Touch devices always expose an action menu.
- Explicit stages: peer discovery, metadata retrieval, verification, queueing, missing pieces, downloading, and seeding. Unknown metadata is never shown as a zero-byte download.
- Scrubbable download/upload graph using measured samples only. Samples begin when the page opens; background tabs poll less frequently.
- Inspector with a selectable file tree, folder-wide download selection, file priority and renaming, tracker editing, peer graph and table, statistics, labels, and transfer options.
- Magnets, torrent URLs, multi-file upload, drag and drop, file relocation, verification, reannouncing, queue ordering, and magnet/hash copying.
- Server bandwidth, slow mode, directories, queue, seeding, encryption, discovery, peer, port-mapping, and blocklist settings.
- Optional **Full speed** extension, detected at runtime. Unsupported controls stay hidden on standard daemons.
- Light/dark/system themes, reduced motion, keyboard focus, native modal focus containment, and bundled fonts.

## Development

Install [Bun](https://bun.sh), then:

```sh
bun install --frozen-lockfile
bun run dev
```

Svelte 5 runes, Tailwind CSS 4, Lucide, and Inter Variable. Vite compiles Svelte; Bun manages packages and runs scripts. Biome checks TypeScript/CSS, svelte-check checks Svelte, types, and accessibility, and Prettier formats the project.

```sh
bun run check
bun run lint
bun run format
bun run test
bunx playwright install chromium
bun run test:e2e
bun run build
bun run validate
```

Browser tests use isolated RPC fixtures. To develop against a real daemon:

```sh
DRIFT_RPC_PROXY=http://router.local:9091 bun run dev
```

In Connection settings use `http://localhost:5173/transmission/rpc` for this proxy. The endpoint is remembered locally. Credentials stay in memory and must be entered again after reload. Use HTTPS for authenticated remote connections. Cross-origin servers must allow CORS and expose the X-Transmission-Session-Id header, or use a same-origin proxy.

## Install

Build locally and copy **only dist/** to the daemon host. Set Transmission's TRANSMISSION_WEB_HOME environment variable to that directory. On OpenWrt:

```sh
uci set transmission.@transmission[0].web_home='/path/to/drift-dist'
uci commit transmission
/etc/init.d/transmission restart
```

Open the existing `/transmission/web/` URL. Assets use relative paths. Preserve the old web-home setting for rollback. No Bun or UI source is needed on the router. Sandboxed daemons need read access to the bundle directory.

A bundle-only upload helper is included; it does not change daemon configuration:

```sh
bun run build
bun scripts/deploy.ts root@router.local /path/to/drift-dist
```

Transmission 4.x is the primary target, tested live with 4.1.3. The client uses its legacy-compatible RPC API with 409 session negotiation. Older daemons may lack labels or tracker-list support; there is a legacy tracker-editing path. A future daemon that removes legacy RPC will need an adapter. Creating new torrent metainfo from local files is outside this remote client's scope.

## Optional Full speed protocol

Drift does not mistake ordinary torrent bandwidth priority for a controller override. Advertise the extension at full-speed.json in the daemon's web directory:

```json
{
  "version": 1,
  "fullSpeed": {
    "enabled": true,
    "label": "router:full-speed",
    "heartbeat": 1790000000,
    "active": ["a-40-character-torrent-info-hash"]
  }
}
```

Heartbeat is current Unix time in seconds, updated by the controller. Drift ignores a heartbeat older than 12 seconds. Active contains the hashes whose overrides are actually applied; a label alone shows a pending request. Missing manifests are rechecked every 30 seconds.

Enabling the feature adds the advertised label via standard RPC and clears it from other torrents. Disabling removes it. The controller owns snapshots, applying overrides, acknowledgements, and restoration after toggle-off, pause, completion, errors, removal, and restart. The browser needs no privileged shell endpoint.

The optional reference integration in integrations/openwrt/ is **not part of the frontend bundle or an automatic installer**. It expects an SSD mounted at /home, an existing OpenWrt Transmission/backoff service, ucode, curl, procps-ng-snice, and an existing named nftables traffic counter. It saves original settings before changes and restores them afterwards. It publishes the capability heartbeat atomically on the SSD. It bypasses session speed caps, raises peer limits, starts outside the queue, and gives the daemon's main thread normal CPU priority. OS address-space limits and filesystem/network access controls remain intact. Full speed may affect other traffic.

The helper derives the bind address from UCI; DRIFT_RPC_URL can override the endpoint/port. This reference assumes locally permitted unauthenticated RPC. Authenticated deployments need their own credential handling. General setups should implement the capability protocol using their existing controller rather than blindly installing these scripts.

## Design and license

Flat surfaces, a restrained hierarchy, contextual controls, and explicit state. Keyed FLIP movement, interpolated inspector layout, short overlay motion, and functional scroll fades. No decorative gradients or private design-library dependencies.

MIT. Inter: SIL Open Font License. Lucide: ISC. Dependency licenses are included in their packages.

An opt-in live smoke check is available after deployment:

```sh
bun scripts/smoke.ts http://router.local:9091/transmission/web/
```

It creates one private synthetic test torrent, exercises the real file tree and optional Full speed control, checks restoration, then removes its own test torrent. It does not change existing transfers.
