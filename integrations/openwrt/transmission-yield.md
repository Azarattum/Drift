# Automatic bandwidth yielding

The governor requires fw4 named counters `transmission_yield_traffic` (bytes
from traffic other than Transmission) and `transmission_yield_interactive`
(forwarded UDP packets). Install `transmission-yield-interactive.nft` as a
fw4 table include in `/etc/nftables.d/` alongside the existing traffic counter.
Do not include router-local Transmission traffic in either counter.

Defaults, configurable in the `main` section of `/etc/config/transmission_yield`:

| Option                           | Default | Meaning                                   |
| -------------------------------- | ------- | ----------------------------------------- |
| `interval`                       | 2       | Sampling interval, seconds                |
| `idle_seconds`                   | 20      | Quiet time before removing session limits |
| `traffic_bytes_per_second`       | 8192    | Other traffic activity threshold          |
| `interactive_packets_per_second` | 20      | Non-discovery UDP activity threshold      |
| `minimum_available_kbytes`       | 16384   | Available-memory safety floor             |
| `maximum_cpu_percent`            | 70      | CPU safety ceiling                        |

Either traffic threshold must be reached for three consecutive samples before
activity resets the idle timer. Short background bursts are ignored. CPU,
memory, missing counters and counter resets trigger yielding immediately.
Activity caps downloads at 128 KiB/s and uploads at 32 KiB/s by default.
Full speed overrides these automatic limits for the selected transfer.

UDP packet rate detects low-bandwidth voice and game traffic that a byte-only
threshold can miss. It is a heuristic, not application identification: unusually
quiet games or voice sessions can fall below both thresholds. DNS, DHCP, NTP,
SSDP and mDNS ports are excluded from the interactive packet counter.

Inspect `/var/run/transmission-yield.status` for the current mode, reason,
traffic rate, UDP packet rate and resource measurements. Counter failures keep
conservative limits in place rather than incorrectly declaring the network idle.
