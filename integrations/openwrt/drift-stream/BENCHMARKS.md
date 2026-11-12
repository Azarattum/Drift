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
