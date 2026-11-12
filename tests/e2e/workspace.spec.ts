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
  await expect(page.getByRole('combobox', { name: /^Priority for / }).first()).toHaveValue('0');
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
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button'),
  ).toHaveCount(3);
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

test('dark theme, reduced motion, and batch selection work together', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await server(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByTestId('torrent-row').first().click();
  await page
    .getByTestId('torrent-row')
    .nth(2)
    .click({ modifiers: ['Shift'] });
  await expect(page.getByText('3 selected', { exact: true })).toBeVisible();
  await page.getByTestId('torrent-row').nth(2).click({ button: 'right' });
  await expect(page.locator('.menu-caption')).toContainText('3 transfers');
  await page.screenshot({ path: 'test-results/drift-dark.png', fullPage: true });
});

test('a connection failure keeps existing data visible and explains its freshness', async ({
  page,
}) => {
  await server(page);
  await page.route(/\/rpc$/, (route) => route.abort());
  await expect(page.getByRole('alert')).toContainText('Showing last received data', {
    timeout: 15000,
  });
  await expect(page.getByTestId('torrent-row')).toHaveCount(6);
});

test('clipboard copying works over HTTP without the secure clipboard API', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    (window as any).__copies = [];
    document.addEventListener('copy', (e) => {
      e.preventDefault();
      (window as any).__copies.push(
        (document.activeElement as HTMLTextAreaElement)?.value || getSelection()?.toString(),
      );
    });
  });
  await server(page);
  await page.getByTestId('torrent-row').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copy info hash' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__copies.at(-1)))
    .toBe('a'.repeat(40));
  await expect(page.getByRole('status')).toHaveText(/Copied/);
  await page.getByTestId('torrent-row').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copy magnet link' }).click();
  const copied = await page.evaluate(() => (window as any).__copies.at(-1));
  expect(new URL(copied).searchParams.get('xt')).toBe(`urn:btih:${'a'.repeat(40)}`);
});

test('blocked copying offers selectable text instead of a dead-end toast', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    document.execCommand = () => false;
  });
  await server(page);
  await page.getByTestId('torrent-row').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copy info hash' }).click();
  await expect(page.getByRole('dialog', { name: 'Copy text' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Text to copy' })).toHaveValue('a'.repeat(40));
});

test('dialog exit keeps its frame intact and restores focus', async ({ page }) => {
  await server(page);
  const add = page.getByRole('button', { name: 'Add torrent', exact: true });
  // Exercise a keyboard invocation; Safari does not focus buttons on pointer clicks.
  await add.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Add a transfer' });
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(200);
  const before = await dialog.boundingBox();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  const frame = await page.evaluate(() => {
    const dialog = document.querySelector('dialog')!;
    const animations = dialog.getAnimations();
    for (const animation of animations) animation.pause();
    const rect = dialog.getBoundingClientRect();
    return {
      width: rect.width,
      height: rect.height,
      bodyTransform: getComputedStyle(dialog.querySelector('.modal-body')!).transform,
      open: dialog.open,
    };
  });
  expect(frame.height).toBeGreaterThan(before!.height * 0.95);
  expect(frame.width).toBeGreaterThan(before!.width * 0.95);
  expect(frame.bodyTransform).toBe('none');
  expect(frame.open).toBe(true);
  await page.evaluate(() => {
    for (const a of document.querySelector('dialog')!.getAnimations()) a.finish();
  });
  await expect(page.locator('dialog')).toHaveCount(0);
  await expect(add).toBeFocused();
  await add.click();
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog')).toHaveCount(0);
});

async function smallTargets(page: Page) {
  return page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        'button,a[href],input,textarea,select,[role="button"],[role="slider"]',
      ),
    ]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return (
          r.width > 0 &&
          r.height > 0 &&
          r.right > 0 &&
          r.left < innerWidth &&
          r.bottom > 0 &&
          r.top < innerHeight &&
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          !el.closest('[inert]')
        );
      })
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width < 43.9 || r.height < 43.9;
      })
      .map((el) => ({
        name: el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 60),
        tag: el.tagName,
        width: el.getBoundingClientRect().width,
        height: el.getBoundingClientRect().height,
      })),
  );
}

test('mobile navigation is thumb reachable and every visible control has a 44px target', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await server(page);
  expect(await smallTargets(page)).toEqual([]);
  await page.locator('.row-menu').first().click();
  await expect(page.getByRole('menuitem', { name: 'Copy info hash' })).toBeVisible();
  await page.keyboard.press('Escape');
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  const navBox = await nav.boundingBox();
  expect(navBox!.y).toBeGreaterThan(700);
  const addBox = await page.getByRole('button', { name: 'Add torrent', exact: true }).boundingBox();
  expect(addBox!.y).toBeGreaterThan(700);
  await nav.getByRole('button', { name: 'Activity', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Activity', exact: true })).toBeVisible();
  expect(await smallTargets(page)).toEqual([]);
  await page.screenshot({ path: 'test-results/drift-mobile-activity.png', fullPage: true });
  await nav.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  expect(await smallTargets(page)).toEqual([]);
  await page.locator('.settings-tabs').getByRole('button', { name: 'Limits', exact: true }).click();
  await page.getByRole('spinbutton', { name: 'Limit download', exact: true }).fill('123');
  await nav.getByRole('button', { name: 'Activity', exact: true }).click();
  await nav.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Limit download', exact: true })).toHaveValue(
    '123',
  );
  await nav.getByRole('button', { name: 'Transfers', exact: true }).click();
  await page.getByTestId('torrent-row').first().click();
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  expect(await smallTargets(page)).toEqual([]);
  await page.getByRole('tab', { name: /^Peers/ }).click();
  expect(await smallTargets(page)).toEqual([]);
  await nav.getByRole('button', { name: 'Transfers', exact: true }).click();
  await expect(page.locator('.inspector')).toHaveCount(0);
  await page.getByRole('button', { name: 'Add torrent', exact: true }).click();
  expect(await smallTargets(page)).toEqual([]);
});

test('mobile inspector stays fixed while exiting instead of entering the content grid', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await server(page);
  await page.getByTestId('torrent-row').first().click();
  await page.waitForTimeout(220);
  await page.getByRole('button', { name: 'Close inspector' }).click();
  const frame = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('.inspector')!;
    for (const a of panel.getAnimations()) a.pause();
    const r = panel.getBoundingClientRect();
    return {
      position: getComputedStyle(panel).position,
      width: r.width,
      height: r.height,
      top: r.top,
      left: r.left,
    };
  });
  expect(frame.position).toBe('fixed');
  expect(frame.width).toBeCloseTo(390, 0);
  expect(frame.height).toBeCloseTo(844, 0);
  expect(Math.abs(frame.top)).toBeLessThan(1);
  await page.evaluate(() => {
    for (const a of document.querySelector('.inspector')!.getAnimations()) a.finish();
  });
  await expect(page.locator('.inspector')).toHaveCount(0);
});

test('tracker composition uses readable type and progressive disclosure', async ({ page }) => {
  await server(page);
  await page.getByTestId('torrent-row').first().click();
  await page.getByRole('tab', { name: 'Trackers', exact: true }).click();
  await expect(page.locator('.tracker-extra')).toHaveCount(0);
  await page.locator('.tracker-heading').first().click();
  await expect(page.locator('.tracker-extra')).toContainText('tracker.example.org/announce');
  const tiny = await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const result: any[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || !node.textContent?.trim() || parent.closest('script,style')) continue;
      const r = document.createRange();
      r.selectNodeContents(node);
      const b = r.getBoundingClientRect();
      const style = getComputedStyle(parent);
      if (
        b.width > 0.1 &&
        b.height > 0.1 &&
        b.right > 0 &&
        b.left < innerWidth &&
        b.bottom > 0 &&
        b.top < innerHeight &&
        style.visibility !== 'hidden' &&
        Number.parseFloat(style.fontSize) < 12
      )
        result.push({ text: node.textContent, size: style.fontSize });
    }
    return result;
  });
  expect(tiny).toEqual([]);
  await page.screenshot({ path: 'test-results/drift-trackers-readable.png', fullPage: true });
});

test('speed history uses measured samples, readable time ticks, and correctly scaled tooltips', async ({
  page,
}) => {
  await page.clock.install();
  const { calls } = await server(page);
  for (let i = 0; i < 20; i++) {
    const before = calls.filter((c) => c.method === 'session-stats').length;
    await page.clock.fastForward(6000);
    await expect
      .poll(() => calls.filter((c) => c.method === 'session-stats').length)
      .toBeGreaterThan(before);
  }
  await page.clock.resume();
  await expect(page.getByText('Collecting live history')).toHaveCount(0);
  const plot = page.getByRole('slider', { name: 'Inspect transfer speed history' });
  await expect(plot).toHaveAttribute('aria-valuemax', '20');
  await plot.focus();
  const latest = await plot.getAttribute('aria-valuenow');
  await page.keyboard.press('ArrowLeft');
  await expect(plot).toHaveAttribute('aria-valuenow', String(Number(latest) - 1));
  await page.keyboard.press('Escape');
  await expect(plot).toHaveAttribute('aria-valuenow', latest!);
  const bounds = await plot.boundingBox();
  await page.mouse.move(bounds!.x + bounds!.width - 25, bounds!.y + 75);
  await expect(page.locator('.lc-tooltip-container')).toContainText('Download');
  await expect(page.locator('.lc-tooltip-container')).toContainText('MB/s');
  await expect(page.locator('.lc-tooltip-container')).toContainText('625 KB/s');
  await page.screenshot({ path: 'test-results/drift-speed-history.png', fullPage: true });
  await page.setViewportSize({ width: 320, height: 740 });
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Activity', exact: true })
    .click();
  await page.waitForTimeout(200);
  const timeLabels = await page
    .locator('.chart-plot .lc-axis[data-placement="bottom"] .lc-axis-tick-label')
    .evaluateAll((elements) =>
      elements
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right };
        })
        .sort((a, b) => a.left - b.left),
    );
  expect(timeLabels.length).toBeGreaterThan(1);
  for (let i = 1; i < timeLabels.length; i++)
    expect(timeLabels[i].left - timeLabels[i - 1].right).toBeGreaterThanOrEqual(8);
  await page.screenshot({ path: 'test-results/drift-mobile-activity.png', fullPage: true });
});

test('small phones keep file, tracker, options, and settings controls at 44px without overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await server(page);
  const audit = async () => {
    expect(await smallTargets(page)).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  };
  await page.getByTestId('torrent-row').first().click();
  for (const name of ['Overview', 'Files', 'Peers', 'Trackers', 'Options']) {
    await page.getByRole('tab', { name: new RegExp(`^${name}`) }).click();
    await audit();
    await page.locator('.inspector-scroll').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await audit();
    await page.locator('.inspector-scroll').evaluate((el) => {
      el.scrollTop = 0;
    });
    if (name === 'Files')
      await page.screenshot({ path: 'test-results/drift-mobile-files.png', fullPage: true });
  }
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
  for (const name of ['Connection', 'Appearance', 'Limits', 'Transfers', 'Network']) {
    await page.locator('.settings-tabs').getByRole('button', { name, exact: true }).click();
    await audit();
    await page.locator('.mobile-page-scroll').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await audit();
    await page.locator('.mobile-page-scroll').evaluate((el) => {
      el.scrollTop = 0;
    });
  }
});

test('missing newer APIs and blocked storage keep the client usable', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.addInitScript(() => {
    Object.defineProperty(AbortSignal, 'timeout', { value: undefined, configurable: true });
    delete (HTMLElement.prototype as any).inert;
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('Storage blocked');
      },
    });
  });
  await server(page);
  expect(await page.evaluate(() => 'inert' in HTMLElement.prototype)).toBe(true);
  await expect(page.locator('.row-actions').first()).toHaveCSS('opacity', '1');
  await page.getByTestId('torrent-row').first().click();
  await expect(page.locator('.boost-card')).toBeVisible();
  await page.getByRole('button', { name: 'Close inspector' }).click();
  await expect(page.locator('.inspector')).toHaveCount(0);
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: 'Add torrent', exact: true }).click();
    await expect(page.locator('.app-shell')).toHaveJSProperty('inert', true);
    await page.getByRole('button', { name: 'Close dialog' }).click();
    await expect(page.locator('dialog')).toHaveCount(0);
    await expect(page.locator('.app-shell')).toHaveJSProperty('inert', false);
  }
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
  await page
    .locator('.settings-tabs')
    .getByRole('button', { name: 'Appearance', exact: true })
    .click();
  await page.getByRole('combobox', { name: 'Color theme' }).selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('mobile menu actions target the tapped torrent without a prior selection', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const { calls } = await server(page);
  await page.locator('.row-menu').first().click();
  await page.getByRole('menuitem', { name: /^Pause/ }).click();
  await expect
    .poll(() => calls.find((c) => c.method === 'torrent-stop')?.arguments.ids)
    .toEqual([1]);
});
