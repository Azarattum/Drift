// Opt-in live smoke check. Creates and removes one private, synthetic torrent.
import { chromium } from '@playwright/test';
import { Transmission } from '../src/lib/rpc';

const web = Bun.argv[2];
if (!web) throw new Error('Usage: bun scripts/smoke.ts http://host:9091/transmission/web/');
const rpc = new Transmission(new URL('../rpc', web).href);
const session = await rpc.call('session-get', { fields: ['rpc-version'] });
const sequentialSupported = Number(session['rpc-version']) >= 18;
const capability = await fetch(new URL('full-speed.json', web))
  .then((r) => (r.ok ? r.json() : null))
  .catch(() => null);
if (capability?.fullSpeed?.label) {
  const existing = await rpc.call('torrent-get', { fields: ['labels'] });
  if (
    existing.torrents.some((t: { labels?: string[] }) =>
      t.labels?.includes(capability.fullSpeed.label),
    )
  )
    throw new Error(
      'An existing transfer has Full speed enabled. Disable it before running this smoke check.',
    );
}
const name = `drift-ui-smoke-${crypto.randomUUID()}.txt`;
function encode(value: any): Buffer {
  if (typeof value === 'number') return Buffer.from(`i${value}e`);
  if (typeof value === 'string') value = Buffer.from(value);
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(`${value.length}:`), value]);
  return Buffer.concat([
    Buffer.from('d'),
    ...Object.keys(value)
      .sort()
      .flatMap((key) => [encode(key), encode(value[key])]),
    Buffer.from('e'),
  ]);
}
async function until(predicate: () => Promise<boolean>, message: string) {
  for (let n = 0; n < 60; n++) {
    if (await predicate()) return;
    await Bun.sleep(250);
  }
  throw new Error(message);
}
const original = {
  honorsSessionLimits: true,
  downloadLimited: true,
  downloadLimit: 37,
  uploadLimited: true,
  uploadLimit: 11,
  bandwidthPriority: -1,
  'peer-limit': 7,
};
const metainfo = encode({
  info: {
    name,
    length: 4096,
    'piece length': 16384,
    pieces: new Bun.CryptoHasher('sha1').update('test'.repeat(1024)).digest(),
    private: 1,
  },
});
const result = await rpc.call('torrent-add', {
  metainfo: metainfo.toString('base64'),
  paused: true,
});
const id = result['torrent-added'].id;
const get = async () =>
  (
    await rpc.call('torrent-get', {
      ids: [id],
      fields: [
        'id',
        'name',
        'files',
        'labels',
        'status',
        ...Object.keys(original),
        ...(sequentialSupported ? ['sequential_download'] : []),
      ],
    })
  ).torrents[0];
const browser = await chromium.launch({ headless: true });
try {
  await rpc.call('torrent-set', { ids: [id], ...original });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(web, { waitUntil: 'domcontentloaded' });
  await page.getByRole('textbox', { name: 'Search transfers' }).fill(name);
  const row = page.getByTestId('torrent-row').filter({ hasText: name });
  await row.waitFor();
  await row.click();
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await page.getByRole('tree').waitFor();
  console.log('PASS: deployed bundle connects to the daemon and renders its real file tree');
  await page.getByRole('button', { name: 'Close inspector' }).click();
  await row.hover();
  const boost = page.getByRole('button', { name: `Enable Full speed for ${name}`, exact: true });
  if (await boost.count()) {
    await boost.click();
    await until(async () => (await get()).honorsSessionLimits === false, 'Full speed not applied');
    await until(async () => {
      const r = await page.request.get(new URL('full-speed.json', web).href);
      const c = await r.json();
      return c.fullSpeed.active.length > 0;
    }, 'No controller acknowledgement');
    const on = page.getByRole('button', { name: `Disable Full speed for ${name}`, exact: true });
    await on.waitFor();
    await on.click();
    await until(async () => (await get())['peer-limit'] === 7, 'Prior settings not restored');
    const restored = await get();
    for (const [key, value] of Object.entries(original))
      if (restored[key] !== value) throw new Error(`Restore mismatch: ${key}`);
    console.log(
      'PASS: real Full speed control and controller acknowledgement; previous limits restored',
    );
  } else console.log('INFO: no optional Full speed capability advertised');
  if (sequentialSupported) {
    await row.click();
    await page.getByRole('tab', { name: 'Options', exact: true }).click();
    const sequential = page.getByRole('switch', { name: /Sequential download/ });
    await sequential.check();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await until(
      async () => (await get()).sequential_download === true,
      'Sequential mode not applied',
    );
    await sequential.uncheck();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await until(
      async () => (await get()).sequential_download === false,
      'Normal mode not restored',
    );
    await page.getByRole('button', { name: 'Close inspector' }).click();
    await page.locator('.inspector').waitFor({ state: 'detached' });
    console.log('PASS: real sequential mode can be enabled and disabled through Options');
  }
  if (Number(session['rpc-version']) >= 15) {
    await row.hover();
    await row.getByRole('button', { name: `Actions for ${name}`, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Rename…', exact: true }).click();
    const renamed = name.replace('.txt', '-renamed.txt');
    const dialog = page.getByRole('dialog', { name: 'Rename torrent', exact: true });
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(renamed);
    await dialog.getByRole('button', { name: 'Rename', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    await until(async () => (await get()).name === renamed, 'Torrent name not updated');
    if ((await get()).files[0]?.name !== renamed) throw new Error('Root filename not updated');
    await page.getByRole('textbox', { name: 'Search transfers' }).fill(renamed);
    await page.getByTestId('torrent-row').filter({ hasText: renamed }).waitFor();
    console.log('PASS: real torrent rename updates the torrent name, root path, and displayed row');
  }
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
    throw new Error('Mobile overflow');
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('PASS: mobile viewport and no browser runtime errors');
} finally {
  await rpc.call('torrent-set', { ids: [id], labels: [] });
  await Bun.sleep(2500);
  await rpc.call('torrent-remove', { ids: [id], 'delete-local-data': true });
  await browser.close();
}
