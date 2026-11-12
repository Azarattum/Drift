import { expect, test } from 'bun:test';
import { historySamples, mergeSamples } from '../../src/lib/history';

test('history accepts real zero rates and rejects malformed, stale, or future samples', () => {
  const now = Date.now();
  expect(
    historySamples(
      {
        version: 1,
        samples: [
          [now - 10000, 0, 0],
          [now - 5000, 4096, 512],
          [now + 90000, 1, 1],
          [now, -1, 2],
          ['bad', 2, 3],
        ],
      },
      now,
    ),
  ).toEqual([
    { at: now - 10000, down: 0, up: 0 },
    { at: now - 5000, down: 4096, up: 512 },
  ]);
  expect(historySamples({ version: 1, samples: Array(5001).fill([now, 0, 0]) }, now)).toBeNull();
  expect(historySamples({ samples: [] }, now)).toBeNull();
});
test('reconnecting merges history chronologically without fabricating missing samples', () => {
  const now = Date.now();
  expect(
    mergeSamples(
      [
        { at: now - 5000, down: 2, up: 0 },
        { at: now - 4000000, down: 5, up: 0 },
      ],
      [
        { at: now - 20000, down: 1, up: 0 },
        { at: now - 5000, down: 3, up: 1 },
      ],
      now,
    ),
  ).toEqual([
    { at: now - 20000, down: 1, up: 0 },
    { at: now - 5000, down: 3, up: 1 },
  ]);
});
