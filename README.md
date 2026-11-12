# Drift

A quiet, compact web client for Transmission. Built for desktop, comfortable on a phone. Ships as static assets. Optional router integrations add Full speed control and activity recording; the standard client needs no application server.

## Features

- Compact, searchable transfer list with filters, sorting, keyboard navigation, range selection, batch actions, and desktop context menus. Touch devices always expose an action menu.
- Explicit stages: peer discovery, metadata retrieval, verification, queueing, missing pieces, downloading, and seeding. Unknown metadata is never shown as a zero-byte download.
- Download/upload history built with [LayerChart](https://layerchart.com), using measured samples, time axes, adaptive speed units, and interactive tooltips. Loads available server history or cached browser observations; background tabs poll less frequently.
- Mobile bottom navigation for Transfers, Activity, and Settings, with a separate reachable Add button, safe-area spacing, and touch targets of at least 44 × 44 CSS pixels.
- Overlay inspector that leaves the desktop layout stationary, with a selectable file tree, folder-wide download selection, file priority and renaming, tracker editing, linked peer graph/list selection, statistics, labels, and transfer options. File search preserves ancestor paths and the tree supports arrow-key navigation.
- Grouped settings with a desktop navigation column, an iOS-style section list and back navigation on phones, custom switches and checkboxes, persistent commit actions, and inline progress/results for network checks.
- Magnets, torrent URLs, multi-file upload, drag and drop, file relocation, verification, reannouncing, queue ordering, and magnet/hash copying. Copying works on HTTP LAN pages; browsers that block it offer selectable text.
- Server bandwidth, slow mode, directories, queue, seeding, encryption, discovery, peer, port-mapping, and blocklist settings.
- Optional **Full speed** extension, detected at runtime. Unsupported controls stay hidden on standard daemons.
- Light/dark/system themes, reduced motion, keyboard focus, native modal focus containment, and bundled fonts.

## Development

Install [Bun](https://bun.sh), then:

```sh
bun install --frozen-lockfile
bun run dev
```

Svelte 5 runes, Tailwind CSS 4, LayerChart 2, D3 scales, Lucide, and Inter Variable. Vite compiles Svelte; Bun manages packages and runs scripts. Biome checks TypeScript/CSS, svelte-check checks Svelte, types, and accessibility, and Prettier formats the project.

```sh
bun run check
bun run lint
bun run format
bun run test
bun node_modules/@playwright/test/cli.js install chromium webkit
bun run test:e2e
bun run build
bun run validate
```

Browser tests use isolated RPC fixtures. To develop against a real daemon:

```sh
DRIFT_RPC_PROXY=http://router.local:9091 bun run dev
```

In Connection settings use `http://localhost:5173/transmission/rpc` for this proxy. The endpoint is remembered locally. Credentials stay in memory and must be entered again after reload. Use HTTPS for authenticated remote connections. Cross-origin servers must allow CORS and expose the X-Transmission-Session-Id header, or use a same-origin proxy.

## Browser compatibility

Safari 15.4 / iOS 15.4.1 is the minimum browser target, including an iPhone 8 viewport of 375 × 667 CSS pixels. JavaScript and CSS builds explicitly target Safari 15.4. Native request timeouts have an AbortController fallback; the inert polyfill is downloaded only when the browser lacks it. Blocked storage falls back to preferences in memory. New color interpolation and backdrop entry effects are optional, with compatible colors, prefixed blur, and viewport sizing underneath.

On browsers without native inert, modal backgrounds are explicitly isolated and native dialog animation is skipped to avoid Safari 15.4 bugs fixed in 15.5. Modern browsers retain native modal handling and the existing animations. Tailwind 4's general browser requirement is newer; Drift tests its shipped CSS subset and supplies the needed fallbacks. Adding framework utilities still requires checking this minimum target.

Run the production bundle in the pinned, archived WebKit 15.4 engine:

```sh
bun node_modules/playwright-legacy/cli.js install webkit
bun run build
bun run test:legacy
```

The legacy check exercises the real compiled assets with isolated RPC fixtures, including graph rendering, file selection, peers, clipboard fallback, repeated dialogs, background isolation, themes, and 44px touch targets. Some archived builds expose APIs newer than the stable iOS release, so the check disables them explicitly. This is an older WebKit engine at iPhone 8 size, not a physical iOS device or an iOS simulator; hardware performance, the on-screen keyboard, and browser chrome still need a device check.

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

## Activity history

Transmission's [RPC statistics](https://github.com/transmission/transmission/blob/4.0.5/docs/rpc-spec.md#42-session-statistics) provide current speeds and cumulative totals. They do not provide a timestamped speed history.

Drift detects an optional `activity.json` file next to its frontend assets:

```json
{ "version": 1, "updated": 1790000000, "samples": [[1790000000000, 524288, 65536]] }
```

Each sample is `[Unix time in milliseconds, download bytes/second, upload bytes/second]`. `updated` uses Unix seconds. The frontend accepts one hour of validated samples, merges them with live observations, and leaves breaks across missing intervals. An inactive period has a compact summary instead of an arbitrary speed scale.

The optional OpenWrt priority integration records aggregate torrent rates every ten seconds, reusing the existing RPC poll. It keeps a bounded working copy in RAM and publishes an atomic SSD snapshot every thirty seconds, so recording continues with every browser closed and survives reloads. It records no torrent names or peer addresses. The helper's existing mounted-SSD guard prevents writes to router flash. Activity before installation cannot be reconstructed.

Without a server history feed, Drift caches observations from the current browser and labels the source accordingly. Browser observations cannot fill periods when no browser was connected.

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

Flat surfaces, a restrained hierarchy, contextual controls, and explicit state. Readable typography with a 12px minimum for annotations, keyed FLIP movement, stable inspector exits, and short overlay motion. No decorative gradients or private design-library dependencies.

MIT. Inter: SIL Open Font License. Lucide and D3: ISC. LayerChart: MIT. The inert polyfill: W3C Software License. Third-party notices are included in public/licenses and the compiled bundle.

An opt-in live smoke check is available after deployment:

```sh
bun scripts/smoke.ts http://router.local:9091/transmission/web/
```

It creates one private synthetic test torrent, exercises the real file tree and optional Full speed control, checks restoration, then removes its own test torrent. It does not change existing transfers.
