# Drift Stream

Optional native HTTP companion for Transmission 4.1+ on OpenWrt/Linux. This is an
independent Rust package, not a workspace member or frontend dependency. Vite,
Bun's existing dependencies, the static client, and the frontend `dist/` are
unchanged. There is no FFmpeg, transcoding, SMB client, media database, or library
scanner. It reads the same local disk files that SMB shares.

## Build and check

From the repository root:

```sh
bun integrations/openwrt/drift-stream/tasks.ts check
bun integrations/openwrt/drift-stream/tasks.ts build
```

Cargo is the Rust compiler/dependency tool behind the Bun task entrypoint. A stable
Rust toolchain with `rust-lld` is required. The default release target is
`aarch64-unknown-linux-musl`, statically linked for ARM64 OpenWrt. The target is
generic ARM64, not `target-cpu=native` from the build machine. Other Linux/musl
targets can be passed to the build task but have not been hardware-tested.

`Cargo.lock` is committed; builds and checks use `--locked`. Release builds use
LTO, one codegen unit, stripped symbols and abort-on-panic. Outputs go **only** in
this project's ignored `dist/`, separate from the frontend bundle. Cargo's
ignored `target/` never goes onto the router. No Rust tooling is required there.

## Installation and lifecycle

Upload only this project's `dist/` to a staging directory on the router. Run
`sh install.sh` there as root. The installer validates and backs up the existing
Transmission init script, then adds one guarded source line after its
`procd_close_instance`. It refuses ambiguous/unrecognized layouts. It installs
the binary and a small `drift-stream.procd` hook; it does **not** restart or
reconfigure Transmission, open firewall ports, or change existing torrents.

Restart Transmission when ready to activate the companion. There is no second
UCI configuration and no separate service to enable. Each enabled Transmission
configuration gets a sibling procd instance with its existing config directory,
user and group. The companion reads `settings.json` and derives:

- HTTP bind address from `rpc-bind-address`.
- Stream port from `rpc-port + 1`; port 65535 fails closed rather than guessing.
- Local RPC URL from `rpc-bind-address`, `rpc-port` and `rpc-url`.
- Download and enabled incomplete roots, client whitelist, permitted hostnames
  and whether RPC authentication is required.

Both hyphenated and snake_case settings keys are understood. Settings are a
startup snapshot: restart Transmission/its service after changing access policy
or download roots. File locations and piece availability come from live RPC.
Torrents relocated outside the configured roots are deliberately unavailable.

At startup, process discovery waits up to ten seconds for the matching daemon
because procd can start siblings in either order. Once attached, a Linux pidfd
delivers process-exit notifications; there is no watchdog polling. If Transmission
crashes, the companion exits and procd respawns the siblings. Stopping the service
stops both and cancels all streams. Linux pidfd support is required (kernel 5.10+).

To disable, remove `/usr/libexec/drift-stream.procd` and restart Transmission.
The guarded init line is harmless without that file. Keep the init-script backup
for review/rollback; do not blindly overwrite an init script changed by a firmware
upgrade. OpenWrt package upgrades can replace the init script: re-run the installer
after reviewing the new script and any previous backup.

## HTTP contract

The stream server is on the same hostname as Transmission, at the adjacent port.
It accepts HTTP/1.1, closes connections after each response, and does not act as
an RPC proxy. It never accepts a filesystem path or URL to fetch.

| Request                                               | Behavior                                                                                                                                                                                                                            |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/status`                                      | Authenticated capability JSON, no paths or credentials.                                                                                                                                                                             |
| `POST /v1/play/<40-character-info-hash>/<file-index>` | Requires `X-Drift-Stream: 1` and no body. Marks the selected video wanted, enables sequential mode, sets its starting piece, and resumes a paused torrent only if that video is incomplete. Returns `{version, src, type, length}`. |
| `GET /v1/media/<hash>/<file-index>`                   | Verified video bytes, including `.part` and enabled incomplete-directory resolution. No torrent settings are changed by GET.                                                                                                        |
| `HEAD /v1/media/<hash>/<file-index>`                  | The same type, length and range headers without a media body.                                                                                                                                                                       |
| `OPTIONS ...`                                         | Preflight for the permitted Drift origin and explicit headers/methods.                                                                                                                                                              |

Single byte ranges, suffix ranges and open-ended ranges return `206` with
`Content-Range`. Invalid/multiple ranges return `416` with `bytes */<length>`.
There is no cache/ETag contract for changing files. Errors use fixed text and never
include RPC strings, local paths, torrent names or credentials.

The Play request sends the same Basic `Authorization` header when Transmission
requires it. After successful RPC authentication, the companion creates a random
256-bit, file-scoped session and returns a `src` with an opaque `ticket` query
parameter. It also sets an HttpOnly, SameSite=Strict, path-scoped cookie. The ticket
supports WebKit native range requests that omit the cross-origin cookie. Neither
contains a username or password. The frontend accepts only the exact expected
media path on the derived companion origin and a single well-formed ticket.

Sessions expire after twelve hours, are bounded to sixteen entries, remain only
in memory, and disappear on restart. Expiry is checked on requests, with no idle
timer. Each media request still authenticates against Transmission using the
in-memory credentials, so password changes invalidate existing sessions. A ticket
cannot read another file, change download settings, or access RPC. Only the
`ticket` query parameter is accepted on media GET/HEAD; arbitrary path arguments
remain rejected. Treat playback URLs as temporary access links: they may be handed
to a cast device and should not be shared or logged by an added proxy. The service
has no access logger or analytics and returns `Referrer-Policy: no-referrer`.

CORS permits HTTP origins on the same validated hostname at the RPC or stream
port. Credentials are allowed only for that exact origin. Aliases must match the
inherited host whitelist or the socket's local IP. There is no automatic HTTPS
termination or cross-host proxy support.

## Verified download behavior

Torrent metadata, filenames, file ordering, piece geometry and the base64 piece
bitfield are resolved through Transmission's legacy-compatible RPC. The daemon
does not parse or expose Transmission's private `.torrent`/`.resume` files.

Incomplete-file GETs require sequential mode, since Transmission 4.1 flushes its
cache when sequential mode is enabled and as pieces finish. Checking torrents
return `409`. Reads stop at the first missing piece, even inside a 64 KiB chunk or
across an unaligned multi-file boundary. Only a request waiting for a missing
piece polls RPC, every 500 ms, with a 30-second per-gap deadline. Disconnecting
cancels that wait; a timeout terminates the response instead of returning zeros.
Unexpected truncation or changed metadata also terminates the stream.

This is not a second torrent engine. It cannot demand an arbitrary missing piece
without changing Transmission's torrent-wide sequential cursor. Play selects the
file's starting piece; subsequent byte-range seeks wait for available pieces.
Concurrent Play operations on the same torrent share Transmission's single
cursor. MP4 metadata at the end can delay startup. The frontend implements playback positions and its watching UI; arbitrary missing-piece seek prioritization and container indexing are not provided by this daemon.

## Security boundary

- An existing, RPC-listed torrent and file index are mandatory. Only MP4/M4V,
  MOV, MKV, WebM, AVI and MPEG-TS extensions are accepted, with a matching
  recognized container header read from verified bytes. JSON, torrent metainfo,
  resume files, subtitles, HTML and arbitrary downloads have no serving route.
- Container identification is a bounded signature check, **not** a full demuxer,
  codec validator or malware scanner. A malformed or audio-only container with a
  misleading video extension may pass identification; this server does not
  promise playable video. Browser codec support is unchanged.
- Roots are inherited administrative authority. Within them, descriptor-relative
  `openat` walks refuse symlinks, `..`, absolute paths, devices, FIFOs, directories
  and hardlinks. There is no canonicalize-then-open race and no shell invocation
  in request handling. Roots are opened once; replacing a path with a symlink
  later cannot redirect an existing descriptor.
- Client IPs follow the inherited RPC wildcard whitelist. Host checks, exact
  origins and the non-simple playback header protect against rebinding and
  cross-site mutations within that policy. Disabling/broadening the inherited
  whitelist broadens access; the companion is not an independent login system.
- Each response has a fixed MIME type, `nosniff`, a restrictive CSP, and
  `Cache-Control: no-store`. There are eight connection slots, four media
  requests, 16 KiB HTTP parsing buffers, serialized five-second RPC exchanges
  capped at 1 MiB, 64 KiB media chunks and at most two disk workers. Headers have
  a five-second deadline; connections have a twelve-hour lifetime cap. The procd
  file-descriptor limit is 64. A malicious/stalled client can occupy one of these
  bounded slots; this is not an internet-facing hardened streaming CDN.
- A writer with SMB/local write access can modify the media itself. RPC-verified
  availability is not independent rehashing of every disk read. The shared
  filesystem and Transmission are trusted; symlink/path tricks and untrusted
  RPC text are not.

## Resource design and measurement

One Tokio reactor multiplexes connections. Blocking file reads run on a bounded
two-worker pool so a disk miss does not block unrelated sockets. Workers retire
after one second. Body backpressure bounds data in flight; there are no unbounded
prefetch queues, whole-video buffers, directory scans, persistent RPC connections,
periodic health checks or date-header timers. Memory is not zero at idle; the
target is **no periodic application work**, not a claim of mathematically zero
CPU under every possible operating-system condition.

No hand-written SIMD or unsafe uninitialized read buffers are used. This is an
I/O-bound byte-serving path, not video decoding. Compiler/crate optimizations are
retained. Adding vectorized parsing, extra worker threads or a different I/O path
needs a measured improvement on the target router, not a speculative speed claim.

Run the hardware benchmark from the build machine (local FFmpeg generates a real
H.264/MP4 fixture; FFmpeg is never installed on the router):

```sh
bun integrations/openwrt/drift-stream/benchmark.ts root@router.local
```

The default test ports are 19091–19093; supply another unused RPC port as the
second argument if necessary. Add `--player` as the third argument to stage the production frontend `dist/` into the isolated Transmission web home and exercise actual Chromium playback and resume from the router-served app. The script starts an isolated Transmission and
procd service, uses a temporary directory on the existing download disk, validates
SHA-256 hashes and byte ranges, measures idle counters and paced/concurrent
transfers, tests a sparse `.part`, exercises crash/respawn/stop, and removes its
own processes, service and files. It does not change the real Transmission
configuration or existing torrents. It does create temporary test data on the
same disk and network traffic, so it is not an isolated laboratory load.

Hardware results and limits are recorded in [BENCHMARKS.md](BENCHMARKS.md).
