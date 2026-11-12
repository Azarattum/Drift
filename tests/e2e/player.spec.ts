import { readFile } from 'node:fs/promises';
import { expect, type Page, test } from '@playwright/test';
import { torrent } from '../fixtures';

const media = await readFile('tests/assets/playback.mp4');
async function setup(
  page: Page,
  options: { multiple?: boolean; unavailable?: boolean; invalidMedia?: boolean } = {},
) {
  const t = torrent({
    name: 'Northern Light',
    percentDone: 1,
    status: 0,
    files: [
      {
        name: 'Northern Light/01 - The coast.mp4',
        length: media.length,
        bytesCompleted: media.length,
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
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
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
  await page.getByRole('button', { name: 'Watch video', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Pick up where you left off' })).toBeVisible();
  await page.getByRole('button', { name: 'Resume from 0:25' }).click();
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
  await setup(page, { unavailable: true });
  await expect(page.getByRole('alert')).toContainText('The media service is not available');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
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
