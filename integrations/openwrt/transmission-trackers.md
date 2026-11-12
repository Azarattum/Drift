# Tracker VPN fallback

Optional extension of `transmission-priority.uc`. Install
`transmission-trackers.uc` next to that helper and install `ucode-mod-socket`.
The existing yield service calls the helper; no extra daemon or exposed root API
is required. The UI uses Transmission's authenticated RPC and a one-shot
`router:tracker-vpn-retry` label. Ordinary labels are preserved.

The retry icon appears only when a fresh router capability reports a compatible
VPN WAN and a torrent has failed UDP trackers. On request, the controller:

1. Snapshots only UDP trackers whose previous announcement failed.
2. Installs temporary discovery routes, consumes the request label, and asks
   Transmission to reannounce. Transmission's RPC reannounce operates on a
   torrent, so directly working trackers may also announce, using their existing
   direct routes.
3. Checks subsequent tracker timestamps and outcomes. Only successful VPN
   announcements become remembered routes. Failures and attempts still pending
   after 90 seconds lose their temporary VPN routes.

Remembered routes are stored atomically on the SSD at
`/home/.transmission-priority/tracker-vpn.json`. Removed trackers/torrents are
pruned. A later failed VPN announcement removes its remembered route. The
browser shows a small VPN indicator for remembered successes. No torrent data,
files, connection limits or download state are changed.

Routing follows the existing `/var/run/awg-policy.json` selected tunnel. Without
that optional controller, an active default-route WireGuard/AmneziaWG interface
is selected by metric. A configured tunnel with no healthy winner remains
unavailable. Other VPN types are not currently advertised.

## Traffic separation

This implementation supports **IPv4 UDP trackers**, not HTTP(S) trackers, DHT,
PEX or IPv6 trackers. Transmission's HTTP proxy also covers web seeds and would
therefore violate discovery-only routing. No proxy or broad process/IP VPN route
is installed.

A dedicated nftables route-output chain matches Transmission's actual process
UID, resolved tracker IP/port tuples, and BEP15 connect/announce/scrape packet
fields. Announcements also require Transmission's peer ID prefix. TCP traffic
is never selected. Non-tracker UDP sharing a tracker endpoint explicitly uses
the main routing table to avoid inheriting a tracker connection's mwan3 mark.
Tracker URLs and tiers remain intact. Tracker endpoints shared between torrents
share their UDP discovery route, since UDP tracker connection handshakes contain
no torrent identifier.

The extension owns nft table `inet drift_trackers`, route table `31200`, rule
priorities `1391`/`1392`, and packet bits `0x01000000`/`0x02000000`. These are
outside this router's mwan3 and Tailscale masks. Rule-priority collisions fail
rather than replacing an existing rule. Existing VPN-zone masquerading must be
configured. A permanent unreachable fallback prevents selected tracker packets
from falling through to another route if the tunnel disappears. No firewall
reload or global multi-WAN policy changes are made.

DNS is refreshed every minute. Private/loopback destinations are excluded.
Rules are reconciled atomically and restored after firewall reloads. Inspect
`web/full-speed.json` (`trackerVpn`), the SSD state file, nft counters and
connection tracking to distinguish pending attempts, remembered successes and
actual packet routing. The capability contains no credentials.

## Live validation

On the target OpenWrt router, a BEP15 handshake to `tracker.opentrackr.org`
failed directly and succeeded through the existing selected AmneziaWG tunnel.
The retry pipeline subsequently recorded a successful announcement for
`udp://tracker.opentrackr.org:1337`; failed VPN attempts such as Coppersurfer were
removed rather than remembered. Connection tracking showed that tracker flow's
reply destination using the VPN address, while an active peer flow retained the
ordinary WAN address. No torrents were paused or resumed for these checks.
