import { expect, type Page, test } from '@playwright/test';
import { fixtures } from '../fixtures';

async function server(page: Page, features: boolean | 'stale' = true) {
  const torrents = fixtures();
  const calls: { method: string; arguments: any }[] = [];
  await page.route('**/full-speed.json*', (route) =>
    route.fulfill({
      json: features
        ? {
            version: 1,
            fullSpeed: {
              enabled: true,
              label: 'router:full-speed',
              heartbeat: Date.now() / 1000 - (features === 'stale' ? 60 : 0),
              active: torrents
                .filter((t) => t.labels.includes('router:full-speed'))
                .map((t) => t.hashString),
            },
          }
        : {},
      status: features ? 200 : 404,
    }),
  );
  await page.route(/\/rpc$/, async (route) => {
    const req = route.request();
    if (req.headers()['x-transmission-session-id'] !== 'test-session') {
      await route.fulfill({
        status: 409,
        headers: { 'X-Transmission-Session-Id': 'test-session' },
      });
      return;
    }
    const body = req.postDataJSON();
    calls.push(body);
    const args = body.arguments || {};
    let result: any = {};
    const targets = torrents.filter((t) => !args.ids || args.ids.includes(t.id));
    switch (body.method) {
      case 'torrent-get':
        result = { torrents: targets };
        break;
      case 'session-stats':
        result = {
          downloadSpeed: 2400000 + (calls.length % 5) * 170000,
          uploadSpeed: 640000,
          torrentCount: torrents.length,
        };
        break;
      case 'session-get':
        result = {
          version: '4.1.3',
          'rpc-version': 19,
          'download-dir': '/data/Downloads',
          'download-dir-free-space': 324000000000,
          'peer-port': 51413,
          'peer-limit-global': 200,
          encryption: 'preferred',
        };
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
      case 'torrent-remove':
        for (const t of targets) torrents.splice(torrents.indexOf(t), 1);
        break;
      case 'torrent-add':
        result = { 'torrent-added': { id: 42 } };
        break;
    }
    await route.fulfill({ json: { result: 'success', arguments: result } });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'All transfers' })).toBeVisible();
  await expect(page.getByTestId('torrent-row')).toHaveCount(6);
  return { torrents, calls };
}

test('stages, compact overview, graph, search, and right-click menu', async ({ page }) => {
  await server(page);
  await expect(page.getByText('Finding peers', { exact: true })).toBeVisible();
  await expect(page.getByText('Checking files', { exact: true })).toBeVisible();
  await expect(page.getByText('Waiting for pieces', { exact: true })).toBeVisible();
  await page.waitForTimeout(2300);
  await page.screenshot({ path: 'test-results/drift-desktop.png', fullPage: true });
  await page.getByTestId('torrent-row').first().click({ button: 'right' });
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Verify local files' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('textbox', { name: 'Search transfers' }).fill('debian');
  await expect(page.getByTestId('torrent-row')).toHaveCount(1);
});
test('file tree checkboxes send the complete folder selection; peers include a real graph', async ({
  page,
}) => {
  const { calls } = await server(page);
  await page.getByTestId('torrent-row').first().click();
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await expect(page.getByRole('tree')).toBeVisible();
  await page.getByRole('checkbox', { name: 'Download Ubuntu 24.04', exact: true }).check();
  await expect
    .poll(() =>
      calls.find((c) => c.method === 'torrent-set' && c.arguments['files-wanted']?.length === 3),
    )
    .toBeTruthy();
  await page.getByRole('tab', { name: /^Peers/ }).click();
  await expect(page.getByRole('img', { name: /8 connected peers/ })).toBeVisible();
  await page.getByRole('button', { name: 'Inspect peer 192.0.2.1', exact: true }).click();
  await expect(page.locator('.peer-card')).toContainText('192.0.2.1');
  await page.screenshot({ path: 'test-results/drift-peers.png', fullPage: true });
});
test('optional full-speed support and real control request', async ({ page }) => {
  const { calls } = await server(page);
  await page.getByTestId('torrent-row').first().hover();
  await page
    .getByRole('button', { name: 'Enable Full speed for Ubuntu 24.04.4 Desktop.iso', exact: true })
    .click();
  await expect
    .poll(() =>
      calls.some(
        (c) => c.method === 'torrent-set' && c.arguments.labels?.includes('router:full-speed'),
      ),
    )
    .toBe(true);
});
test('standard daemons never advertise an unsupported Full speed button', async ({ page }) => {
  await server(page, false);
  await page.getByTestId('torrent-row').first().click();
  await expect(page.locator('.boost-card')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Enable Full speed/ })).toHaveCount(0);
});
test('mobile navigation, inspector, file tree, and modal fit the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await server(page);
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible();
  await page.screenshot({ path: 'test-results/drift-mobile.png', fullPage: true });
  await page.getByTestId('torrent-row').first().click();
  await expect(page.getByRole('complementary', { name: 'Torrent inspector' })).toBeVisible();
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Close inspector' }).click();
  await page.getByRole('button', { name: 'Add torrent', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page
    .getByRole('textbox', { name: 'Magnet link or torrent URL' })
    .fill('magnet:?xt=urn:btih:123');
  await page.screenshot({ path: 'test-results/drift-mobile-add.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('batch delete is conservative and requires explicit data deletion', async ({ page }) => {
  const { calls } = await server(page);
  await page.getByTestId('torrent-row').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Remove…' }).click();
  await expect(
    page.getByRole('checkbox', { name: 'Also delete downloaded files' }),
  ).not.toBeChecked();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect
    .poll(() => calls.find((c) => c.method === 'torrent-remove')?.arguments['delete-local-data'])
    .toBe(false);
});

test('stale controller heartbeats hide Full speed', async ({ page }) => {
  await server(page, 'stale');
  await page.getByTestId('torrent-row').first().click();
  await expect(page.locator('.boost-card')).toHaveCount(0);
});
