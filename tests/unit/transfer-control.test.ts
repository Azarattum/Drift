import { expect, test } from 'bun:test';
import { transferControl } from '../../src/lib/transfer-control';

test('completed torrents control seeding rather than imply another download', () => {
  expect(transferControl({ status: 6, percentDone: 1 })).toEqual({
    method: 'torrent-stop',
    label: 'Stop seeding',
    icon: 'stop',
  });
  expect(transferControl({ status: 0, percentDone: 1 })).toEqual({
    method: 'torrent-start',
    label: 'Start seeding',
    icon: 'play',
  });
  expect(transferControl({ status: 4, percentDone: 0.5 }).label).toBe('Pause download');
  expect(transferControl({ status: 0, percentDone: 0.5 }).label).toBe('Resume download');
});
