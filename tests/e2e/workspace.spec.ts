import { expect, type Page, test } from '@playwright/test';
import { fixtures } from '../fixtures';

async function settingsSection(page: Page, section: string) {
  const back = page.getByRole('button', { name: 'Back to settings', exact: true });
  if (await back.isVisible()) await back.click();
  const label =
    ({ Limits: 'Bandwidth', Transfers: 'Downloads' } as Record<string, string>)[section] || section;
  await page
    .getByRole('navigation', { name: 'Settings sections', exact: true })
    .getByRole('button', { name: label, exact: true })
    .click();
}

async function server(
  page: Page,
  features: boolean | 'stale' = true,
  options: {
    startupFailures?: number;
    waitForReady?: boolean;
    portDelay?: number;
    portOpen?: boolean;
    rpcVersion?: number;
  } = {},
) {
  let failures = options.startupFailures || 0;
  const torrents = fixtures();
  const calls: { method: string; arguments: any }[] = [];
  const session: Record<string, any> = {
    version: '4.1.3',
    'rpc-version': options.rpcVersion ?? 19,
    'download-dir': '/data/Downloads',
    'download-dir-free-space': 324000000000,
    'peer-port': 51413,
    'peer-limit-global': 200,
    encryption: 'preferred',
  };
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
    if (failures-- > 0) {
      await route.abort();
      return;
    }
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
        result = {
          torrents: targets.map((t) => {
            const copy = Object.fromEntries(
              Object.entries(t).filter(([key]) => !args.fields || args.fields.includes(key)),
            );
            if ((options.rpcVersion ?? 19) < 18) delete copy.sequential_download;
            return copy;
          }),
        };
        break;
      case 'session-stats':
        result = {
          downloadSpeed: 2400000 + (calls.length % 5) * 170000,
          uploadSpeed: 640000,
          torrentCount: torrents.length,
        };
        break;
      case 'session-get':
        result = { ...session };
        break;
      case 'session-set':
        Object.assign(session, args);
        break;
      case 'port-test':
        await new Promise((resolve) => setTimeout(resolve, options.portDelay ?? 500));
        result = { 'port-is-open': options.portOpen ?? true };
        break;
      case 'torrent-set':
        for (const t of targets) Object.assign(t, args);
        break;
      case 'torrent-rename-path':
        for (const t of targets) {
          const root = t.files?.[0]?.name.split('/')[0];
          t.files = t.files?.map((f) => ({
            ...f,
            name:
              f.name === args.path || f.name.startsWith(`${args.path}/`)
                ? args.name + f.name.slice(args.path.length)
                : f.name,
          }));
          if (root === args.path) t.name = args.name;
        }
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
  if (options.waitForReady !== false) await expect(page.getByTestId('torrent-row')).toHaveCount(6);
  return { torrents, calls, session };
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
  await expect(page.getByRole('combobox', { name: /^Priority for / })).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Download Ubuntu 24.04', exact: true }).check();
  await expect
    .poll(() =>
      calls.find((c) => c.method === 'torrent-set' && c.arguments['files-wanted']?.length === 3),
    )
    .toBeTruthy();
  await page.getByRole('tab', { name: /^Peers/ }).click();
  await expect(page.getByRole('group', { name: /8 connected peers/ })).toBeVisible();
  await page
    .getByRole('button', { name: 'Inspect peer 192.0.2.1 port 51413', exact: true })
    .click();
  await expect(page.locator('.peer-row[aria-pressed="true"]')).toContainText('192.0.2.1');
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
  await expect(page.locator('.full-speed-button')).toHaveCount(0);
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
  await expect(page.locator('.full-speed-button')).toHaveCount(0);
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
  const corners = await page.getByTestId('torrent-row').evaluateAll((rows) =>
    rows.slice(0, 3).map((row) => {
      const style = getComputedStyle(row);
      return [style.borderTopLeftRadius, style.borderBottomLeftRadius];
    }),
  );
  expect(corners).toEqual([
    ['10px', '0px'],
    ['0px', '0px'],
    ['0px', '10px'],
  ]);
  const sort = await page.locator('.list-toolbar').boundingBox();
  const actions = await page.getByRole('toolbar', { name: 'Selected transfers' }).boundingBox();
  expect(actions!.y).toBeGreaterThanOrEqual(sort!.y + sort!.height);
  const selectedRow = await page.getByTestId('torrent-row').first().boundingBox();
  expect(Math.abs(actions!.x - selectedRow!.x)).toBeLessThan(2);
  expect(Math.abs(actions!.width - selectedRow!.width)).toBeLessThan(2);

  await page.getByTestId('torrent-row').nth(2).click({ button: 'right' });
  await expect(page.locator('.menu-caption').first()).toContainText('3 transfers');
  await page.screenshot({ path: 'test-results/drift-dark.png', fullPage: true });
});

test('a connection failure keeps existing data visible and explains its freshness', async ({
  page,
}) => {
  await server(page);
  await page.route(/\/rpc$/, (route) => route.abort());
  await expect(page.getByRole('alert')).toContainText('showing last received data', {
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
  await expect(
    page.getByRole('heading', { name: 'Activity', exact: true, level: 1 }),
  ).toBeVisible();
  expect(await smallTargets(page)).toEqual([]);
  await page.screenshot({ path: 'test-results/drift-mobile-activity.png', fullPage: true });
  await nav.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  expect(await smallTargets(page)).toEqual([]);
  await settingsSection(page, 'Limits');
  await page.getByRole('switch', { name: 'Download limit', exact: true }).check();
  await page.getByRole('spinbutton', { name: 'Maximum download', exact: true }).fill('123');
  await nav.getByRole('button', { name: 'Activity', exact: true }).click();
  await nav.getByRole('button', { name: 'Settings', exact: true }).click();
  await settingsSection(page, 'Limits');
  await expect(page.getByRole('spinbutton', { name: 'Maximum download', exact: true })).toHaveValue(
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
    await settingsSection(page, name);
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
  await expect(page.getByRole('button', { name: 'Full speed', exact: true })).toBeVisible();
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
  await settingsSection(page, 'Appearance');
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

test('transient startup failures stay in the loading state without a warning flash', async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as any).__startupAlerts = [];
    new MutationObserver(() => {
      const alert = document.querySelector('[role=alert]');
      if (alert) (window as any).__startupAlerts.push(alert.textContent);
    }).observe(document, { childList: true, subtree: true });
  });
  await server(page, true, { startupFailures: 2 });
  expect(await page.evaluate(() => (window as any).__startupAlerts)).toEqual([]);
});

test('a persistent startup failure has a useful error after the initial retry', async ({
  page,
}) => {
  await server(page, true, { startupFailures: 99, waitForReady: false });
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('Cannot reach Transmission', {
    timeout: 15000,
  });
  await expect(
    page.getByRole('button', { name: 'Connection settings', exact: true }),
  ).toBeVisible();
});

test('layout, details, peer card, and settings follow the reviewed composition', async ({
  page,
}) => {
  await page.setViewportSize({ width: 2000, height: 1100 });
  await server(page);
  const row = page.getByTestId('torrent-row').last();
  expect((await row.boundingBox())!.width).toBeLessThanOrEqual(1120);
  const icon = await row.locator('.torrent-icon').boundingBox(),
    box = await row.boundingBox();
  expect(Math.abs(icon!.y + icon!.height / 2 - (box!.y + box!.height / 2))).toBeLessThan(2);
  const search = await page.locator('.search-box').boundingBox(),
    add = await page.getByRole('button', { name: 'Add torrent', exact: true }).boundingBox();
  expect(Math.abs(search!.height - add!.height)).toBeLessThan(2);
  await expect(page.getByRole('button', { name: 'Toggle inspector' })).toHaveCount(0);
  await expect(row.locator('.row-speeds')).toHaveText(/KB\/s/);
  await page.screenshot({ path: 'test-results/review-desktop-wide.png', fullPage: true });
  await row.click();
  await expect(page.getByRole('button', { name: 'Full speed', exact: true })).toHaveCount(0);
  await expect(page.locator('.action-caption')).toHaveCount(0);
  await expect(page.locator('.inspector')).not.toContainText('No labels');
  await page.screenshot({ path: 'test-results/review-completed-details.png', fullPage: true });
  await page.getByRole('button', { name: 'Close inspector' }).click();
  await page.getByTestId('torrent-row').first().click();
  await page.getByRole('tab', { name: /^Peers/ }).click();
  await page
    .getByRole('button', { name: 'Inspect peer 192.0.2.1 port 51413', exact: true })
    .click();
  await expect(page.locator('.peer-row[aria-pressed="true"]')).toBeVisible();
  await page.locator('.peer-row[aria-pressed="true"]').click();
  await expect(page.locator('.peer-row[aria-pressed="true"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close inspector' }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .locator('.settings-tabs')
    .getByRole('button', { name: 'Network', exact: true })
    .click();
  await page.screenshot({ path: 'test-results/review-settings-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.setViewportSize({ width: 375, height: 667 });
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
  await settingsSection(page, 'Network');
  await page.waitForTimeout(220);
  await page.screenshot({ path: 'test-results/review-settings-phone.png', fullPage: true });
  expect(await smallTargets(page)).toEqual([]);
});

test('recorded server history is available before opening the frontend and after reconnecting', async ({
  page,
}) => {
  const now = Date.now();
  const samples = [
    [now - 90000, 4800000, 120000],
    [now - 60000, 2000000, 240000],
  ];
  await page.route('**/activity.json', (route) =>
    route.fulfill({ json: { version: 1, updated: Date.now() / 1000, samples } }),
  );
  await server(page);
  await expect(page.getByText('Recording on the server', { exact: true })).toHaveCount(0);
  await expect
    .poll(async () => Number(await page.getByRole('slider').getAttribute('aria-valuemax')))
    .toBeGreaterThanOrEqual(2);
  await page.goto('about:blank');
  samples.push([now - 30000, 3500000, 120000]);
  await page.goto('/');
  await expect(page.getByText('Recording on the server', { exact: true })).toHaveCount(0);
  await expect
    .poll(async () => Number(await page.getByRole('slider').getAttribute('aria-valuemax')))
    .toBeGreaterThanOrEqual(3);
});

test('mobile global settings auto-save without a commit button', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const { calls } = await server(page);
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
  await settingsSection(page, 'Network');
  await page.getByRole('spinbutton', { name: 'Incoming port', exact: true }).fill('54321');
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toHaveCount(0);
  await expect
    .poll(() => calls.find((c) => c.method === 'session-set')?.arguments['peer-port'])
    .toBe(54321);
  expect(calls.find((c) => c.method === 'session-set')?.arguments).toEqual({ 'peer-port': 54321 });
  await expect(page.getByRole('button', { name: 'Test port', exact: true })).toBeEnabled();
});

test('single-file priorities fit and labels filter the library', async ({ page }) => {
  const { torrents } = await server(page);
  torrents[0].files = [
    { name: '7.Days.to.End.with.You.v1.2.02.rar', length: 27520000, bytesCompleted: 27520000 },
  ];
  torrents[0].fileStats = [{ wanted: true, priority: 0, bytesCompleted: 27520000 }];
  torrents[0].labels = ['Linux'];
  await page.getByTestId('torrent-row').first().click();
  await expect(page.locator('.label-chip').filter({ hasText: 'Linux' })).toBeVisible();
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await expect(page.locator('.file-priority')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/review-file-tree.png', fullPage: true });
  await page
    .getByRole('button', { name: 'Actions for 7.Days.to.End.with.You.v1.2.02.rar', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Rename…', exact: true }).click();
  await expect(
    page
      .getByRole('group', { name: 'Download priority', exact: true })
      .getByRole('button', { name: 'Normal', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await page.locator('.label-chip').filter({ hasText: 'Linux' }).click();
  await expect(page.getByTestId('torrent-row')).toHaveCount(1);
  await page.getByRole('button', { name: 'Clear label filter' }).click();
  await expect(page.getByTestId('torrent-row')).toHaveCount(6);
});

test('wide sidebars stay anchored and details overlay without moving transfer content', async ({
  page,
}) => {
  await page.setViewportSize({ width: 2560, height: 1200 });
  await server(page);
  expect((await page.locator('.sidebar').boundingBox())!.x).toBe(0);
  const row = page.getByTestId('torrent-row').first();
  const before = await row.boundingBox();
  const heading = await page.locator('.topbar').boundingBox();
  await row.click();
  await page.waitForTimeout(220);
  expect(await row.boundingBox()).toEqual(before);
  expect(await page.locator('.topbar').boundingBox()).toEqual(heading);
  expect((await page.locator('.inspector').boundingBox())!.width).toBe(560);
  await page.getByRole('button', { name: 'Close inspector' }).click();
  await expect(page.locator('.inspector')).toHaveCount(0);
  expect(await row.boundingBox()).toEqual(before);
  await page
    .getByTestId('torrent-row')
    .nth(2)
    .click({ modifiers: ['Shift'] });
  expect(await page.evaluate(() => getSelection()?.toString())).toBe('');
  await expect(page.getByTestId('torrent-row').nth(2)).toContainText('63% verified');
});

test('peer rows and diagram share selection including peers at the same address', async ({
  page,
}) => {
  const { torrents } = await server(page);
  torrents[0].peers!.push({
    ...torrents[0].peers![0],
    port: 50001,
    clientName: 'A second connection',
  });
  await page.getByTestId('torrent-row').first().click();
  await page.getByRole('tab', { name: /^Peers/ }).click();
  const connection = page.getByRole('button', {
    name: 'Select peer 192.0.2.1 port 50001',
    exact: true,
  });
  await expect(page.locator('.peer-row')).toHaveCount(9);
  const rowPositions = () =>
    page.locator('.peer-row').evaluateAll((rows) =>
      rows.map((row) => {
        const r = row.getBoundingClientRect(),
          scroller = row.closest('.inspector-scroll')!;
        return {
          y: r.y - scroller.getBoundingClientRect().y + scroller.scrollTop,
          height: r.height,
        };
      }),
    );
  const rowsBefore = await rowPositions();
  await connection.click();
  expect(await rowPositions()).toEqual(rowsBefore);
  await expect(connection).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.peer-row[aria-pressed="true"]')).toContainText('50001');
  await expect(page.locator('.peer-row[aria-pressed="true"] .peer-client-line')).toHaveAttribute(
    'title',
    /A second connection/,
  );
  await expect(
    page.getByRole('button', { name: 'Inspect peer 192.0.2.1 port 50001', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page
    .getByRole('button', { name: 'Inspect peer 192.0.2.1 port 51413', exact: true })
    .click();
  await expect(page.locator('.peer-row[aria-pressed="true"]')).toContainText('51413');
  await expect(connection).toHaveAttribute('aria-pressed', 'false');
  expect(await rowPositions()).toEqual(rowsBefore);
});

test('deep phone file trees preserve ancestry and send the exact folder file indices', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const { torrents, calls } = await server(page);
  const names = [
    'Project/Docs/README.md',
    'Project/Source/packages/client/src/lib/components/tree/README.md',
    'Project/Source/packages/client/src/lib/components/tree/Tree.svelte',
    'Project/Source/packages/server/README.md',
    'Media/Season 1/Episode 1.mkv',
    'Media/Season 2/Episode 1.mkv',
    'LICENSE',
  ];
  torrents[0].files = names.map((name) => ({ name, length: 1048576, bytesCompleted: 524288 }));
  torrents[0].fileStats = names.map(() => ({ wanted: true, priority: 0, bytesCompleted: 524288 }));
  await page.getByTestId('torrent-row').first().click();
  await expect(page.locator('.main-pane')).toHaveAttribute('inert', '');
  await expect(page.locator('.inspector-title h2')).toBeFocused();
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  const deep = page.getByRole('treeitem').filter({
    has: page.getByRole('checkbox', {
      name: 'Download Project/Source/packages/client/src/lib/components/tree/README.md',
      exact: true,
    }),
  });
  expect(parseFloat(await deep.evaluate((el) => getComputedStyle(el).paddingLeft))).toBeGreaterThan(
    40,
  );
  await page.getByRole('checkbox', { name: 'Download Project/Source', exact: true }).uncheck();
  await expect
    .poll(
      () =>
        calls.find((c) => c.method === 'torrent-set' && c.arguments['files-unwanted'])?.arguments[
          'files-unwanted'
        ],
    )
    .toEqual([1, 2, 3]);
  await page.getByRole('textbox', { name: 'Filter files', exact: true }).fill('README');
  await expect(page.locator('.file-path')).toHaveCount(3);
  await expect(
    page
      .locator('.file-path')
      .filter({ hasText: /Project.*Source.*packages.*client.*src.*lib.*components.*tree/ }),
  ).toBeVisible();
  await page.getByRole('textbox', { name: 'Filter files', exact: true }).fill('no-such-file');
  await expect(page.getByText('No matching files', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filter', exact: true }).click();
  await page.getByRole('button', { name: 'Collapse all folders' }).click();
  await expect(page.getByRole('treeitem')).toHaveCount(3);
  await page.getByRole('button', { name: 'Actions for Project', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rename…', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Folder options' })).toBeVisible();
  await page
    .getByRole('group', { name: 'Download priority', exact: true })
    .getByRole('button', { name: 'High', exact: true })
    .click();
  await expect
    .poll(
      () =>
        calls.find((c) => c.method === 'torrent-set' && c.arguments['priority-high'])?.arguments[
          'priority-high'
        ],
    )
    .toEqual([0, 1, 2, 3]);
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close inspector' }).click();
  await expect(page.locator('.inspector')).toHaveCount(0);
  await expect(page.getByTestId('torrent-row').first()).toBeFocused();
  await expect(page.locator('.main-pane')).not.toHaveAttribute('inert', '');
});

test('settings navigation is distinct from values and port tests show inline progress and result', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const options = { portDelay: 1200, portOpen: false };
  const { calls } = await server(page, true, options);
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
  await expect(page.getByRole('combobox', { name: 'Settings section' })).toHaveCount(0);
  await expect(
    page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button'),
  ).toHaveCount(5);
  await settingsSection(page, 'Network');
  const before = await page
    .getByRole('heading', { name: 'Peer discovery', exact: true })
    .boundingBox();
  await page.getByRole('button', { name: 'Test port', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Testing…', exact: true })).toBeDisabled();
  await expect(page.locator('.inline-result')).toContainText('Checking port 51413');
  expect(
    await page.getByRole('heading', { name: 'Peer discovery', exact: true }).boundingBox(),
  ).toEqual(before);
  await expect(page.locator('.inline-result')).toContainText('Port 51413 is closed');
  expect(
    await page.getByRole('heading', { name: 'Peer discovery', exact: true }).boundingBox(),
  ).toEqual(before);
  await expect(page.locator('.toast')).toHaveCount(0);
  options.portOpen = true;
  await page.getByRole('button', { name: 'Test again', exact: true }).click();
  await expect(page.locator('.inline-result')).toContainText('Port 51413 is reachable');
  expect(calls.filter((c) => c.method === 'port-test')).toHaveLength(2);
});

test('inspector arrow keys stay inside details and tabs and files follow keyboard conventions', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await server(page);
  await page.getByTestId('torrent-row').first().click();
  const overview = page.getByRole('tab', { name: 'Overview', exact: true });
  await overview.focus();
  await overview.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Files', exact: true })).toBeFocused();
  const root = page.getByRole('treeitem').first();
  await root.focus();
  await root.press('ArrowRight');
  await expect(page.getByRole('treeitem').nth(1)).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('treeitem').nth(1)).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('ArrowLeft');
  await expect(root).toBeFocused();
  await page.getByRole('tab', { name: /^Peers/ }).click();
  await expect(
    page.locator('.peer-view-control button').filter({ hasText: 'List' }),
  ).toHaveAttribute('aria-pressed', 'true');
  const peer = page.locator('.peer-row').first();
  await peer.focus();
  await peer.press('ArrowDown');
  await peer.press('ArrowUp');
  await expect(page.locator('.inspector-title h2')).toHaveText('Ubuntu 24.04.4 Desktop.iso');
  await peer.click();
  await page.getByRole('button', { name: 'Diagram', exact: true }).click();
  await expect(page.locator('.peer-row[aria-pressed="true"]')).toContainText('51413');
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await expect(peer).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Close inspector' }).click();
  await expect(page.locator('.inspector')).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByTestId('torrent-row').first().focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('torrent-row').nth(1)).toBeFocused();
  await expect(page.locator('.inspector-title h2')).toHaveText('Debian 13.1 · netinst');
});

test('completed and unavailable Full speed states do not leave row badges behind', async ({
  page,
}) => {
  const { torrents } = await server(page, 'stale');
  torrents[0].labels = ['router:full-speed'];
  torrents[5].labels = ['router:full-speed'];
  await page.waitForTimeout(2300);
  await expect(page.locator('.full-indicator')).toHaveCount(0);
  await page.getByTestId('torrent-row').last().click();
  await expect(page.locator('.full-speed-button')).toHaveCount(0);
  await expect(page.locator('.action-caption')).toHaveCount(0);
});

test('completed transfer actions explicitly control seeding and omit queue-start commands', async ({
  page,
}) => {
  const { calls } = await server(page);
  const row = page.getByTestId('torrent-row').last();
  await row.click();
  await expect(page.getByRole('button', { name: 'Stop seeding', exact: true })).toBeVisible();
  await expect(page.locator('.inspector-header button')).toHaveCount(1);
  await page.getByRole('button', { name: 'Close inspector' }).click();
  await row.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: /^Stop seeding/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Start now|Download now|Pause/ })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Move to top', exact: true })).toHaveCount(0);
  await page.getByRole('menuitem', { name: /^Stop seeding/ }).click();
  await expect
    .poll(() => calls.find((c) => c.method === 'torrent-stop')?.arguments.ids)
    .toEqual([6]);
  await expect(row).toContainText('Completed');
});

test('file rows are compact and aligned with pressed feedback and contextual priorities', async ({
  page,
}) => {
  await server(page);
  await page.getByTestId('torrent-row').first().click();
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  const folder = page.getByRole('treeitem').filter({
    has: page.getByRole('checkbox', { name: 'Download Ubuntu 24.04/Docs', exact: true }),
  });
  const file = page.getByRole('treeitem').filter({
    has: page.getByRole('checkbox', { name: 'Download Ubuntu 24.04/desktop.iso', exact: true }),
  });
  expect((await file.boundingBox())!.height).toBeLessThanOrEqual(40);
  const folderName = await folder.locator('.file-name>span:last-child').boundingBox();
  const fileName = await file.locator('.file-name>span:last-child').boundingBox();
  expect(folderName!.x).toBeCloseTo(fileName!.x, 0);
  await expect(page.locator('.file-priority')).toHaveCount(0);
  const checkbox = file.getByRole('checkbox');
  await checkbox.hover();
  await page.mouse.down();
  expect(await checkbox.evaluate((el) => getComputedStyle(el, '::before').transform)).not.toBe(
    'none',
  );
  await page.mouse.up();
  await expect(page.locator('.statusbar')).toHaveCount(0);
  await expect(page.getByText('Recording on the server', { exact: true })).toHaveCount(0);
});

test('dots remain visible and anchored without opening details or changing selection', async ({
  page,
}) => {
  const { calls } = await server(page);
  const trigger = page.getByTestId('torrent-row').first().locator('.row-menu');
  await page.getByTestId('torrent-row').first().hover();
  const box = await trigger.boundingBox();
  await trigger.click();
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page.locator('.inspector')).toHaveCount(0);
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(trigger.locator('..')).toHaveCSS('opacity', '1');
  await expect(trigger.locator('..')).toHaveCSS('border-top-style', 'none');
  expect(await trigger.boundingBox()).toEqual(box);
  const menu = await page.getByRole('menu').boundingBox();
  expect(
    menu!.y >= box!.y + box!.height + 5 ||
      menu!.y + menu!.height <= box!.y - 5 ||
      menu!.x + menu!.width <= box!.x - 5,
  ).toBe(true);
  await page.getByRole('menuitem', { name: /^Pause download/ }).click();
  await expect
    .poll(() => calls.find((c) => c.method === 'torrent-stop')?.arguments.ids)
    .toEqual([1]);
  await expect(page.locator('.inspector')).toHaveCount(0);
  const row = page.getByTestId('torrent-row').first();
  await row.click();
  await row.click({ button: 'right', position: { x: 60, y: 30 } });
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(page.locator('.inspector')).toBeVisible();
});

test('file right-click changes priority directly and phone scrollers fit their viewport', async ({
  page,
}) => {
  const { calls } = await server(page);
  await page.getByTestId('torrent-row').first().click();
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await page.getByRole('treeitem').first().click({ button: 'right' });
  await expect(page.getByRole('menu', { name: 'File actions' })).toBeVisible();
  const fileMenu = page.getByRole('menu', { name: 'File actions' });
  await expect(fileMenu.locator('.menu-caption')).toHaveText('File priority');
  await expect(fileMenu.locator('hr')).toHaveCount(0);
  const priorityBounds = await fileMenu
    .getByRole('group', { name: 'Priority', exact: true })
    .boundingBox();
  const renameBounds = await fileMenu
    .getByRole('menuitem', { name: 'Rename…', exact: true })
    .boundingBox();
  expect(priorityBounds!.height).toBe(renameBounds!.height);

  await expect(page.getByRole('button', { name: 'Normal', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'High', exact: true }).click();
  await expect
    .poll(
      () =>
        calls.find((c) => c.method === 'torrent-set' && c.arguments['priority-high'])?.arguments[
          'priority-high'
        ],
    )
    .toEqual([0, 1, 2]);
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 667 });
    const overflow = await page
      .locator('.inspector-scroll,.file-tree')
      .evaluateAll((els) =>
        els
          .filter(
            (el) => el.getBoundingClientRect().width > 0 && el.scrollWidth > el.clientWidth + 1,
          )
          .map((el) => el.className),
      );
    expect(overflow).toEqual([]);
  }
  const userSelect = await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Activity', exact: true })
    .evaluate(
      (el) =>
        getComputedStyle(el).getPropertyValue('-webkit-user-select') ||
        getComputedStyle(el).userSelect,
    );
  expect(userSelect).toBe('none');
});

test('torrent rename uses its real root path and refreshes folder and single-file names', async ({
  page,
}) => {
  const { torrents, calls } = await server(page);
  const row = page.getByTestId('torrent-row').first();
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Rename torrent', exact: true });
  const name = dialog.getByRole('textbox', { name: 'Name', exact: true });
  await expect(name).toHaveValue('Ubuntu 24.04');
  await name.fill('../wrong');
  await expect(dialog.getByRole('button', { name: 'Rename', exact: true })).toBeDisabled();
  await name.fill('Ubuntu library');
  await dialog.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row.locator('.torrent-name')).toHaveText('Ubuntu library');
  expect(calls.find((c) => c.method === 'torrent-rename-path')?.arguments).toEqual({
    ids: [1],
    path: 'Ubuntu 24.04',
    name: 'Ubuntu library',
  });
  expect(torrents[0].files?.map((f) => f.name)).toEqual([
    'Ubuntu library/desktop.iso',
    'Ubuntu library/Docs/README.txt',
    'Ubuntu library/Docs/SHA256SUMS',
  ]);
  torrents[0].files = [{ name: 'movie.mkv', length: 6000000000, bytesCompleted: 2600000000 }];
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename…', exact: true }).click();
  await expect(name).toHaveValue('movie.mkv');
  await name.fill('Movie.mkv');
  await dialog.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(row.locator('.torrent-name')).toHaveText('Movie.mkv');
  expect(calls.filter((c) => c.method === 'torrent-rename-path').at(-1)?.arguments).toEqual({
    ids: [1],
    path: 'movie.mkv',
    name: 'Movie.mkv',
  });
  await page.getByTestId('torrent-row').nth(1).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Rename…', exact: true })).toHaveCount(0);
});

test('a rejected torrent rename stays open for correction', async ({ page }) => {
  await server(page);
  await page.route(/\/rpc$/, async (route) => {
    const body = route.request().postDataJSON();
    if (body.method === 'torrent-rename-path' && body.arguments.name === 'Existing folder')
      await route.fulfill({ json: { result: 'File exists', arguments: {} } });
    else await route.fallback();
  });
  await page.getByTestId('torrent-row').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Rename torrent', exact: true });
  const name = dialog.getByRole('textbox', { name: 'Name', exact: true });
  await expect(name).toBeEnabled();
  await name.fill('Existing folder');
  await dialog.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('File exists');
  await expect(name).toHaveValue('Existing folder');
  await name.fill('Renamed folder');
  await dialog.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test('sequential download saves and reloads the backend mode and stays hidden on older daemons', async ({
  page,
}) => {
  const { calls } = await server(page);
  const openOptions = async () => {
    await page.getByTestId('torrent-row').first().click();
    await page.getByRole('tab', { name: 'Options', exact: true }).click();
  };
  await openOptions();
  const sequential = page.getByRole('switch', { name: /Sequential download/ });
  await expect(sequential).not.toBeChecked();
  await sequential.check();
  await expect
    .poll(
      () =>
        calls.find((c) => c.method === 'torrent-set' && c.arguments.sequential_download === true)
          ?.arguments.ids,
    )
    .toEqual([1]);
  await page.getByRole('button', { name: 'Close inspector' }).click();
  await page.locator('.inspector').waitFor({ state: 'detached' });
  await page.setViewportSize({ width: 375, height: 667 });
  await openOptions();
  await expect(sequential).toBeChecked();
  await sequential.uncheck();
  await expect
    .poll(() =>
      calls.some((c) => c.method === 'torrent-set' && c.arguments.sequential_download === false),
    )
    .toBe(true);
  const older = await server(page, true, { rpcVersion: 17 });
  await openOptions();
  await expect(sequential).toHaveCount(0);
  expect(
    older.calls
      .filter((c) => c.method === 'torrent-get')
      .every((c) => !c.arguments.fields.includes('sequential_download')),
  ).toBe(true);
});

test('transfer options auto-save only valid changed fields and survive navigation', async ({
  page,
}) => {
  const { calls } = await server(page);
  await page.getByTestId('torrent-row').first().click();
  await page.getByRole('tab', { name: 'Options', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toHaveCount(0);
  const limit = page.getByRole('spinbutton', { name: 'Peer limit', exact: true });
  await expect(limit).toHaveValue('25');
  await limit.fill('');
  await page.waitForTimeout(450);
  await limit.fill('0');
  await page.waitForTimeout(450);
  expect(calls.filter((c) => c.method === 'torrent-set')).toEqual([]);
  await limit.fill('1');
  await limit.fill('15');
  await limit.fill('150');
  await expect
    .poll(() => calls.filter((c) => c.method === 'torrent-set').map((c) => c.arguments))
    .toEqual([{ ids: [1], 'peer-limit': 150 }]);
  await limit.fill('175');
  await page.getByRole('button', { name: 'Close inspector' }).click();
  await page.locator('.inspector').waitFor({ state: 'detached' });
  await page.getByTestId('torrent-row').nth(2).click();
  await page.getByRole('tab', { name: 'Options', exact: true }).click();
  await page
    .getByRole('group', { name: 'Bandwidth priority', exact: true })
    .getByRole('button', { name: 'High', exact: true })
    .click();
  await expect
    .poll(() =>
      calls.some(
        (c) =>
          c.method === 'torrent-set' &&
          c.arguments.ids[0] === 1 &&
          c.arguments['peer-limit'] === 175,
      ),
    )
    .toBe(true);
  await expect
    .poll(() =>
      calls.some(
        (c) =>
          c.method === 'torrent-set' &&
          c.arguments.ids[0] === 3 &&
          c.arguments.bandwidthPriority === 1,
      ),
    )
    .toBe(true);
  await expect(page.getByRole('spinbutton', { name: 'Peer limit', exact: true })).toHaveValue('25');
});

test('option auto-save serializes rapid changes and restores rejected values', async ({ page }) => {
  const { calls, torrents } = await server(page);
  let release: (() => void) | undefined;
  let writes = 0;
  let reject = false;
  await page.route(/\/rpc$/, async (route) => {
    const body = route.request().postDataJSON();
    if (body.method === 'torrent-set' && 'sequential_download' in body.arguments) {
      writes++;
      if (writes === 1)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      if (reject) {
        await route.fulfill({ json: { result: 'Setting rejected', arguments: {} } });
        return;
      }
    }
    await route.fallback();
  });
  await page.getByTestId('torrent-row').first().click();
  await page.getByRole('tab', { name: 'Options', exact: true }).click();
  const sequential = page.getByRole('switch', { name: /Sequential download/ });
  await sequential.check();
  await expect.poll(() => writes).toBe(1);
  await sequential.uncheck();
  await page.waitForTimeout(200);
  expect(writes).toBe(1);
  await expect(sequential).not.toBeChecked();
  release!();
  await expect
    .poll(() =>
      calls.filter((c) => c.method === 'torrent-set').map((c) => c.arguments.sequential_download),
    )
    .toEqual([true, false]);
  await expect.poll(() => torrents[0].sequential_download).toBe(false);
  await expect(page.getByText('Saving…', { exact: true })).toHaveCount(0);
  reject = true;
  await sequential.check();
  await expect(page.locator('.toast')).toContainText('Could not save transfer option');
  await expect(sequential).not.toBeChecked();
  expect(torrents[0].sequential_download).toBe(false);
});

test('peer diagram encodes speed and volume and keeps circle size when selected', async ({
  page,
}) => {
  const { torrents } = await server(page);
  const peers = torrents[0].peers!;
  peers[0].rateToClient = 1000000;
  peers[0].rateToPeer = 0;
  peers[0].bytes_to_client = 1000;
  peers[1].rateToClient = 10000;
  peers[1].rateToPeer = 0;
  peers[1].bytes_to_client = 1000000000;
  await page.getByTestId('torrent-row').first().click();
  await page.getByRole('tab', { name: /^Peers/ }).click();
  const fast = page.getByRole('button', { name: 'Inspect peer 192.0.2.1 port 51413', exact: true });
  const slow = page.getByRole('button', { name: 'Inspect peer 192.0.2.2 port 51413', exact: true });
  const geometry = async (node: ReturnType<typeof page.getByRole>) =>
    node.locator('.peer-dot').evaluate((el) => ({
      distance: Math.hypot(
        Number(el.getAttribute('cx')) - 160,
        Number(el.getAttribute('cy')) - 132,
      ),
      radius: Number(el.getAttribute('r')),
    }));
  await expect
    .poll(async () => (await geometry(fast)).distance < (await geometry(slow)).distance)
    .toBe(true);
  const a = await geometry(fast),
    b = await geometry(slow);
  expect(a.distance).toBeLessThan(b.distance);
  expect(a.radius).toBeLessThan(b.radius);
  await slow.click();
  expect((await geometry(slow)).radius).toBe(b.radius);
  await expect(page.locator('.peer-row[aria-pressed="true"]')).toContainText('953.7 MB');
  peers[0].rateToClient = 0;
  await expect
    .poll(async () => (await geometry(fast)).distance, { timeout: 10000 })
    .toBeGreaterThan(a.distance + 10);
});

test('file menus stay inside screen edges and transfer hover states change together', async ({
  page,
}) => {
  await server(page);
  const row = page.getByTestId('torrent-row').first();
  await row.hover();
  const actions = row.locator('.row-actions');
  await expect(actions).toHaveCSS('transition-duration', '0s');
  await expect(actions.locator('.row-menu')).toHaveCSS('transition-duration', '0s');
  expect(await actions.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    await row.evaluate((el) => getComputedStyle(el).backgroundColor),
  );
  await row.click();
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  const trigger = page.getByRole('treeitem').last().locator('.file-actions');
  const triggerBounds = (await trigger.boundingBox())!;
  await trigger.click();
  const menu = page.getByRole('menu', { name: 'File actions', exact: true });
  const bounds = (await menu.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(12);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(1428);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(948);
  expect(
    bounds.y >= triggerBounds.y + triggerBounds.height + 5 ||
      bounds.y + bounds.height <= triggerBounds.y - 5 ||
      bounds.x + bounds.width <= triggerBounds.x - 5,
  ).toBe(true);
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 320, height: 568 });
  await page.getByRole('treeitem').last().locator('.file-actions').click();
  const phone = (await menu.boundingBox())!;
  expect(phone.x).toBeGreaterThanOrEqual(12);
  expect(phone.x + phone.width).toBeLessThanOrEqual(308);
  expect(phone.y).toBeGreaterThanOrEqual(0);
});

test('global settings save switches, selections, and completed text edits with failure recovery', async ({
  page,
}) => {
  const { calls, session } = await server(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settingsSection(page, 'Transfers');
  const folder = page.getByRole('textbox', { name: 'Download folder', exact: true });
  await folder.fill('/data/Movies');
  await page.waitForTimeout(450);
  expect(calls.some((c) => c.method === 'session-set')).toBe(false);
  await page.getByRole('heading', { name: 'Storage', exact: true }).click();
  await expect.poll(() => session['download-dir']).toBe('/data/Movies');
  await page.getByRole('switch', { name: 'Start automatically', exact: true }).check();
  await expect.poll(() => session['start-added-torrents']).toBe(true);
  await settingsSection(page, 'Network');
  await page.getByRole('combobox', { name: 'Encryption', exact: true }).selectOption('required');
  await expect.poll(() => session.encryption).toBe('required');
  await page.route(/\/rpc$/, async (route) => {
    const body = route.request().postDataJSON();
    if (body.method === 'session-set' && body.arguments.encryption === 'tolerated')
      await route.fulfill({ json: { result: 'Setting rejected', arguments: {} } });
    else await route.fallback();
  });
  await page.getByRole('combobox', { name: 'Encryption', exact: true }).selectOption('tolerated');
  await expect(page.getByRole('combobox', { name: 'Encryption', exact: true })).toHaveValue(
    'required',
  );
  await expect(page.locator('.toast')).toContainText('Could not save setting');
  await expect(page.locator('.settings-save-error')).toBeVisible();
  expect(calls.filter((c) => c.method === 'session-set').map((c) => c.arguments)).toEqual([
    { 'download-dir': '/data/Movies' },
    { 'start-added-torrents': true },
    { encryption: 'required' },
  ]);
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toHaveCount(0);
});

test('hover actions hide metrics without moving them', async ({ page }) => {
  await server(page);
  const row = page.getByTestId('torrent-row').first();
  const metrics = row.locator('.row-metrics');
  const before = await metrics.boundingBox();
  await row.hover();
  await expect(metrics).toHaveCSS('visibility', 'hidden');
  expect(await metrics.boundingBox()).toEqual(before);
});

test('peer headers sort in both directions and availability is vertically centered', async ({
  page,
}) => {
  const { torrents } = await server(page);
  const peers = torrents[0].peers!;
  peers.splice(2);
  peers[0].progress = 0.25;
  peers[1].progress = 1;
  peers[0].rateToClient = 100;
  peers[1].rateToClient = 200;
  peers[0].rateToPeer = 300;
  peers[1].rateToPeer = 50;
  await page.getByTestId('torrent-row').first().click();
  await page.getByRole('tab', { name: /^Peers/ }).click();
  await expect(page.locator('.peer-row')).toHaveCount(2);
  for (const [name, first] of [
    ['Has', peers[1]],
    ['Download', peers[1]],
    ['Upload', peers[0]],
  ] as const) {
    const header = page
      .getByRole('columnheader')
      .filter({ has: page.getByRole('button', { name, exact: true }) });
    await header.getByRole('button').click();
    await expect(header).toHaveAttribute('aria-sort', 'descending');
    await expect(page.locator('.peer-row').first()).toHaveAttribute(
      'data-peer',
      `${first.address}:${first.port}`,
    );
    await header.getByRole('button').click();
    await expect(header).toHaveAttribute('aria-sort', 'ascending');
    await expect(page.locator('.peer-row').last()).toHaveAttribute(
      'data-peer',
      `${first.address}:${first.port}`,
    );
  }
  const row = page.locator('.peer-row').first();
  const bounds = await row.boundingBox();
  const progress = await row.locator('.peer-progress').boundingBox();
  expect(
    Math.abs(progress!.y + progress!.height / 2 - (bounds!.y + bounds!.height / 2)),
  ).toBeLessThan(2);
});

test('queue menu shows positions and moves unfinished downloads only', async ({ page }) => {
  const { calls, torrents } = await server(page);
  await page.getByTestId('torrent-row').first().click({ button: 'right' });
  const queue = page.getByRole('group', { name: 'Download queue', exact: true });
  await expect(queue).toContainText(`#${torrents[0].queuePosition + 1}`);
  await expect(page.getByRole('group', { name: 'Bandwidth priority' })).toHaveCount(0);
  await queue.getByRole('button', { name: 'Move down', exact: true }).click();
  await expect
    .poll(() => calls.find((c) => c.method === 'queue-move-down')?.arguments.ids)
    .toEqual([1]);
  await page.getByTestId('torrent-row').last().click({ button: 'right' });
  await expect(queue).toHaveCount(0);
});

test('retry failed trackers with VPN is conditional and preserves labels', async ({ page }) => {
  const { torrents, calls } = await server(page);
  torrents[0].labels = ['Linux', 'router:full-speed'];
  torrents[0].trackerStats[0].announce = 'udp://tracker.example:1337/announce';
  torrents[0].trackerStats[0].lastAnnounceSucceeded = false;
  torrents[0].trackerStats[0].lastAnnounceTime = 1;
  await page.getByTestId('torrent-row').first().click();
  await page.getByRole('tab', { name: 'Trackers', exact: true }).click();
  const retry = page.getByRole('button', { name: 'Retry failed with VPN', exact: true });
  await expect(retry).toHaveCount(0);
  await page.route('**/full-speed.json*', (route) =>
    route.fulfill({
      json: {
        version: 1,
        fullSpeed: {
          enabled: true,
          label: 'router:full-speed',
          heartbeat: Date.now() / 1000,
          active: [],
        },
        trackerVpn: {
          enabled: true,
          available: true,
          interface: 'vpn-test',
          label: 'router:tracker-vpn-retry',
          heartbeat: Date.now() / 1000,
          active: [],
          retrying: [],
          routes: {},
          scope: 'udp-ipv4',
          endpoints: 0,
        },
      },
    }),
  );
  await expect(retry).toBeVisible({ timeout: 10000 });
  await retry.click();
  await expect
    .poll(
      () =>
        calls
          .filter(
            (c) =>
              c.method === 'torrent-set' &&
              c.arguments.labels?.includes('router:tracker-vpn-retry'),
          )
          .at(-1)?.arguments.labels,
    )
    .toEqual(['Linux', 'router:full-speed', 'router:tracker-vpn-retry']);
  await expect(retry).toBeDisabled();
  for (const tracker of torrents[0].trackerStats) tracker.lastAnnounceSucceeded = true;
  await expect(retry).toHaveCount(0, { timeout: 10000 });
});

test('download queue rank excludes completed torrents', async ({ page }) => {
  const { torrents } = await server(page);
  torrents[0].queuePosition = 5;
  for (const torrent of torrents.slice(1)) torrent.percentDone = 1;
  await page.getByTestId('torrent-row').first().click({ button: 'right' });
  const queue = page.getByRole('group', { name: 'Download queue', exact: true });
  await expect(queue.locator('b')).toHaveText('#1');
  for (const button of await queue.getByRole('button').all()) await expect(button).toBeDisabled();
});
