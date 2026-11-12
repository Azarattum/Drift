# Router measurements

Measured 2026-11-13 local time on the user's netis NX32U, ARM64 Cortex-A53,
239,564 KiB reported RAM, OpenWrt 25.12.6 / Linux 6.12.112 and Transmission 4.1.3.
An isolated second Transmission instance and procd service used the existing SSD.
The normal router services and original Transmission remained running.

Release target: `aarch64-unknown-linux-musl`, stable Rust 1.99.1, generic target CPU.
The statically linked binary was **962,432 bytes**. SHA-256:

```text
0a4f11ea0feb51368793da9dde156e98abe1153fef57cbe46199bf5668c8f8bc
```

Raw counters: [benchmarks/openwrt-arm64.json](benchmarks/openwrt-arm64.json).
Reproduce with the documented Bun benchmark script. These are measured samples,
not hardware ceilings, latency percentiles, or promises under arbitrary loads.

## Idle

After one HEAD request and a 1.5-second worker-retirement delay, the benchmark
sampled the process before and after ten seconds without clients:

- CPU ticks: **0 → 0**.
- Voluntary context switches: **6 → 6**.
- Involuntary context switches: **3 → 3**.
- Resident/high-water memory: **1,032 KiB**.
- Threads: **1**.

This observed no CPU consumption or scheduling wakeups during that interval.
Resident memory and an open listening socket remain allocated. CPU accounting is
quantized; this is not a mathematical proof of zero consumption forever. This
firmware omits `/proc/<pid>/wchan` and `schedstat`, so neither is claimed as
additional evidence.

## Transfer samples

The fixture is a real 12,890,594-byte H.264/MP4 produced on the build machine with
faststart metadata. Each reader fetched it eight times; all full responses were
checked against its SHA-256. Disk cache was warm after verification and HEAD.
The client was a LAN-connected build machine; its scheduling, hashing, network
and SSH counter collection affect the observations.

| Sample                             |       Bytes | Elapsed |  Aggregate throughput | Daemon CPU ticks / whole-machine ticks |
| ---------------------------------- | ----------: | ------: | --------------------: | -------------------------------------: |
| One reader                         | 103,124,752 | 2.084 s |           47.20 MiB/s |                               88 / 454 |
| Four readers                       | 412,499,008 | 6.241 s |           63.04 MiB/s |                            457 / 1,280 |
| One paced reader, 20 Mbit/s target |  12,890,594 | 5.405 s | 19.08 Mbit/s observed |                              9 / 1,074 |

The paced transfer's tick ratio corresponds to about **0.84% of aggregate CPU
capacity**, or **1.68% of one core** on the two-core router. This does not assume a
particular `CLK_TCK`. Sampling brackets include SSH overhead, so the percentage
is approximate. No claim is made that maximum-throughput CPU utilization is low.

Process resident memory after the concurrent sample was 1,040 KiB, with a recorded
high-water mark of **1,436 KiB**. Two bounded disk workers were active in addition
to the reactor. This excludes kernel socket/page caches and Transmission's own
memory. No cold-disk, multi-gigabyte-file, WAN/TLS, physical-iPhone or long-running
soak performance result is claimed.

## Correctness and lifecycle on hardware

- A `206` byte-range response matched the original requested bytes.
- Arbitrary filesystem URLs, path query arguments and nonexistent indices were
  denied (`404`, `400`, `404`).
- The fixture was replaced with a sparse `.part` file containing only the first
  piece. Transmission verified that prefix and reported the rest missing.
  The prefix streamed correctly; a request for a missing range waited without
  returning zeros and was canceled by the client.
- Terminating the fixture's Transmission process caused the companion to exit;
  this was observed within **192 ms**, including an SSH round trip and daemon
  shutdown. This is an upper observation, not pidfd notification latency.
- The actual procd sibling hook respawned both processes after that termination,
  and the replacement companion served the video again.
- Stopping the isolated procd service left neither instance running. All test
  data and service registrations were removed.

Portable HTTP tests additionally cover authentication/session negotiation, CORS,
origin/Host rejection, HEAD, malformed ranges, fake media headers, symlinks,
hardlinks, unaligned multi-file piece boundaries, missing-piece transitions and
the absence of continued RPC polling after a body disconnects.

## Dependency advisory lookup

An OSV batch query on 2026-11-13 checked all 48 locked registry packages, including
development dependencies, and returned no advisories. The result is saved in
[benchmarks/dependency-osv.json](benchmarks/dependency-osv.json). This is an advisory
lookup, not proof that the application is vulnerability-free. A separate
`cargo-audit` database fetch did not complete and was stopped; no completed
RustSec audit is claimed.

## Player integration follow-up

The production frontend was subsequently served by the isolated Transmission
instance on the same router. Chromium opened **Watch video**, decoded the actual
MP4, played it, sought forward, closed the dialog, and resumed from the saved
position. This used the production `dist/` bundle and the native companion, with
no mocked RPC or media responses. The normal Transmission service stayed running.
This browser check does not represent a physical iPhone test.

This follow-up includes the file-scoped native playback session changes. The
statically linked binary was **980,400 bytes**, SHA-256:

```text
725c5e3946e704ea25582cddeb06f433cccd1209cab1d62cfc3b478af7be5bcd
```

Raw counters: [benchmarks/player-integration.json](benchmarks/player-integration.json).
The same ten-second idle sample, taken after closing the browser, recorded
**17 → 17 CPU ticks**, **285 → 285 voluntary context switches**, and
**77 → 77 involuntary context switches**. Resident memory was **1,052 KiB** with
one thread. One reader measured **38.50 MiB/s**, four readers **61.94 MiB/s**, and
the paced 20 Mbit/s sample consumed **9 CPU ticks / 1,074 whole-machine ticks**.
These are independent samples under the same limitations as the original run.
Range integrity, sparse `.part` waiting, access rejection, and procd
crash/respawn/stop checks passed again; observing the companion exit took **211 ms**.
The isolated service, temporary frontend and test data were removed afterward.

## Incomplete playback and subtitle follow-up

The range-scheduling/subtitle build was measured on the same router and SSD on
2026-11-13. Binary size: **1,040,672 bytes**, SHA-256:

```text
2b87bb7cd95fe0069dd4968dc1645ff8a52bbfa61d0ecd35e008f32f969b1702
```

Raw counters: [benchmarks/incomplete-playback.json](benchmarks/incomplete-playback.json).
The production bundle ran in Chromium against real Transmission RPC and the
companion, with no mocked media or RPC responses. In addition to complete-file
playback/resume and byte-integrity checks:

- A sparse `.part` contained only the first verified piece. A request for a
  missing middle piece returned no unverified bytes. An explicit priority POST
  moved the real Transmission sequential cursor to that exact piece.
- The player opened at **2.03% downloaded**. A separate, temporary Transmission
  seed, limited to 512 KiB/s, supplied missing pieces through a LAN TCP relay.
  Playback passed four seconds, beyond the original 0.61-second prefix.
- At **20.31% downloaded**, the browser sought to 20 seconds and continued past
  **21.008 seconds**. This exercises actual missing-piece download and native
  browser playback rather than a completed-file seek or a mocked bitfield.
- The test exposed a rejected CORS preflight on ticketed priority URLs. After
  fixing that route, the browser could schedule missing pieces and preserve its
  stream while waiting, instead of exhausting its eight-second reconnect budget.
- Companion exit, procd respawn and service stop passed again. All fixture
  processes and data were removed; the original Transmission was not restarted.

The ten-second idle sample recorded **16 → 16 CPU ticks**, **352 → 352 voluntary
context switches** and **137 → 137 involuntary context switches**, with one thread
and **1,108 KiB** resident memory. One reader measured **46.35 MiB/s**, four readers
**61.42 MiB/s**; the paced sample consumed **9 / 1,077** process/whole-machine ticks.
The earlier measurement limitations still apply. This is one controlled partial
torrent and Chromium run, not evidence that every codec, swarm or physical iPhone
will behave identically. Subtitle conversion and native cue rendering are covered
separately by the Rust, Chromium, current WebKit and pinned WebKit 15.4 checks.
