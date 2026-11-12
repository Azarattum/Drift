// Production bundle smoke check with the archived WebKit 15.4 engine.
// This is an older WebKit build, not an iOS simulator or physical-device test.
import assert from 'node:assert/strict';
import { resolve, sep } from 'node:path';
import { webkit } from 'playwright-legacy';
import { fixtures } from '../tests/fixtures';

const torrents = fixtures();
const calls: { method: string; arguments: any }[] = [];
const root = resolve('dist');
if (!(await Bun.file(resolve(root, 'index.html')).exists())) throw new Error('Build first');
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.endsWith('/rpc')) {
      if (request.headers.get('X-Transmission-Session-Id') !== 'legacy-test')
        return new Response('', {
          status: 409,
          headers: { 'X-Transmission-Session-Id': 'legacy-test' },
        });
      const body = await request.json();
      calls.push(body);
      const args = body.arguments || {};
      const targets = torrents.filter((t) => !args.ids || args.ids.includes(t.id));
      let result: any = {};
      switch (body.method) {
        case 'torrent-get':
          result = { torrents: targets };
          break;
        case 'session-get':
          result = {
            version: '4.1.3',
            'rpc-version': 19,
            'download-dir': '/data/Downloads',
            'download-dir-free-space': 300000000000,
          };
          break;
        case 'session-stats':
          result = { downloadSpeed: 2400000, uploadSpeed: 640000, torrentCount: torrents.length };
          break;
        case 'torrent-set':
          for (const t of targets) Object.assign(t, args);
          break;
        case 'torrent-stop':
          for (const t of targets) t.status = 0;
          break;
        case 'torrent-start':
        case 'torrent-start-now':
          for (const t of targets) t.status = 4;
          break;
        case 'torrent-add':
          result = { 'torrent-added': { id: 42 } };
          break;
      }
      return Response.json({ result: 'success', arguments: result });
    }
    if (path.endsWith('/full-speed.json'))
      return Response.json({
        version: 1,
        fullSpeed: {
          enabled: true,
          label: 'router:full-speed',
          heartbeat: Date.now() / 1000,
          active: [],
        },
      });
    const file = resolve(root, `.${decodeURIComponent(path === '/' ? '/index.html' : path)}`);
    if (!file.startsWith(root + sep)) return new Response('', { status: 404 });
    const asset = Bun.file(file);
    return (await asset.exists()) ? new Response(asset) : new Response('', { status: 404 });
  },
});

const browser = await webkit.launch({ headless: true });
try {
  assert.equal(await browser.version(), '15.4', 'The legacy check must use WebKit 15.4');
  const page = await browser.newPage({
    viewport: { width: 375, height: 667 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 15_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.4 Mobile/15E148 Safari/604.1',
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    // Some archived builds include features that shipped after the stable iOS release.
    Object.defineProperty(AbortSignal, 'timeout', { value: undefined, configurable: true });
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    document.addEventListener('copy', (e) => {
      e.preventDefault();
      (window as any).__copied = (document.activeElement as HTMLTextAreaElement)?.value;
    });
  });
  await page.goto(server.url.href);
  await page.locator('[data-testid="torrent-row"]').first().waitFor();
  assert.equal(await page.locator('[data-testid="torrent-row"]').count(), 6);
  assert.equal(await page.evaluate(() => typeof AbortSignal.timeout), 'undefined');
  assert.equal(
    await page.evaluate(() => CSS.supports('background', 'color-mix(in srgb,black,white)')),
    false,
  );
  assert.equal(
    await page.evaluate(() => 'inert' in HTMLElement.prototype),
    true,
    'inert polyfill loaded',
  );
  const audit = async () => {
    const small = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>('button,input,select,textarea,[role="button"]'),
      )
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return (
            r.width > 0 &&
            r.height > 0 &&
            r.bottom > 0 &&
            r.top < innerHeight &&
            r.right > 0 &&
            r.left < innerWidth &&
            (r.width < 43.9 || r.height < 43.9)
          );
        })
        .map((el) => el.getAttribute('aria-label') || el.textContent),
    );
    assert.deepEqual(small, [], '44px touch targets');
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      'No horizontal overflow',
    );
  };
  await audit();
  await page.screenshot({ path: 'test-results/ios15.4-transfers.png' });
  await page.locator('.row-menu').first().tap();
  await page.locator('[role="menuitem"]', { hasText: 'Copy info hash' }).click();
  // The iOS touch path may reject execCommand. The selectable-text fallback must work.
  if (await page.evaluate(() => (window as any).__copied?.length !== 40)) {
    await page.locator('dialog[open]').waitFor();
    assert.equal(
      await page.locator('textarea[aria-label="Text to copy"]').inputValue(),
      'a'.repeat(40),
    );
    await page.locator('[aria-label="Close dialog"]').click();
    await page.locator('dialog').waitFor({ state: 'detached' });
  }
  if (!(await page.locator('.inspector').count()))
    await page.locator('[data-testid="torrent-row"]').first().click();
  await page.locator('.inspector').waitFor();
  await page.waitForTimeout(220);
  await page.locator('[role="tab"]').nth(1).click();
  await page.locator('[role="tree"]').waitFor();
  await page.locator('.file-actions').first().click();
  await page.locator('[role=menuitem]', { hasText: 'Rename…' }).click();
  assert.equal(await page.locator('select[aria-label="Download priority"]').inputValue(), '0');
  await page.locator('[aria-label="Close dialog"]').click();
  await page.locator('dialog').waitFor({ state: 'detached' });
  await page.locator('input[aria-label="Download Ubuntu 24.04"]').check();
  await page.waitForFunction(() => document.querySelector('[role="tree"]') !== null);
  assert(
    calls.some((c) => c.method === 'torrent-set' && c.arguments['files-wanted']?.length === 3),
  );
  await audit();
  const dockReachable = await page.locator('.mobile-tabbar').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return !!document.elementFromPoint(r.x + 30, r.y + 30)?.closest('.mobile-dock');
  });
  assert(dockReachable, 'Bottom navigation remains reachable over the inspector');
  await page.screenshot({ path: 'test-results/ios15.4-files.png' });
  await page.locator('[role="tab"]').nth(2).click();
  await page.locator('.peer-view-control button', { hasText: 'Diagram' }).click();
  await page.locator('[aria-label="Inspect peer 192.0.2.1 port 51413"]').click();
  assert((await page.locator('.peer-card').textContent())?.includes('192.0.2.1'));
  await audit();
  await page.locator('[aria-label="Close inspector"]').click();
  await page.locator('.inspector').waitFor({ state: 'detached' });
  for (let n = 0; n < 3; n++) {
    await page.locator('.mobile-add').click();
    await page.locator('dialog[open]').waitFor();
    assert.equal(await page.locator('.app-shell').getAttribute('inert'), '', 'Background isolated');
    await audit();
    await page.locator('[aria-label="Close dialog"]').click();
    await page.locator('dialog').waitFor({ state: 'detached' });
    assert.equal(
      await page.locator('.app-shell').getAttribute('inert'),
      null,
      'Background restored',
    );
  }
  const payload = Buffer.from([0, 255, 127, 1]);
  await page.locator('.mobile-add').tap();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'fixture.torrent',
    mimeType: 'application/x-bittorrent',
    buffer: payload,
  });
  await page.locator('button', { hasText: 'Add transfer' }).click();
  await page.locator('dialog').waitFor({ state: 'detached' });
  assert(
    calls.some(
      (c) => c.method === 'torrent-add' && c.arguments.metainfo === payload.toString('base64'),
    ),
    'Torrent file encoding on older Safari',
  );
  await page.locator('.mobile-tabbar button').nth(1).click();
  await page.locator('.chart-plot svg').first().waitFor();
  await page.waitForTimeout(2300);
  await audit();
  assert((await page.locator('.chart-legend').textContent())?.includes('MB/s'));
  await page.screenshot({ path: 'test-results/ios15.4-activity.png' });
  await page.locator('.mobile-tabbar button').nth(2).click();
  await page.locator('.settings-index button', { hasText: 'Appearance' }).click();
  await page.locator('select[aria-label="Color theme"]').selectOption('dark');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await audit();
  assert.deepEqual(errors, [], 'No browser runtime errors');
  console.log(
    'PASS: WebKit 15.4 production bundle at iPhone 8 size: RPC, graph, files, peers, repeated dialogs, inert isolation, touch targets, and theme',
  );
} finally {
  await browser.close();
  server.stop(true);
}
