// Reconcile the Full speed label with Transmission settings. Runs as root from
// transmission-yield; the browser never gets a privileged endpoint or shell.
import * as fs from 'fs';

const LABEL = 'router:full-speed';
const STATE_DIR = '/home/.transmission-priority';
const STATE_FILE = STATE_DIR + '/state.json';
const SETTINGS = [ 'honorsSessionLimits', 'downloadLimited', 'downloadLimit',
    'uploadLimited', 'uploadLimit', 'bandwidthPriority', 'peer-limit' ];
let token = '';

if (index(fs.readfile('/proc/mounts') || '', ' /home ') < 0)
    die('SSD is not mounted; refusing to save state on router flash');

function shellquote(value) {
    return "'" + replace('' + value, /'/g, "'\\''") + "'";
}

function command(cmd) {
    let pipe = fs.popen(cmd, 'r');
    if (!pipe) die('Cannot start command');
    let output = pipe.read('all');
    let status = pipe.close();
    if (status != 0) die('Command failed: ' + status);
    return output;
}

let rpcHost = trim(command('uci -q get transmission.@transmission[0].rpc_bind_address || true'));
if (!rpcHost || rpcHost == '0.0.0.0') rpcHost = '127.0.0.1';
let rpcPort = trim(command('uci -q get transmission.@transmission[0].rpc_port || true')) || '9091';
const RPC_URL = getenv('DRIFT_RPC_URL') || ('http://' + rpcHost + ':' + rpcPort + '/transmission/rpc');

function rpc(method, arguments) {
    for (let attempt = 0; attempt < 2; attempt++) {
        let response = command('curl --silent --show-error --max-time 4 -D - ' +
            '-H ' + shellquote('X-Transmission-Session-Id: ' + token) +
            ' -H ' + shellquote('Content-Type: application/json') +
            ' --data-binary ' + shellquote(sprintf('%J', {
                method: method, arguments: arguments || {}
            })) + ' ' + shellquote(RPC_URL));
        if (match(response, /^HTTP\/[^ ]+ 409/)) {
            let header = match(response, /[Xx]-[Tt]ransmission-[Ss]ession-[Ii]d: ([^\r\n]+)/);
            if (!header) die('Missing RPC session token');
            token = header[1];
            continue;
        }
        let separator = index(response, '\r\n\r\n');
        if (separator < 0) die('Invalid RPC HTTP response');
        let result = json(substr(response, separator + 4));
        if (result.result != 'success') die('RPC failed: ' + result.result);
        return result.arguments || {};
    }
    die('RPC session negotiation failed');
}

function log(message) {
    system('logger -t transmission-priority ' + shellquote(message));
}

function setNice(nice) {
    let pid = trim(command('pidof transmission-daemon'));
    if (!match(pid, /^[0-9]+$/)) return;
    let stat = fs.readfile('/proc/' + pid + '/stat');
    let fields = split(substr(stat, index(stat, ') ') + 2), ' ');
    if (int(fields[16]) != nice)
        command('snice ' + (nice >= 0 ? '+' : '') + nice + ' -p ' + pid);
}

let previous = fs.readfile(STATE_FILE);
let state = previous ? json(previous) : { version: 1, torrents: {}, session: null };
if (state.version != 1 || type(state.torrents) != 'object')
    die('Invalid saved priority settings; refusing to overwrite them');

function save() {
    let content = sprintf('%J\n', state);
    if (content == previous) return;
    if (!fs.stat(STATE_DIR) && !fs.mkdir(STATE_DIR, 0700))
        die('Cannot create priority state directory on SSD');
    // Persist the original settings BEFORE changing the daemon.
    if (!fs.writefile(STATE_FILE + '.tmp', content)) die('Cannot save priority settings');
    fs.chmod(STATE_FILE + '.tmp', 0600);
    if (!fs.rename(STATE_FILE + '.tmp', STATE_FILE)) die('Cannot commit priority settings');
    previous = content;
}

let fields = [ 'id', 'hashString', 'labels', 'status', 'percentDone', 'error',
    'metadataPercentComplete', ...SETTINGS ];
let torrents = rpc('torrent-get', { fields: fields }).torrents;
let current = {};
for (let torrent in torrents) current[torrent.hashString] = torrent;

// Restore an override when the user clears it, pauses, completes, or removes it.
for (let hash, saved in state.torrents) {
    let torrent = current[hash];
    let requested = torrent && index(torrent.labels || [], LABEL) >= 0;
    let finished = torrent && torrent.metadataPercentComplete == 1 && torrent.percentDone >= 1;
    if (torrent && requested && !finished && torrent.status != 0 && !torrent.error)
        continue;
    if (torrent) {
        let restore = { ids: [ torrent.id ], ...saved.settings,
            labels: filter(torrent.labels || [], label => label != LABEL) };
        rpc('torrent-set', restore);
        // Clear force-start's queue bypass while preserving a deliberate pause.
        if (torrent.status == 3 || torrent.status == 4) {
            rpc('torrent-stop', { ids: [ torrent.id ] });
            rpc('torrent-start', { ids: [ torrent.id ] });
        }
        torrent.labels = restore.labels;
    }
    delete state.torrents[hash];
    save();
    log('Restored automatic limits for ' + hash);
}

for (let torrent in torrents) {
    if (index(torrent.labels || [], LABEL) < 0) continue;
    let finished = torrent.metadataPercentComplete == 1 && torrent.percentDone >= 1;
    if (finished || torrent.error) {
        rpc('torrent-set', { ids: [ torrent.id ],
            labels: filter(torrent.labels || [], label => label != LABEL) });
        continue;
    }
    let fresh = !state.torrents[torrent.hashString];
    if (fresh) {
        let settings = {};
        for (let key in SETTINGS) settings[key] = torrent[key];
        state.torrents[torrent.hashString] = { settings: settings };
        if (!state.session) {
            let session = rpc('session-get', {});
            state.session = { 'peer-limit-global': session['peer-limit-global'] };
        }
        save();
    }
    // Per-torrent bypass works even while the governor caps other downloads.
    let settings = { honorsSessionLimits: false, downloadLimited: false,
        uploadLimited: false, bandwidthPriority: 1, 'peer-limit': 200 };
    let changed = fresh;
    for (let key, value in settings) if (torrent[key] != value) changed = true;
    if (changed) rpc('torrent-set', { ids: [ torrent.id ], ...settings });
    if (fresh || torrent.status == 3)
        rpc('torrent-start-now', { ids: [ torrent.id ] });
    if (fresh) log('Full speed enabled for ' + torrent.hashString);
}

let active = length(keys(state.torrents));
if (active) {
    let session = rpc('session-get', {});
    let peers = max(200, state.session['peer-limit-global']);
    if (session['peer-limit-global'] != peers)
        rpc('session-set', { 'peer-limit-global': peers });
    setNice(0);
} else if (state.session) {
    rpc('session-set', state.session);
    setNice(19);
    state.session = null;
    save();
} else {
    // Recover scheduling priority after a daemon restart or interrupted restore.
    setNice(19);
}
fs.writefile('/var/run/transmission-priority.status', sprintf('%J\n', {
    active: active, hashes: keys(state.torrents)
}));
print(active, '\n');

// Capability discovery is separate from the standard Transmission API.
// Publish atomically; browsers ignore stale heartbeats if the controller stops.
let web = trim(command('uci -q get transmission.@transmission[0].web_home'));
if (web && fs.stat(web)) {
    let file = web + '/full-speed.json';
    let capabilities = { version: 1, fullSpeed: {
        enabled: true, label: LABEL, heartbeat: time(), active: keys(state.torrents)
    } };
    if (fs.writefile(file + '.tmp', sprintf('%J\n', capabilities))) {
        fs.chmod(file + '.tmp', 0644);
        fs.rename(file + '.tmp', file);
    }
}
