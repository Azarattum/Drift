import { expect, test } from 'bun:test';
import {
  matroskaAudioCodec,
  needsAudioDecoder,
  probeMatroskaAudio,
} from '../../src/lib/media-format';

test('finds DTS in a real Matroska header, without scanning clusters', async () => {
  const bytes = new Uint8Array(await Bun.file('tests/assets/playback-dts.mkv').arrayBuffer());
  expect(matroskaAudioCodec(bytes.subarray(0, 65536))).toBe('A_DTS');
  for (const length of [0, 1, 4, 16, 40])
    expect(matroskaAudioCodec(bytes.subarray(0, length))).toBeUndefined();
  expect(matroskaAudioCodec(new Uint8Array(200).fill(255))).toBeUndefined();
  expect(matroskaAudioCodec(new Uint8Array(200))).toBeUndefined();
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
    expect(
      await probeMatroskaAudio('http://fixture/media', new AbortController().signal),
    ).toBeUndefined();
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(2);
  } finally {
    globalThis.fetch = original;
  }
});
