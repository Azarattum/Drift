import { expect, test } from 'bun:test';
import {
  clock,
  playbackPosition,
  positionKey,
  prepareStream,
  savePosition,
  streamBase,
  videoFiles,
} from '../../src/lib/playback';

test('media URLs inherit the endpoint host and port without forwarding paths or secrets', () => {
  expect(streamBase('http://router.local:9091/transmission/rpc').href).toBe(
    'http://router.local:9092/',
  );
  expect(streamBase('http://[::1]:9091/custom/rpc').href).toBe('http://[::1]:9092/');
  expect(() => streamBase('http://user:secret@router.local:9091/transmission/rpc')).toThrow();
  expect(() => streamBase('http://router.local:65535/transmission/rpc')).toThrow();
  expect(streamBase('https://router.local:9091/transmission/rpc').href).toBe(
    'https://router.local:9092/',
  );
  expect(() => streamBase('file:///transmission/rpc')).toThrow();
});

test('playback preparation accepts only the selected file on the companion origin', async () => {
  const original = globalThis.fetch;
  const hash = 'a'.repeat(40);
  const path = `/v1/media/${hash}/2`;
  const ticket = 't'.repeat(43);
  let src = `${path}?ticket=${ticket}`;
  let tracks: unknown[] = [];
  let priority: unknown;
  globalThis.fetch = (async (url, init) => {
    expect(String(url)).toBe(`http://router.local:9092/v1/play/${hash}/2`);
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('include');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Basic fixture');
    return Response.json({ version: 1, src, subtitles: tracks, priority });
  }) as typeof fetch;
  const prepare = () =>
    prepareStream(
      'http://router.local:9091/transmission/rpc',
      hash,
      2,
      'Basic fixture',
      new AbortController().signal,
    );
  try {
    expect(await prepare()).toEqual({ src: `http://router.local:9092${src}`, subtitles: [] });
    priority = `/v1/priority/${hash}/2?ticket=${ticket}`;
    expect((await prepare()).priority).toBe(`http://router.local:9092${priority}`);
    for (const invalid of [
      'http://[',
      'http://other.local/priority',
      `/v1/priority/${hash}/3?ticket=${ticket}`,
    ]) {
      priority = invalid;
      expect((await prepare()).priority).toBeUndefined();
    }
    tracks = [
      { index: 4, label: 'en', language: 'en', src: `/v1/subtitles/${hash}/2/4?ticket=${ticket}` },
      {
        index: 5,
        label: 'bad',
        src: `http://other.local:9092/v1/subtitles/${hash}/2/5?ticket=${ticket}`,
      },
      { index: 6, label: 'bad', src: `/v1/subtitles/${hash}/3/6?ticket=${ticket}` },
      { index: 7, label: 'bad', src: `/v1/subtitles/${hash}/2/7?ticket=${'x'.repeat(43)}` },
    ];
    expect((await prepare()).subtitles).toEqual([
      {
        index: 4,
        label: 'en',
        language: 'en',
        src: `http://router.local:9092/v1/subtitles/${hash}/2/4?ticket=${ticket}`,
      },
    ]);
    for (const address of [
      `http://other.local:9092${path}`,
      `http://user:secret@router.local:9092${path}`,
      `/v1/media/${hash}/3`,
      `${path}?path=/etc/passwd`,
      `${path}?ticket=${ticket}&ticket=${ticket}`,
      `${path}#fragment`,
    ]) {
      src = address;
      await expect(prepare()).rejects.toThrow('invalid video address');
    }
  } finally {
    globalThis.fetch = original;
  }
});
test('file selection keeps real indices, natural episode order and video-only candidates', () => {
  const files = videoFiles([
    { name: 'notes.txt', length: 5, bytesCompleted: 5 },
    { name: 'episode10.MKV', length: 10, bytesCompleted: 0 },
    { name: 'episode2.mp4', length: 10, bytesCompleted: 10 },
    { name: 'zero.mp4', length: 0, bytesCompleted: 0 },
  ]);
  expect(files.map((f) => f.index)).toEqual([2, 1]);
  expect(clock(3601)).toBe('1:00:01');
  expect(clock(NaN)).toBe('0:00');
});
test('positions survive blocked storage and remain scoped to server, hash and file', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('blocked');
    },
  });
  try {
    const file = { index: 1, name: 'video.mp4', length: 100, bytesCompleted: 100 };
    const key = positionKey('http://router.local:9091/transmission/rpc', 'a'.repeat(40), file);
    savePosition(key, 25, 100);
    expect(playbackPosition(key)?.time).toBe(25);
    expect(
      playbackPosition(
        positionKey('http://other.local:9091/transmission/rpc', 'a'.repeat(40), file),
      ),
    ).toBeNull();
    savePosition(key, 99, 100);
    expect(playbackPosition(key)).toBeNull();
    savePosition(key, Infinity, 100);
    expect(playbackPosition(key)).toBeNull();
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
