<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.png">
    <img src="docs/images/logo-light.png" alt="Drift" width="160">
  </picture>
</h1>

<p align="center"><strong>Actually good torrent UI.</strong></p>
<p align="center">A Transmission web client that feels at home on your desktop and your phone.</p>

<p align="center">
  <img src="docs/images/showcase.png" width="100%" alt="Drift in light and dark themes: desktop transfers and peer graph, desktop settings, and mobile transfers and activity. Demo data.">
</p>

## Features

- **Your transfers, at a glance.** Search, filters, labels, queue controls, batch actions, and clear download states.
- **Files and peers.** File trees, priorities, renaming, trackers, and a peer graph linked to a sortable peer list.
- **Live activity.** Download and upload charts, session totals, and transfer speeds.
- **Desktop and mobile.** Desktop context menus and keyboard controls; mobile navigation and touch targets.
- **Light, dark, or automatic.** Matching themes throughout, including settings and the player. Changes save automatically.
- **Static files.** No frontend application server, database, or account to set up.

## Install

With [Bun](https://bun.sh) installed, build from this repository:

```sh
bun install --frozen-lockfile
bun run build
```

Copy the contents of `dist/` to a directory on your Transmission host. Set
`TRANSMISSION_WEB_HOME` to that directory in the daemon's environment, then restart
Transmission. Open its usual `/transmission/web/` address.

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

Drift uses Transmission's existing RPC access settings. A separate web host needs
a same-origin proxy or correctly configured CORS. Tested with Transmission 4.1;
Safari 15.4 / iOS 15.4.1 is the minimum browser target.

### Optional integrations

**Entirely optional. The normal client works without any of these.** They run on
the Transmission host and are installed separately from `dist/`.

- **[Watch videos](integrations/openwrt/drift-stream/README.md).** A small Rust companion streams complete or downloading files to the built-in player, prioritizes missing ranges for playback and seeking, and discovers matching SRT/WebVTT subtitles. Playback position is saved locally. Browser codec support applies; there is no transcoding.
- **[Router bandwidth control](integrations/openwrt/transmission-yield.md).** Let downloads yield to other network activity, with a Full speed override. The reference controller also records activity history.
- **[Tracker VPN fallback](integrations/openwrt/transmission-trackers.md).** Retry failed IPv4 UDP trackers through an existing VPN and remember successful routes. Peer traffic keeps its normal route.

The router scripts are references for a configured OpenWrt setup, not a general
installer. Read their requirements before using them; controls appear only when
the corresponding integration is detected.

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

Set Connection → RPC endpoint to `http://localhost:5173/transmission/rpc`.

Keep changes small, preserve keyboard and touch access, and respect reduced
motion. Run `bun run validate` before submitting changes. UI changes should also
pass `bun run test:e2e` and, after building, `bun run test:legacy`. Browser tests use
mock RPC data; see [AGENTS.md](AGENTS.md) for the compatibility target and tooling.

## License

[MIT](LICENSE). Third-party notices are included in [public/licenses](public/licenses).
