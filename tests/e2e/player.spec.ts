import { readFile } from 'node:fs/promises';
import { expect, type Page, test } from '@playwright/test';
import { torrent } from '../fixtures';

const media = await readFile('tests/assets/playback.mp4');
async function setup(
  page: Page,
  options: {
    multiple?: boolean;
    unavailable?: boolean;
    invalidMedia?: boolean;
    partial?: boolean;
  } = {},
) {
  const t = torrent({
    name: 'Northern Light',
    percentDone: 1,
    status: 0,
    files: [
      {
        name: 'Northern Light/01 - The coast.mp4',
        length: media.length,
        bytesCompleted: options.partial ? Math.floor(media.length * 0.8) : media.length,
      },
      ...(options.multiple
        ? [
            {
              name: 'Northern Light/02 - Into the woods.mp4',
              length: media.length,
              bytesCompleted: media.length,
            },
          ]
        : []),
    ],
  });
  const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
  await page.route('**/full-speed.json*', (route) => route.fulfill({ status: 404 }));
  await page.route(/\/rpc$/, async (route) => {
    const body = route.request().postDataJSON();
    let args = {};
    if (body.method === 'session-get') args = { 'rpc-version': 18, version: '4.1.3' };
    if (body.method === 'torrent-get') args = { torrents: [t] };
    if (body.method === 'session-stats') args = { downloadSpeed: 0, uploadSpeed: 0 };
    await route.fulfill({ json: { result: 'success', arguments: args } });
  });
  await page.route('**/v1/**', async (route) => {
    calls.push({
      url: route.request().url(),
      method: route.request().method(),
      headers: await route.request().allHeaders(),
    });
    if (options.unavailable) return route.abort();
    const path = new URL(route.request().url()).pathname;
    const headers = {
      'Access-Control-Allow-Origin': 'http://127.0.0.1:5178',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Headers': 'X-Drift-Stream, Range, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
    };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (path.includes('/play/'))
      return route.fulfill({
        json: {
          version: 1,
          src: `${path.replace('/play/', '/media/')}?ticket=${'t'.repeat(43)}`,
          type: 'video/mp4',
          length: media.length,
        },
        headers: {
          ...headers,
          'Set-Cookie': `drift_media=fixture-session; Path=${path.replace('/play/', '/media/')}; HttpOnly; SameSite=Strict`,
        },
      });
    if (new URL(route.request().url()).searchParams.get('ticket') !== 't'.repeat(43))
      return route.fulfill({ status: 401, headers });
    if (options.invalidMedia)
      return route.fulfill({
        body: Buffer.from('invalid video data'),
        headers: { ...headers, 'Content-Type': 'video/mp4' },
      });
    const range = route
      .request()
      .headers()
      .range?.match(/bytes=(\d+)-(\d*)/);
    const start = range ? Number(range[1]) : 0,
      end = range?.[2] ? Math.min(media.length - 1, Number(range[2])) : media.length - 1;
    await route.fulfill({
      status: range ? 206 : 200,
      body: media.subarray(start, end + 1),
      headers: {
        ...headers,
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${media.length}` } : {}),
      },
    });
  });
  await page.goto('/');
  await expect(page.locator('.torrent-row')).toHaveCount(1);
  await page.locator('.torrent-row').click();
  await page.getByRole('button', { name: 'Watch video', exact: true }).click();
  return { t, calls };
}

test('real playback, Video.js controls, resume, keyboard and close cleanup', async ({ page }) => {
  const { calls } = await setup(page);
  const video = page.locator('.drift-player video');
  await expect(video).toBeVisible();
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThanOrEqual(2);
  await video.click({ position: { x: 90, y: 70 } });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await video.click({ position: { x: 90, y: 70 } });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.locator('.watch-big-play')).toBeVisible();
  const alignment = await page.locator('.watch-big-play').evaluate((button) => {
    const b = button.getBoundingClientRect();
    const icon = button.querySelector('svg')!.getBoundingClientRect();
    return {
      x: icon.x + icon.width / 2 - (b.x + b.width / 2),
      y: icon.y + icon.height / 2 - (b.y + b.height / 2),
    };
  });
  expect(alignment.x).toBeCloseTo(0, 1);
  expect(alignment.y).toBeCloseTo(0, 1);
  await page.getByRole('button', { name: 'Seek forward 10 seconds', exact: true }).click();
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThan(9);
  await page.getByRole('button', { name: 'Seek forward 10 seconds', exact: true }).click();
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThan(19);
  await page.getByRole('button', { name: 'Seek backward 10 seconds', exact: true }).click();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeLessThan(12);
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', colorScheme);
    const colors = await page.evaluate(() => ({
      controls: getComputedStyle(document.querySelector('.watch-controls')!).backgroundColor,
      header: getComputedStyle(document.querySelector('.player-dialog .modal-header')!)
        .backgroundColor,
    }));
    expect(colors.controls).toBe(colors.header);
    await page.screenshot({ path: `test-results/player-themed-${colorScheme}.png` });
  }
  await page.screenshot({ path: 'test-results/player-desktop.png' });
  await video.evaluate((v: HTMLVideoElement) => {
    v.currentTime = 25;
  });
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThan(24);
  await page.getByRole('combobox', { name: 'Playback speed' }).selectOption('1.5');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.playbackRate)).toBe(1.5);
  await page.getByRole('button', { name: 'Mute', exact: true }).click();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.muted)).toBe(true);
  await video.evaluate((v: HTMLVideoElement) => v.addTextTrack('subtitles', 'English', 'en'));
  await page.getByRole('button', { name: 'Subtitles', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'English', exact: true }).click();
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.textTracks[0]?.mode))
    .toBe('showing');
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect(video).toHaveCount(0);
  let releaseMedia!: () => void;
  const metadataGate = new Promise<void>((resolve) => {
    releaseMedia = resolve;
  });
  await page.route('**/v1/media/**', async (route) => {
    if (route.request().method() === 'GET') await metadataGate;
    await route.fallback();
  });
  await page.getByRole('button', { name: 'Watch video', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Pick up where you left off' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume from 0:25' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Start over', exact: true })).toBeEnabled();
  const resumeGeometry = await page.locator('.watch-canvas').evaluate((canvas) => {
    const bounds = canvas.getBoundingClientRect();
    const overlay = canvas.querySelector('.watch-resume')!.getBoundingClientRect();
    return {
      uncovered: bounds.bottom - overlay.bottom,
      controls: getComputedStyle(canvas.querySelector('.watch-controls')!).display,
    };
  });
  expect(resumeGeometry.uncovered).toBeCloseTo(0, 0);
  expect(resumeGeometry.controls).toBe('none');
  await page.getByRole('button', { name: 'Resume from 0:25' }).click();
  await expect(page.getByRole('heading', { name: 'Pick up where you left off' })).toHaveCount(0);
  releaseMedia();
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThan(24);
  await page.locator('.watch-heading h3').click();
  await page.keyboard.press('k');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('.player-dialog')).toHaveCount(0);
  expect(calls.some((c) => c.method === 'POST' && c.headers['x-drift-stream'] === '1')).toBe(true);
});

test('fullscreen fills the video area and overlays controls that hide and wake on activity', async ({
  page,
}) => {
  await setup(page);
  const enabled = await page.evaluate(
    () =>
      document.fullscreenEnabled ||
      (document as Document & { webkitFullscreenEnabled?: boolean }).webkitFullscreenEnabled,
  );
  test.skip(!enabled, 'This browser uses native video fullscreen instead of element fullscreen');
  const video = page.locator('.drift-player video');
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThanOrEqual(2);
  await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).click();
  const canvas = page.locator('.watch-canvas');
  const controls = page.locator('.watch-controls');
  await expect(canvas).toHaveClass(/watch-fullscreen/);
  const geometry = await canvas.evaluate((el) => {
    const v = el.querySelector('video')!.getBoundingClientRect();
    const c = el.querySelector('.watch-controls')!.getBoundingClientRect();
    return {
      videoTop: v.top,
      videoBottom: v.bottom,
      videoWidth: v.width,
      viewportHeight: innerHeight,
      viewportWidth: innerWidth,
      controlsTop: c.top,
      controlsBottom: c.bottom,
    };
  });
  expect(geometry.videoTop).toBeCloseTo(0, 0);
  expect(geometry.videoBottom).toBeCloseTo(geometry.viewportHeight, 0);
  expect(geometry.videoWidth).toBeCloseTo(geometry.viewportWidth, 0);
  expect(geometry.controlsTop).toBeLessThan(geometry.videoBottom);
  expect(geometry.controlsBottom).toBeCloseTo(geometry.videoBottom, 0);
  await page.mouse.move(120, 100);
  await expect(controls).toHaveCSS('opacity', '0', { timeout: 5000 });
  await page.mouse.move(180, 100);
  await expect(controls).toHaveCSS('opacity', '1');
  await video.click({ position: { x: 90, y: 70 } });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await page.waitForTimeout(2300);
  await expect(controls).toHaveCSS('opacity', '1');
  await video.click({ position: { x: 90, y: 70 } });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
  await page.getByRole('button', { name: 'Pause', exact: true }).focus();
  await page.keyboard.press('Tab');
  await page.waitForTimeout(2300);
  await expect(controls).toHaveCSS('opacity', '1');
  await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
  await expect(canvas).not.toHaveClass(/watch-fullscreen/);
});

test('buffering describes a browser wait without guessing which torrent bytes are missing', async ({
  page,
}) => {
  await setup(page, { partial: true });
  const video = page.locator('.drift-player video');
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThanOrEqual(3);
  await video.evaluate((v: HTMLVideoElement) => {
    v.dispatchEvent(new Event('waiting'));
    v.dispatchEvent(new Event('canplay'));
  });
  await page.waitForTimeout(450);
  await expect(page.locator('.watch-buffering')).toHaveCount(0);
  await video.evaluate((v: HTMLVideoElement) => {
    Object.defineProperty(v, 'readyState', { configurable: true, value: 2 });
    v.dispatchEvent(new Event('waiting'));
  });
  await expect(page.locator('.watch-buffering')).toHaveText('Buffering…');
  await video.evaluate((v: HTMLVideoElement) => {
    Reflect.deleteProperty(v, 'readyState');
    v.dispatchEvent(new Event('canplay'));
  });
  await expect(page.locator('.watch-buffering')).toHaveCount(0);
});

test('a stuck stream reconnects and continues at the same position without a resume prompt', async ({
  page,
}) => {
  const { calls } = await setup(page);
  const video = page.locator('.drift-player video');
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThanOrEqual(3);
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
  await page.clock.install();
  await video.evaluate((v: HTMLVideoElement) => {
    Object.defineProperty(v, 'readyState', { configurable: true, value: 2 });
    Object.defineProperty(v, 'currentTime', { configurable: true, value: 25 });
    v.dispatchEvent(new Event('waiting'));
  });
  await page.clock.fastForward(8500);
  await expect.poll(() => calls.filter((c) => c.method === 'POST').length).toBe(2);
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThan(24);
  await expect(page.getByRole('heading', { name: 'Pick up where you left off' })).toHaveCount(0);
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
});

test('multiple files, matching mobile theme, file switching and touch targets', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await setup(page, { multiple: true });
  await expect(page.getByRole('region', { name: 'Video files' })).toBeVisible();
  await page.getByRole('button', { name: /01 - The coast/ }).click();
  await expect(page.locator('.drift-player')).toBeVisible();
  await page.getByRole('button', { name: 'Show video files' }).click();
  await page.getByRole('button', { name: /02 - Into the woods/ }).click();
  await expect(page.locator('.watch-heading h3')).toHaveText('02 - Into the woods.mp4');
  expect(
    await page.locator('.player-dialog').evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  ).toBe(true);
  await page.screenshot({ path: 'test-results/player-mobile.png' });
  const targets = await page
    .locator('.watch-control-row [role="button"]:visible')
    .evaluateAll((els) =>
      els.map((el) => ({
        label: el.getAttribute('aria-label'),
        w: el.getBoundingClientRect().width,
        h: el.getBoundingClientRect().height,
      })),
    );
  expect(targets.length).toBeGreaterThan(1);
  for (const t of targets) {
    expect(t.w, t.label || 'control').toBeGreaterThanOrEqual(44);
    expect(t.h, t.label || 'control').toBeGreaterThanOrEqual(44);
  }
});

test('unavailable service has a useful retry state without losing the library', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await setup(page, { unavailable: true });
  await expect(page.getByRole('alert')).toContainText('The media service is not available');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(page.locator('.player-dialog')).toHaveCSS('opacity', '1');
  for (const width of [1104, 375]) {
    await page.setViewportSize({ width, height: 800 });
    const spacing = await page.locator('.player-dialog .modal-header').evaluate((header) => {
      const bounds = header.getBoundingClientRect();
      const close = header.querySelector('button')!.getBoundingClientRect();
      const label = header.querySelector('h2')!.getBoundingClientRect();
      return {
        top: close.top - bounds.top,
        bottom: bounds.bottom - close.bottom,
        left: label.left - bounds.left,
        right: bounds.right - close.right,
        width: close.width,
        height: close.height,
      };
    });
    expect(spacing.top).toBeGreaterThanOrEqual(8);
    expect(spacing.bottom).toBeGreaterThanOrEqual(8);
    expect(spacing.right).toBeCloseTo(spacing.left, 0);
    expect(spacing.width).toBeGreaterThanOrEqual(44);
    expect(spacing.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: `test-results/player-error-dark-${width}.png` });
  }
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.locator('.torrent-row')).toHaveCount(1);
});

test('unsupported media explains the browser limitation and preserves a retry path', async ({
  page,
}) => {
  await setup(page, { invalidMedia: true });
  await expect(page.getByRole('alert')).toContainText(
    'This video format can’t play in this browser',
  );
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});

test('video hover action opens the player without selecting the torrent', async ({ page }) => {
  await setup(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('.player-dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close inspector', exact: true }).click();
  const row = page.getByTestId('torrent-row').first();
  await row.hover();
  const watch = row.getByRole('button', { name: 'Watch video for Northern Light', exact: true });
  await expect(watch).toBeVisible();
  await watch.click();
  await expect(page.locator('.player-dialog')).toBeVisible();
  await expect(page.locator('.inspector')).toHaveCount(0);
});

test('player fits available dialog height without scrolling at short viewport sizes', async ({
  page,
}) => {
  await setup(page);
  await expect(page.locator('.drift-player video')).toBeVisible();
  for (const viewport of [
    { width: 1120, height: 896 },
    { width: 1440, height: 800 },
    { width: 900, height: 500 },
    { width: 375, height: 667 },
  ]) {
    await page.setViewportSize(viewport);
    await expect
      .poll(() =>
        page
          .locator('.player-dialog')
          .evaluate((dialog) => dialog.scrollHeight - dialog.clientHeight),
      )
      .toBeLessThanOrEqual(1);
    const controls = await page.locator('.watch-controls').boundingBox();
    expect(controls!.y + controls!.height).toBeLessThanOrEqual(viewport.height);
  }
});

test('mobile player keeps download status on one line and centered beside file info', async ({
  page,
}) => {
  await setup(page);
  await expect(page.locator('.drift-player video')).toBeVisible();
  for (const width of [320, 360, 390, 430]) {
    await page.setViewportSize({ width, height: 760 });
    const status = await page.locator('.watch-header-status').boundingBox();
    const info = await page.locator('.watch-heading > div').boundingBox();
    const download = await page.locator('.watch-download').boundingBox();
    expect(download!.height).toBeLessThanOrEqual(21);
    expect(Math.abs(status!.y + status!.height / 2 - info!.y - info!.height / 2)).toBeLessThan(2);
    expect(status!.x + status!.width).toBeLessThanOrEqual(width - 16);
  }
});
