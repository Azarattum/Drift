// UDP tracker discovery only. Never route by tracker IP alone: peers can share it.
import * as fs from 'fs';
import * as socket from 'socket';

const LABEL = 'router:tracker-vpn-retry';
const STATE = '/home/.transmission-priority/tracker-vpn.json';
const MARK = '0x1000000'; // Outside mwan3 and Tailscale mark masks.
function quote(s) { return "'" + replace('' + s, /'/g, "'\\''") + "'"; }
function run(cmd) {
    let p = fs.popen(cmd, 'r');
    if (!p) die('Cannot start tracker routing command');
    let out = p.read('all');
    if (p.close() != 0) die('Tracker routing command failed');
    return out;
}
function readJSON(path, fallback) {
    try { return json(fs.readfile(path) || 'null') || fallback; } catch (e) { return fallback; }
}

export function reconcile(torrents, rpc) {
    let interfaces = json(run('ubus call network.interface dump')).interface || [];
    let candidates = filter(interfaces, (i) =>
        (i.proto == 'amneziawg' || i.proto == 'wireguard') &&
        length(filter([...(i.route || []), ...(i.inactive?.route || [])], (r) => r.target == '0.0.0.0' && r.mask == 0)) > 0);
    let policy = readJSON('/var/run/awg-policy.json', {});
    // Honor the existing auto-VPN winner. Do not independently choose a tunnel
    // when that controller deliberately reports no healthy candidate.
    let selected = null;
    for (let iface in candidates)
        if (iface.up && (!fs.stat('/var/run/awg-policy.json') || iface.interface == policy.selected)) {
            if (!selected || iface.metric < selected.metric) selected = iface;
        }
    let dev = selected?.l3_device;
    if (dev && !match(dev, /^[a-zA-Z0-9_.-]+$/)) die('Invalid VPN device');
    let state = readJSON(STATE, { torrents: {} });
    let before = sprintf('%J', state);
    let retrying = [], remembered = {}, requested = [];
    for (let t in torrents) {
        let entry = state.torrents[t.hashString] || { routes: {}, pending: {} };
        state.torrents[t.hashString] = entry;
        let trigger = index(t.labels || [], LABEL) >= 0;
        for (let tracker in t.trackerStats || []) {
            let url = tracker.announce;
            if (!match(url, /^udp:\/\//)) continue;
            let pending = entry.pending[url];
            if (pending && tracker.lastAnnounceTime > pending.baseline && tracker.lastAnnounceTime >= pending.started) {
                if (tracker.lastAnnounceSucceeded) entry.routes[url] = { at: tracker.lastAnnounceTime };
                delete entry.pending[url];
            } else if (pending && time() - pending.started > 90) {
                delete entry.pending[url];
            }
            if (entry.routes[url] && !tracker.lastAnnounceSucceeded && tracker.lastAnnounceTime > entry.routes[url].at)
                delete entry.routes[url];
            if (trigger && dev && tracker.lastAnnounceTime > 0 && !tracker.lastAnnounceSucceeded && !entry.pending[url])
                entry.pending[url] = { baseline: tracker.lastAnnounceTime, started: time() };
        }
        // Remove endpoints when the user removes a tracker from the torrent.
        let urls = map(t.trackerStats || [], (tracker) => tracker.announce);
        for (let url in keys(entry.routes)) if (index(urls, url) < 0) delete entry.routes[url];
        for (let url in keys(entry.pending)) if (index(urls, url) < 0) delete entry.pending[url];
        remembered[t.hashString] = keys(entry.routes);
        if (length(keys(entry.pending))) push(retrying, t.hashString);
        push(requested, { hashString: t.hashString, trackerStats: filter(t.trackerStats || [], (tracker) =>
            entry.routes[tracker.announce] || entry.pending[tracker.announce]) });
    }
    for (let hash in keys(state.torrents))
        if (!length(filter(torrents, (t) => t.hashString == hash))) delete state.torrents[hash];
    // Persist pending attempts before acknowledging a one-shot browser request.
    let content = sprintf('%J', state);
    if (content != before) {
        if (!fs.writefile(STATE + '.tmp', content)) die('Cannot save tracker VPN state');
        fs.chmod(STATE + '.tmp', 0600);
        if (!fs.rename(STATE + '.tmp', STATE)) die('Cannot commit tracker VPN state');
    }
    let cache = readJSON('/tmp/transmission-tracker-dns.json', {});
    let endpoints = {};
    for (let t in requested) for (let tracker in t.trackerStats || []) {
        let m = match(tracker.announce, /^udp:\/\/([a-zA-Z0-9.-]+):([0-9]+)(\/|$)/);
        if (!m || int(m[2]) < 1 || int(m[2]) > 65535) continue;
        let host = m[1], port = int(m[2]);
        if (!cache[host] || time() - cache[host].at > 60) {
            let addresses = socket.addrinfo(host, port, { family: socket.AF_INET, socktype: socket.SOCK_DGRAM }) || [];
            cache[host] = { at: time(), addresses: map(addresses, (a) => a.addr?.address || a.address) };
        }
        for (let address in cache[host].addresses)
            if (type(address) == 'string' && match(address, /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/) &&
                !match(address, /^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|22[4-9]\.|23[0-9]\.|24[0-9]\.|25[0-5]\.)/))
                endpoints[address + ' . ' + port] = true;
    }
    fs.writefile('/tmp/transmission-tracker-dns.json', sprintf('%J', cache));
    let pid = trim(run('pidof transmission-daemon'));
    if (!match(pid, /^[0-9]+$/)) die('Cannot identify Transmission process');
    let uid = fs.stat('/proc/' + pid)?.uid;
    if (uid == null) die('Cannot identify Transmission UID');
    let elements = join(', ', sort(keys(endpoints)));
    let previous = readJSON('/tmp/transmission-trackers.plan', {});
    let plan = sprintf('%J', { version: 3, elements, dev: dev || '', uid });
    // Recreate after fw4 reload or reboot; batch rules atomically.
    let exists = system('nft list table inet drift_trackers >/dev/null 2>&1') == 0;
    if (plan != fs.readfile('/tmp/transmission-trackers.plan') || !exists) {
        if (dev) run('ip route replace table 31200 default dev ' + quote(dev) + ' metric 10');
        else system('ip route del table 31200 default metric 10 >/dev/null 2>&1');
        run('ip route replace unreachable default table 31200 metric 32767');
        let rules = run('ip rule show');
        if (index(rules, '1391:') < 0)
            run('ip rule add priority 1391 fwmark ' + MARK + '/' + MARK + ' lookup 31200');
        else if (!match(rules, /1391:[^\n]*fwmark 0x1000000\/0x1000000 lookup 31200/))
            die('Tracker routing rule priority already in use');
        if (index(rules, '1392:') < 0)
            run('ip rule add priority 1392 fwmark 0x2000000/0x2000000 lookup main');
        else if (!match(rules, /1392:[^\n]*fwmark 0x2000000\/0x2000000 lookup main/))
            die('Tracker direct routing priority already in use');
        let nft = 'add table inet drift_trackers\nflush table inet drift_trackers\n' +
            'add set inet drift_trackers endpoints { type ipv4_addr . inet_service; }\nflush set inet drift_trackers endpoints\n';
        if (length(elements)) nft += 'add element inet drift_trackers endpoints { ' + elements + ' }\n';
        nft += 'add chain inet drift_trackers output { type route hook output priority -140; policy accept; }\n';
        let prefix = 'add rule inet drift_trackers output meta skuid ' + uid +
            ' meta l4proto udp ip daddr . udp dport @endpoints ';
        let mark = ' counter meta mark set meta mark | ' + MARK + ' return\n';
        // Offsets include the eight-byte UDP header. BEP15 connect, announce, scrape.
        nft += prefix + 'udp length 24 @th,64,64 0x0000041727101980 @th,128,32 0' + mark;
        nft += prefix + 'udp length >= 106 @th,128,32 1 @th,352,24 0x2d5452' + mark;
        nft += prefix + 'udp length >= 44 @th,128,32 2' + mark;
        // A peer sharing a tracker endpoint must not inherit mwan3's tracker
        // connection mark. Non-BEP15 traffic at that endpoint explicitly uses WAN.
        nft += prefix + 'meta mark set meta mark | 0x2000000\n';
        if (!fs.writefile('/tmp/transmission-trackers.nft', nft)) die('Cannot stage tracker rules');
        run('nft -c -f /tmp/transmission-trackers.nft');
        run('nft -f /tmp/transmission-trackers.nft');
        fs.writefile('/tmp/transmission-trackers.plan', plan);
        // Old NAT bindings belong to the previous route. Only reset known tracker
        // UDP tuples from Transmission's shared UDP socket; never reset peers.
        let port = trim(run('uci -q get transmission.@transmission[0].peer_port || true'));
        if (match(port, /^[0-9]+$/)) for (let endpoint in split(join(', ', [previous.elements || '', elements]), ', ')) {
            if (!match(endpoint, /^[0-9.]+ \. [0-9]+$/)) continue;
            let parts = split(endpoint, ' . ');
            system('conntrack -D -p udp --orig-port-src ' + port + ' --orig-dst ' + quote(parts[0]) +
                ' --orig-port-dst ' + parts[1] + ' >/dev/null 2>&1');
        }
    }
    // Rules must be installed before reannouncing. Re-read labels so concurrent
    // edits or Full speed requests are preserved when consuming this request.
    for (let t in torrents) if (index(t.labels || [], LABEL) >= 0) {
        let current = rpc('torrent-get', { ids: [t.id], fields: ['id', 'labels'] }).torrents[0];
        if (current) rpc('torrent-set', { ids: [t.id], labels: filter(current.labels || [], (l) => l != LABEL) });
        if (dev && index(retrying, t.hashString) >= 0) rpc('torrent-reannounce', { ids: [t.id] });
    }
    return { retrying, routes: remembered, enabled: length(candidates) > 0, available: !!dev, interface: selected?.interface || null,
        label: LABEL, heartbeat: time(), active: dev ? map(filter(requested, (t) => length(t.trackerStats)), (t) => t.hashString) : [],
        scope: 'udp-ipv4', endpoints: length(keys(endpoints)) };
};
