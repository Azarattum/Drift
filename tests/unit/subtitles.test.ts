import { expect, test } from 'bun:test';
import { fetchSubtitle, type SubtitleSource, subtitleLabel } from '../../src/lib/subtitles';

const source: SubtitleSource = {
  index: 1,
  label: 'en.sdh',
  language: 'en',
  src: 'http://router.local:9092/v1/subtitles/fixture/0/1',
};

test('subtitle labels preserve useful variants and use readable languages', () => {
  expect(subtitleLabel(source)).toBe('English · SDH');
  expect(subtitleLabel({ ...source, language: 'und', label: 'Commentary' })).toBe('Commentary');
});
test('subtitle fetch distinguishes download waits from capacity and rejects non-caption or oversized data', async () => {
  const original = globalThis.fetch;
  let response = () => new Response('', { status: 409 });
  globalThis.fetch = (async () => response()) as unknown as typeof fetch;
  const fetchTrack = () => fetchSubtitle(source, new AbortController().signal);
  try {
    expect(await fetchTrack()).toBe('downloading');
    response = () => new Response('', { status: 503 });
    expect(await fetchTrack()).toBe('busy');
    response = () =>
      new Response('<html>unsafe</html>', { headers: { 'Content-Type': 'text/html' } });
    await expect(fetchTrack()).rejects.toThrow('could not be loaded');
    response = () =>
      new Response(new Uint8Array(1024 * 1024 + 1), { headers: { 'Content-Type': 'text/vtt' } });
    await expect(fetchTrack()).rejects.toThrow('too large');
    response = () =>
      new Response('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n', {
        headers: { 'Content-Type': 'text/vtt' },
      });
    const blob = await fetchTrack();
    expect(blob instanceof Blob).toBe(true);
    if (blob instanceof Blob) expect(await blob.text()).toContain('Hello');
  } finally {
    globalThis.fetch = original;
  }
});
