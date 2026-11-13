# Optional integrations

[Drift](../README.md) works without these services. Install them separately on the
Transmission host; the frontend build does not install services or change firewall
rules. Drift shows their controls when it detects the corresponding capability.

- [Video playback](#video-playback): watch downloads, seek, resume, and load subtitles.
- [Bandwidth control](#bandwidth-control): automatic limits, Full speed, and activity history.
- [Tracker VPN fallback](#tracker-vpn-fallback): retry failed trackers through an existing VPN.

Commands below run from the repository root unless stated otherwise. Source files
are in [openwrt/](openwrt/). The streaming companion has an installer; the router
controllers need an existing OpenWrt configuration and service supervision.

## Video playback

Drift Stream is a Rust service for complete and downloading video files. It serves
verified torrent pieces to the browser without transcoding. The browser must
support the file's codecs.

### Build and install

Requires Transmission 4.1+, Linux 5.10+ with pidfd support, an explicit Transmission
configuration directory, and read access to the configured download directories.
It uses direct HTTP on the RPC port plus one: RPC on 9091 means streaming on 9092.
RPC port 65535 is unsupported. Both ports must be reachable by the browser.

Install Bun and stable Rust with `rust-lld` on the build machine:

```sh
bun integrations/openwrt/drift-stream/tasks.ts check
bun integrations/openwrt/drift-stream/tasks.ts build
```

The default target is `aarch64-unknown-linux-musl`. Pass another Linux/musl target
after `build` if needed, such as `x86_64-unknown-linux-musl`.

Copy the contents of `integrations/openwrt/drift-stream/dist/` to a staging
directory on the router. Run `sh install.sh` there as root, then restart
Transmission when ready. This native build is separate from the frontend's `dist/`.

The installer backs up and patches a recognized `/etc/init.d/transmission` and
installs the binary and `/usr/libexec/drift-stream.procd`. It stops if the init
script or backup needs review. It does not restart Transmission or open ports.
The companion runs with Transmission's user, group, and configuration directory;
procd restarts it, and stopping Transmission stops both processes.

Restart after changing access settings or download roots. To disable streaming,
remove `/usr/libexec/drift-stream.procd` and restart Transmission. Check the init
hook after package or firmware upgrades.

### Using the player

Choose **Watch video** from a torrent or file menu, the hover controls, or the
inspector's film button. Multiple videos open a file chooser. The player remembers
position locally per server, torrent, and file and offers **Resume** or **Start over**.

Starting playback marks the video and matching subtitles wanted, enables sequential
downloading, and resumes a paused torrent if the video is incomplete. Missing
ranges trigger explicit priority requests for playback and seeking. Closing the
player cancels requests but leaves those download settings in place. Multiple
players of one torrent share its sequential cursor.

SRT and WebVTT files match videos by directory and filename stem, including language
suffixes such as `Episode 01.en.srt`. Tracks support UTF-8 and BOM-marked UTF-16;
conversion keeps timing and basic text formatting and removes styles and layout.
Choose a track to fetch it; missing data retries while selected. Embedded subtitles
depend on the browser. ASS styling, encoding detection, and subtitle offsets are
not supported.

### Access and troubleshooting

The service reads Transmission's bind address, access policy, and download roots.
Authenticated setups check credentials through RPC. File-scoped playback tickets
support native media requests; changing download priority still requires an
explicit authenticated request when RPC authentication is enabled. Allowed browser
origins use the validated hostname and RPC or streaming port.

Only files under configured roots are served. Path traversal, symlinks, hardlinks,
and non-regular files are rejected. Responses contain verified pieces only; reads
wait for missing pieces and stop on disconnect. The service trusts Transmission's
verification and the host's disk writers. It does not independently rehash pieces.

| Problem                 | Check                                                         |
| ----------------------- | ------------------------------------------------------------- |
| Service unavailable     | Companion process, adjacent port, and direct HTTP connection  |
| Authentication rejected | Sign in again; credentials are checked through Transmission   |
| Video not found         | Torrent, file index, and configured download roots            |
| Waiting for data        | Verification has finished and peers have the requested pieces |
| Unsupported video       | Browser codec support and a recognized video container        |
| Subtitle unavailable    | Matching filename, downloaded pieces, and supported encoding  |

### Checks and measurements

`tasks.ts check` runs installer tests, Rust formatting, Clippy, and Rust tests.
To measure a built companion on an OpenWrt host:

```sh
bun integrations/openwrt/drift-stream/benchmark.ts root@router.local 19091 --player > stream-benchmark.json
```

Requires SSH key access, local FFmpeg, and five free ports starting at the supplied
port. For `--player`, also build the frontend and install Playwright Chromium.
The script starts an isolated Transmission instance and temporary procd service,
creates fixtures on the download disk, and removes its fixtures and services on
exit. It leaves the production service running but consumes disk, CPU, and network
capacity. Use a host where that load is acceptable.

Results include idle CPU and context-switch counters, resident memory, transfer
throughput, range integrity, missing-piece scheduling, and process lifecycle
checks. `--player` also exercises real playback, resume, and incomplete-file seeks.
Record the binary, host, and workload with any result. LAN throughput and warm-cache
samples do not establish WAN performance or physical-phone compatibility.

## Bandwidth control

The controller lowers Transmission's limits when other traffic or router resource
use needs headroom. It also provides **Full speed** and one hour of activity history.

### Set up the controller

Requires OpenWrt with fw4/nftables, `transmission-remote`, `curl`, `ucode` with its
`fs` and `socket` modules, and `snice`. The helpers assume external storage mounted
at `/home` and locally permitted unauthenticated RPC. Authenticated deployments
need credential handling added to the helpers.

Install these files together; the priority helper imports the tracker module even
if VPN retries are unused:

| Source under `openwrt/`    | Install at                                     |
| -------------------------- | ---------------------------------------------- |
| `transmission-yield`       | `/usr/libexec/transmission-yield` (executable) |
| `transmission-priority.uc` | `/usr/libexec/transmission-priority.uc`        |
| `transmission-trackers.uc` | `/usr/libexec/transmission-trackers.uc`        |

Configure two named counters in `inet fw4`:

- `transmission_yield_traffic`: bytes from other network traffic. Supply rules for
  your network that exclude router-local Transmission traffic and management polling.
- `transmission_yield_interactive`: forwarded UDP packets. Install
  `openwrt/transmission-yield-interactive.nft` as a fw4 table include under
  `/etc/nftables.d/`. It excludes DNS, DHCP, NTP, SSDP, and mDNS ports.

Run the shell controller under your service supervisor after storage and firewall
setup. No init script is supplied. The helper reads RPC and web-home settings from
Transmission's UCI configuration; `DRIFT_RPC_URL` can override its RPC URL. The
shell controller has its own `rpc` setting below. Both must reach the same daemon.

Configure a `main` section in `/etc/config/transmission_yield`:

```text
config transmission_yield 'main'
    option rpc '127.0.0.1:9091'
    option interval '2'
    option idle_seconds '20'
    option traffic_bytes_per_second '8192'
    option interactive_packets_per_second '20'
    option busy_download_kbytes '128'
    option busy_upload_kbytes '32'
    option minimum_available_kbytes '16384'
    option maximum_cpu_percent '70'
```

These are the defaults: rates are bytes/s or packets/s as named; limits and memory
are KiB; interval and idle time are seconds. Either traffic threshold needs three
consecutive samples. Resource pressure, missing counters, or counter resets apply
limits immediately. Twenty quiet seconds remove the automatic limits. UDP rate is
a heuristic for calls and games, so quiet sessions may fall below both thresholds.

### Full speed, history, and status

**Full speed** uses the `router:full-speed` torrent label. The helper saves and
restores affected settings in `/home/.transmission-priority/state.json` and clears
overrides when the selected download stops, completes, fails, or loses its label.
Other downloads retain their yielding limits. Closing the browser does not stop
the controller.

The helper publishes `full-speed.json` and `activity.json` in Transmission's web
home. History samples download/upload rates every ten seconds and publishes every
thirty seconds; samples contain timestamps and rates, without torrent names or
peer addresses. History lives in RAM and covers one hour.

Inspect `/var/run/transmission-yield.status` for mode, reason, traffic, CPU, and
memory. `/var/run/transmission-priority.status` lists active overrides. If controls
are missing, check helper execution, the `/home` mount, writable web home, and
fresh capability files. Missing counters keep conservative limits in place.

## Tracker VPN fallback

This extends the bandwidth helper; it needs no separate daemon. Requires its setup
above, an existing default-route WireGuard or AmneziaWG WAN, VPN masquerading,
`ip`, `nft`, `ubus`, and `conntrack`. Review routing identifiers before starting it.

In the tracker list, use the retry control for failed IPv4 UDP trackers. It appears
when a fresh capability reports a compatible VPN and is disabled while no healthy
tunnel is available or a retry is pending. The one-shot
`router:tracker-vpn-retry` label requests the action through normal RPC.

The helper temporarily routes failed trackers through the VPN and asks Transmission
to reannounce. Successful announcements are remembered in
`/home/.transmission-priority/tracker-vpn.json`; failures and retries pending after
90 seconds lose their temporary routes. Removed trackers are pruned, and a later
failed VPN announcement removes its remembered route. Ordinary labels stay intact.

Tunnel selection follows `/var/run/awg-policy.json` when present. Without it, the
helper selects the active compatible default-route interface with the lowest
metric. A policy with no healthy winner leaves retries unavailable.

Only IPv4 UDP tracker discovery is selected by process UID, endpoint, and BEP15
packet fields. Peer traffic, DHT, PEX, HTTP(S) trackers, and IPv6 keep their existing
routes. Shared tracker endpoints share a discovery route. DNS refreshes each minute;
private and loopback destinations are excluded.

The helper owns nft table `inet drift_trackers`, route table `31200`, rule priorities
`1391`/`1392`, and packet bits `0x01000000`/`0x02000000`. Check for conflicts with your
routing and mark masks. Selected trackers have an unreachable fallback if the VPN
disappears. The helper does not reload the firewall or replace global WAN policy.

For diagnosis, inspect `full-speed.json`'s `trackerVpn` field, the saved state,
`nft list table inet drift_trackers`, routing rules, and conntrack entries. A saved
VPN indicator records a successful announcement; packet counters and conntrack
show the route actually in use.
