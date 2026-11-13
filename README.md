<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.png">
    <img src="docs/images/logo-light.png" alt="Drift" width="160">
  </picture>
</h1>

<p align="center"><strong>Actually good torrent UI.</strong></p>
<p align="center">A Transmission web client for desktop and mobile.</p>

<p align="center">
  <img src="docs/images/showcase.png" width="100%" alt="Drift in light and dark themes: desktop transfers and peer graph, desktop settings, and mobile transfers and activity. Demo data.">
</p>

## Features

- **Transfers.** Search, filter, label, reorder, and manage torrents in batches.
- **Files and peers.** Select files, set priorities, and rename them. Inspect connections in a sortable peer list or an interactive graph.
- **Activity.** Follow download and upload charts, current speeds, and session totals.
- **Desktop and mobile.** Keyboard shortcuts and context menus on desktop. Touch controls and bottom navigation on phones.
- **Themes.** Light, dark, or system theme across the app and player. Settings save as you change them.
- **Video playback.** Watch complete or downloading files and resume where you left off. Requires the optional streaming companion and a browser that supports the file's codecs.
- **Automatic bandwidth control.** Optional router scripts slow downloads when other network activity needs the connection. Full speed bypasses those limits for a download.
- **Tracker VPN fallback.** The optional router integration retries failed IPv4 UDP trackers through a VPN and remembers successful routes. Peer traffic keeps its normal route.
- **Static files.** The web client needs no application server, database, or separate account.

## Install

Install [Bun](https://bun.sh), then build the web client:

```sh
bun install --frozen-lockfile
bun run build
```

Copy the contents of `dist/` to a directory on your Transmission host. Set
`TRANSMISSION_WEB_HOME` to that directory in the daemon's environment, then restart
Transmission. Open `/transmission/web/` at your Transmission address.

<details>
<summary>On OpenWrt</summary>

Copy `dist/` to the router, then point the Transmission service at it:

```sh
uci set transmission.@transmission[0].web_home='/path/to/drift'
uci commit transmission
/etc/init.d/transmission restart
```

`/path/to/drift` should contain `index.html` and `assets/`, not another `dist/` folder.

</details>

Drift uses Transmission's RPC access settings. If you host the web client
separately, configure a proxy or CORS so it can reach the daemon. Tested with
Transmission 4.1. Requires Safari 15.4 / iOS 15.4.1 or a current Chrome or Firefox.

### Optional integrations

**The standard client works without these integrations.** Install them separately
on the Transmission host:

- **[Streaming companion](integrations/openwrt/drift-stream/README.md).** A Rust service that streams video, prioritizes missing data for playback and seeking, and finds matching SRT/WebVTT subtitles. It does not transcode files.
- **[Bandwidth controller](integrations/openwrt/transmission-yield.md).** OpenWrt scripts for automatic limits, Full speed, and recorded activity history.
- **[Tracker VPN fallback](integrations/openwrt/transmission-trackers.md).** OpenWrt integration for an existing VPN. Supports IPv4 UDP trackers.

The router scripts assume a configured OpenWrt system. Read their requirements
before installing them. Drift shows integration controls only when it detects the
corresponding service.

## Development

Svelte 5, TypeScript, Tailwind CSS, and Vite. Use Bun for packages and scripts.

```sh
bun install --frozen-lockfile
bun run dev
```

For a local proxy to a real daemon:

```sh
DRIFT_RPC_PROXY=http://router.local:9091 bun run dev
```

In Connection settings, set the RPC endpoint to `http://localhost:5173/transmission/rpc`.

Run `bun run validate` before submitting changes. For UI changes, also run
`bun run test:e2e` and `bun run test:legacy` after building. Keep keyboard controls,
touch targets, and reduced motion working. Browser tests use mock RPC data.
[AGENTS.md](AGENTS.md) has the tooling and browser compatibility requirements.

## License

[MIT](LICENSE). Third-party notices are included in [public/licenses](public/licenses).
