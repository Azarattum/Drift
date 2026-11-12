// Tests an isolated second Transmission instance; never changes the user's service/torrents.
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

const [host, portText = '19091', playerFlag] = Bun.argv.slice(2);
if (!host || !/^[a-zA-Z0-9_.@:-]+$/.test(host) || (playerFlag && playerFlag !== '--player'))
  throw new Error('Usage: bun benchmark.ts user@router [unused RPC port] [--player]');
const port = Number(portText);
if (!Number.isInteger(port) || port < 1024 || port >= 65535) throw new Error('Invalid port');
const address = host.split('@').at(-1)!;
const url = `http://${address}:${port}`;
const root = dirname(import.meta.path);
const binary = Bun.file(join(root, 'dist/drift-stream'));
if (!(await binary.exists())) throw new Error('Run tasks.ts build first');
const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
async function ssh(command: string, input?: Uint8Array) {
  const p = Bun.spawn(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', host, command], {
    stdin: input ? 'pipe' : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (input && p.stdin) {
    p.stdin.write(input);
    p.stdin.end();
  }
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code) throw new Error(`Router command failed: ${err.trim()}`);
  return out.trim();
}
let token = '';
async function rpc(method: string, args: Record<string, unknown> = {}) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`${url}/transmission/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-transmission-session-id': token },
      body: JSON.stringify({ method, arguments: args }),
      signal: AbortSignal.timeout(5000),
    });
    if (r.status === 409) {
      token = r.headers.get('x-transmission-session-id') ?? '';
      continue;
    }
    if (!r.ok) throw new Error(`Fixture RPC HTTP ${r.status}`);
    const value = (await r.json()) as { result: string; arguments: any };
    if (value.result !== 'success') throw new Error(`Fixture RPC ${value.result}`);
    return value.arguments;
  }
  throw new Error('Fixture RPC negotiation failed');
}
function bencode(value: string | number | Uint8Array | Record<string, unknown>): Buffer {
  if (typeof value === 'number') return Buffer.from(`i${value}e`);
  if (typeof value === 'string') value = Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.concat([Buffer.from(`${value.length}:`), value]);
  return Buffer.concat([
    Buffer.from('d'),
    ...Object.keys(value)
      .sort()
      .flatMap((k) => [bencode(k), bencode(value[k] as Parameters<typeof bencode>[0])]),
    Buffer.from('e'),
  ]);
}
const local = await mkdtemp(join(tmpdir(), 'drift-stream-'));
const remote = `/tmp/drift-stream-${randomUUID()}`;
// The media fixture lives on the SSD, never in router RAM/flash.
let dataDir = '';
let daemonPid = '';
let streamPid = '';
let playerResult: { playback: boolean; resume: boolean } | undefined;
const serviceName = 'drift-stream-benchmark';
const servicePath = `${remote}/${serviceName}`;
try {
  const source = join(local, 'video.mp4');
  const ffmpeg = Bun.spawn(
    [
      'ffmpeg',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=30',
      '-t',
      '30',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '12',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      source,
    ],
    { stdout: 'ignore', stderr: 'inherit' },
  );
  if (await ffmpeg.exited) throw new Error('Local fixture generation failed');
  const data = Buffer.from(await Bun.file(source).arrayBuffer());
  const pieceSize = 256 * 1024;
  const pieces: Buffer[] = [];
  for (let i = 0; i < data.length; i += pieceSize)
    pieces.push(
      createHash('sha1')
        .update(data.subarray(i, i + pieceSize))
        .digest(),
    );
  const info = {
    name: 'video.mp4',
    length: data.length,
    'piece length': pieceSize,
    pieces: Buffer.concat(pieces),
    private: 1,
  };
  const metainfo = bencode({ info });
  const hash = createHash('sha1').update(bencode(info)).digest('hex');
  dataDir = await ssh(
    `base="$(uci -q get transmission.@transmission[0].download_dir)"; test -d "$base" && mktemp -d "$base/.drift-benchmark.XXXXXX"`,
  );
  await ssh(`mkdir -m 700 ${q(remote)} ${q(remote + '/config')}`);
  await ssh(
    `cat > ${q(remote + '/drift-stream')} && chmod 755 ${q(remote + '/drift-stream')}`,
    new Uint8Array(await binary.arrayBuffer()),
  );
  await ssh(`cat > ${q(dataDir + '/video.mp4')}`, data);
  const client = await ssh('set -- $SSH_CONNECTION; printf "%s" "$1"');
  const web = dataDir + '/web';
  if (playerFlag === '--player') {
    const bundle = join(root, '../../../dist');
    if (!(await Bun.file(join(bundle, 'index.html')).exists()))
      throw new Error('Build the frontend first');
    await ssh(`mkdir -p ${q(web)}`);
    const archive = Bun.spawn(['tar', '-C', bundle, '-cf', '-', '.'], {
      stdout: 'pipe',
      stderr: 'inherit',
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    const upload = Bun.spawn(['ssh', '-o', 'BatchMode=yes', host, `tar -xf - -C ${q(web)}`], {
      stdin: archive.stdout,
      stdout: 'ignore',
      stderr: 'inherit',
    });
    if ((await upload.exited) || (await archive.exited))
      throw new Error('Cannot stage frontend bundle');
  }
  const settings = {
    'download-dir': dataDir,
    'rpc-enabled': true,
    'rpc-bind-address': '0.0.0.0',
    'rpc-port': port,
    'rpc-authentication-required': false,
    'rpc-whitelist-enabled': true,
    'rpc-whitelist': `127.0.0.1,${client}`,
    'rpc-host-whitelist-enabled': false,
    'rpc-host-whitelist': address,
    'dht-enabled': false,
    'pex-enabled': false,
    'lpd-enabled': false,
    'port-forwarding-enabled': false,
    'peer-port': port + 2,
    'peer-limit-global': 1,
    'message-level': 1,
    'start-added-torrents': false,
  };
  await ssh(`cat > ${q(remote + '/config/settings.json')}`, Buffer.from(JSON.stringify(settings)));
  daemonPid = await ssh(
    `trap '' HUP; transmission-daemon -f -g ${q(remote + '/config')} >${q(remote + '/transmission.log')} 2>&1 < /dev/null & echo $!`,
  );
  for (let i = 0; ; i++) {
    try {
      await rpc('session-get');
      break;
    } catch (e) {
      if (i >= 30) throw e;
      await Bun.sleep(100);
    }
  }
  await rpc('torrent-add', { metainfo: metainfo.toString('base64'), paused: true });
  await rpc('torrent-verify', { ids: [hash] });
  for (let i = 0; ; i++) {
    const t = (await rpc('torrent-get', { ids: [hash], fields: ['percentDone', 'status'] }))
      .torrents[0];
    if (t.percentDone === 1 && t.status !== 1 && t.status !== 2) break;
    if (i >= 100) throw new Error('Fixture verification timed out');
    await Bun.sleep(100);
  }
  if (!/^\d+$/.test(daemonPid)) throw new Error('Invalid fixture PID');
  await ssh(`kill -TERM ${daemonPid}`);
  for (let i = 0; i < 50; i++) {
    if (
      !(
        await ssh(
          `test -r /proc/${daemonPid}/stat && awk '{print $3}' /proc/${daemonPid}/stat || true`,
        )
      ).match(/^[RSID]$/)
    )
      break;
    await Bun.sleep(100);
  }
  const hook = (await Bun.file(join(root, 'dist/drift-stream.procd')).text()).replace(
    '/usr/bin/drift-stream',
    remote + '/drift-stream',
  );
  await ssh(`cat > ${q(remote + '/hook')}`, Buffer.from(hook));
  const init = `#!/bin/sh /etc/rc.common
USE_PROCD=1
start_service() {
    local cfg=fixture config_dir=${q(remote + '/config')} user=root group=root
    procd_open_instance transmission
    procd_set_param command /usr/bin/transmission-daemon -f -g "$config_dir"
    procd_set_param respawn 3600 1 5
    procd_set_param env TRANSMISSION_WEB_HOME=${q(dataDir + '/web')}
    procd_close_instance
    . ${q(remote + '/hook')}
}
`;
  await ssh(`cat > ${q(servicePath)} && chmod 755 ${q(servicePath)}`, Buffer.from(init));
  await ssh(`${q(servicePath)} start`);
  const servicePids = async () => {
    const listing = JSON.parse(
      await ssh(`ubus call service list ${q(JSON.stringify({ name: serviceName }))}`),
    );
    const instances = listing[serviceName]?.instances;
    return {
      stream: String(instances?.['drift-stream-fixture']?.pid ?? ''),
      transmission: String(instances?.transmission?.pid ?? ''),
    };
  };
  const initialPids = await servicePids();
  streamPid = initialPids.stream;
  daemonPid = initialPids.transmission;
  if (!/^\d+$/.test(streamPid) || !/^\d+$/.test(daemonPid))
    throw new Error('procd did not launch both instances');
  const streamUrl = `http://${address}:${port + 1}/v1/media/${hash}/0`;
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(streamUrl, { method: 'HEAD' });
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    await Bun.sleep(100);
  }
  if (!ready) throw new Error('Companion did not become ready under procd');
  if (playerFlag === '--player') {
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(`${url}/transmission/web/`);
      await page.locator('[data-testid="torrent-row"]').first().click();
      await page.getByRole('button', { name: 'Watch video', exact: true }).click();
      const video = page.locator('.drift-player video');
      await page.waitForFunction(() => {
        const v = document.querySelector('video');
        return v && v.readyState >= 2;
      });
      await video.evaluate(async (v: HTMLVideoElement) => {
        await v.play();
        v.currentTime = 8;
      });
      await page.waitForFunction(() => document.querySelector('video')!.currentTime >= 8);
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
      await page.getByRole('button', { name: 'Close dialog' }).click();
      await page.locator('dialog').waitFor({ state: 'detached' });
      await page.getByRole('button', { name: 'Watch video', exact: true }).click();
      await page.getByRole('button', { name: /Resume from 0:0[89]/ }).click();
      if ((await video.evaluate((v: HTMLVideoElement) => v.currentTime)) < 7)
        throw new Error('Live resume failed');
      playerResult = { playback: true, resume: true };
    } finally {
      await browser.close();
    }
  }
  const stats = async () => {
    const result = await ssh(
      `test -r /proc/${streamPid}/stat || exit 1; awk '{print $14+$15}' /proc/${streamPid}/stat; awk '/^cpu / {s=0;for(i=2;i<=9;i++)s+=$i;print s}' /proc/stat; awk '/^VmRSS:|^VmHWM:|^Threads:|^voluntary_ctxt_switches:|^nonvoluntary_ctxt_switches:/ {print $1,$2}' /proc/${streamPid}/status; if test -r /proc/${streamPid}/wchan; then cat /proc/${streamPid}/wchan; echo; fi; if test -r /proc/${streamPid}/schedstat; then cat /proc/${streamPid}/schedstat; fi; true`,
    );
    const lines = result.split('\n');
    return { ticks: Number(lines[0]), totalTicks: Number(lines[1]), detail: lines.slice(2) };
  };
  await Bun.sleep(1500); // Allow disk-worker retirement, then measure a genuinely idle process.
  const idleStart = await stats();
  await Bun.sleep(10000);
  const idleEnd = await stats();
  const expected = createHash('sha256').update(data).digest('hex');
  const trials = [];
  for (const concurrency of [1, 4]) {
    const before = await stats();
    const start = performance.now();
    const rounds = 8;
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        for (let i = 0; i < rounds; i++) {
          const r = await fetch(streamUrl, { signal: AbortSignal.timeout(30000) });
          if (!r.ok) throw new Error(`Stream HTTP ${r.status}`);
          const received = Buffer.from(await r.arrayBuffer());
          if (createHash('sha256').update(received).digest('hex') !== expected)
            throw new Error('Stream bytes differ');
        }
      }),
    );
    const seconds = (performance.now() - start) / 1000;
    const after = await stats();
    trials.push({
      concurrency,
      bytes: data.length * concurrency * rounds,
      seconds,
      mibPerSecond: (data.length * concurrency * rounds) / seconds / 1048576,
      cpuTicks: after.ticks - before.ticks,
      machineTicks: after.totalTicks - before.totalTicks,
      after,
    });
  }
  const pacedStart = await stats();
  const pacedTime = performance.now();
  const paced = await fetch(streamUrl);
  const reader = paced.body!.getReader();
  const digest = createHash('sha256');
  let pacedBytes = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    digest.update(value);
    pacedBytes += value.length;
    const delay = (pacedBytes / 2_500_000) * 1000 - (performance.now() - pacedTime);
    if (delay > 0) await Bun.sleep(delay);
  }
  if (digest.digest('hex') !== expected) throw new Error('Paced stream bytes differ');
  const pacedEnd = await stats();
  const pacedResult = {
    targetBitsPerSecond: 20_000_000,
    bytes: pacedBytes,
    seconds: (performance.now() - pacedTime) / 1000,
    cpuTicks: pacedEnd.ticks - pacedStart.ticks,
    machineTicks: pacedEnd.totalTicks - pacedStart.totalTicks,
  };
  const range = await fetch(streamUrl, { headers: { range: 'bytes=17-1023' } });
  if (
    range.status !== 206 ||
    !Buffer.from(await range.arrayBuffer()).equals(data.subarray(17, 1024))
  )
    throw new Error('Range check failed');
  const requests = await Promise.all(
    ['/etc/passwd', `/v1/media/${hash}/0?path=/etc/passwd`, `/v1/media/${hash}/999`].map(
      async (path) => (await fetch(`http://${address}:${port + 1}${path}`)).status,
    ),
  );
  // Real Transmission bitfield + sparse .part file: a missing range must never become zero bytes.
  await rpc('torrent-remove', { ids: [hash], 'delete-local-data': false });
  await ssh(`mv ${q(dataDir + '/video.mp4')} ${q(dataDir + '/fixture.backup')}`);
  await ssh(`cat > ${q(dataDir + '/video.mp4.part')}`, data.subarray(0, pieceSize));
  await ssh(
    `dd if=/dev/zero of=${q(dataDir + '/video.mp4.part')} bs=1 count=1 seek=${data.length - 1} conv=notrunc 2>/dev/null`,
  );
  await rpc('torrent-add', { metainfo: metainfo.toString('base64'), paused: true });
  await rpc('torrent-verify', { ids: [hash] });
  for (let i = 0; ; i++) {
    const t = (await rpc('torrent-get', { ids: [hash], fields: ['status', 'percentDone'] }))
      .torrents[0];
    if (t.status === 0 && t.percentDone > 0 && t.percentDone < 1) break;
    if (i >= 100) throw new Error('Sparse fixture verification failed');
    await Bun.sleep(100);
  }
  await rpc('torrent-set', { ids: [hash], sequential_download: true });
  const prefix = await fetch(streamUrl, { headers: { range: 'bytes=0-127' } });
  if (
    prefix.status !== 206 ||
    !Buffer.from(await prefix.arrayBuffer()).equals(data.subarray(0, 128))
  )
    throw new Error('Verified .part prefix differs');
  const cancel = new AbortController();
  const hole = fetch(streamUrl, {
    headers: { range: `bytes=${pieceSize}-${pieceSize + 15}` },
    signal: cancel.signal,
  }).then(async (r) => {
    const first = await r.body!.getReader().read();
    if (first.value?.length) throw new Error('Unverified sparse bytes were sent');
    return 'ended';
  });
  const holeResult = await Promise.race([hole, Bun.sleep(1200).then(() => 'waiting')]);
  cancel.abort();
  await hole.catch(() => {});
  if (holeResult !== 'waiting') throw new Error('Missing piece did not wait');
  await rpc('torrent-remove', { ids: [hash], 'delete-local-data': false });
  await ssh(
    `rm ${q(dataDir + '/video.mp4.part')}; mv ${q(dataDir + '/fixture.backup')} ${q(dataDir + '/video.mp4')}`,
  );
  await rpc('torrent-add', { metainfo: metainfo.toString('base64'), paused: true });
  await rpc('torrent-verify', { ids: [hash] });
  for (let i = 0; ; i++) {
    const t = (await rpc('torrent-get', { ids: [hash], fields: ['status', 'percentDone'] }))
      .torrents[0];
    if (t.status === 0 && t.percentDone === 1) break;
    if (i >= 100) throw new Error('Restored fixture verification failed');
    await Bun.sleep(100);
  }
  await ssh(`kill -TERM ${daemonPid}`);
  const exitStart = performance.now();
  for (let i = 0; ; i++) {
    const alive = await ssh(
      `test -d /proc/${streamPid} && awk '{print $3}' /proc/${streamPid}/stat || true`,
    );
    if (!alive || alive === 'Z') break;
    if (i >= 30) throw new Error('Companion did not stop with Transmission');
    await Bun.sleep(50);
  }
  const observedExitMs = performance.now() - exitStart;
  // procd respawns both instances after the simulated daemon crash.
  let restarted = false;
  for (let i = 0; i < 60; i++) {
    const pids = await servicePids();
    if (
      pids.stream &&
      pids.transmission &&
      pids.stream !== streamPid &&
      pids.transmission !== daemonPid
    ) {
      streamPid = pids.stream;
      daemonPid = pids.transmission;
      restarted = true;
      break;
    }
    await Bun.sleep(100);
  }
  if (!restarted) throw new Error('procd did not restart both instances');
  let restartReady = false;
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(streamUrl, { method: 'HEAD' })).ok) {
        restartReady = true;
        break;
      }
    } catch {}
    await Bun.sleep(100);
  }
  if (!restartReady) throw new Error('Respawned companion did not serve video');
  await ssh(`${q(servicePath)} stop`);
  await Bun.sleep(1500);
  const stopped = await servicePids();
  if (stopped.stream || stopped.transmission)
    throw new Error('Stopping service left an instance running');
  console.log(
    JSON.stringify(
      {
        productionPlayer: playerResult,
        fixtureBytes: data.length,
        binaryBytes: binary.size,
        idleStart,
        idleEnd,
        idleTicks: idleEnd.ticks - idleStart.ticks,
        trials,
        paced: pacedResult,
        deniedRequests: requests,
        sparsePartWait: holeResult === 'waiting',
        observedExitMs,
        procdRestart: restarted,
        procdStop: !stopped.stream && !stopped.transmission,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    await ssh(
      `cat ${q(remote + '/stream.log')} ${q(remote + '/transmission.log')} 2>/dev/null || true`,
    ).catch(() => 'Logs unavailable'),
  );
  throw error;
} finally {
  await ssh(`test ! -x ${q(servicePath)} || ${q(servicePath)} stop`).catch(() => {});
  if (streamPid && /^\d+$/.test(streamPid))
    await ssh(`kill -TERM ${streamPid} 2>/dev/null || true`).catch(() => {});
  if (daemonPid && /^\d+$/.test(daemonPid))
    await ssh(`kill -TERM ${daemonPid} 2>/dev/null || true`).catch(() => {});
  await ssh(`rm -rf ${q(remote)} ${dataDir ? q(dataDir) : ''}`).catch(() => {});
  await rm(local, { recursive: true, force: true });
}
