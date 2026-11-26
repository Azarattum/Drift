import { expect, test } from 'bun:test';
import { matroskaTracks, needsAudioDecoder, probeMatroskaTracks } from '../../src/lib/media-format';

test('finds DTS in a real Matroska header, without scanning clusters', async () => {
  const bytes = new Uint8Array(await Bun.file('tests/assets/playback-dts.mkv').arrayBuffer());
  expect(matroskaTracks(bytes.subarray(0, 65536)).find((track) => track.type === 2)?.codec).toBe(
    'A_DTS',
  );
  for (const length of [0, 1, 4, 16, 40])
    expect(matroskaTracks(bytes.subarray(0, length))).toEqual([]);
  expect(matroskaTracks(new Uint8Array(200).fill(255))).toEqual([]);
  expect(matroskaTracks(new Uint8Array(200))).toEqual([]);
});

test('reads the language and kind of embedded audio and subtitle tracks', async () => {
  const file = Bun.file('tests/assets/playback-embedded.mkv');
  const header = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
  expect(
    matroskaTracks(header)
      .filter((track) => track.type !== 1)
      .map(({ codec, language, number, label }) => [codec, language, number, label]),
  ).toEqual([
    ['A_AAC', 'jpn', 2, ''],
    ['A_AAC', 'eng', 3, ''],
    ['S_TEXT/UTF8', 'eng', 4, 'English [Embedded]'],
  ]);
});

test('native AC3 support is respected and ordinary audio does not request a decoder', () => {
  const native = { canPlayType: () => 'probably' } as unknown as HTMLVideoElement;
  const unsupported = { canPlayType: () => '' } as unknown as HTMLVideoElement;
  expect(needsAudioDecoder('A_DTS', native)).toBe(false);
  expect(needsAudioDecoder('A_DTS', unsupported)).toBe(true);
  expect(needsAudioDecoder('A_AC3', native)).toBe(false);
  expect(needsAudioDecoder('A_AC3', unsupported)).toBe(true);
  expect(needsAudioDecoder('A_AAC', unsupported)).toBe(false);
  expect(needsAudioDecoder(undefined, unsupported)).toBe(false);
});

test('a server ignoring Range cannot make the header probe download a whole movie', async () => {
  const original = globalThis.fetch;
  let cancelled = false;
  let pulls = 0;
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array(65536));
        },
        cancel() {
          cancelled = true;
        },
      }),
    )) as unknown as typeof fetch;
  try {
    expect(await probeMatroskaTracks('http://fixture/media', new AbortController().signal)).toEqual(
      [],
    );
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(2);
  } finally {
    globalThis.fetch = original;
  }
});
