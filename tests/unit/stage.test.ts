import { describe, expect, test } from 'bun:test';
import { fileTree, flatten } from '../../src/lib/files';
import { bytes, duration } from '../../src/lib/format';
import { stage } from '../../src/lib/stage';
import { torrent } from '../fixtures';

describe('truthful transfer stages', () => {
  test('metadata discovery never pretends to download a zero-sized file', () => {
    const s = stage(
      torrent({ metadataPercentComplete: 0, rateDownload: 0, peersConnected: 0, startDate: 10 }),
      30,
    );
    expect(s.label).toBe('Finding peers');
    expect(s.progress).toBeUndefined();
    expect(s.active).toBe(true);
  });
  test('metadata arrives independently of file progress', () => {
    expect(stage(torrent({ metadataPercentComplete: 0.4, percentDone: 0 })).label).toBe(
      'Fetching metadata',
    );
  });
  test('checking uses verification progress', () => {
    expect(stage(torrent({ status: 2, recheckProgress: 0.6, percentDone: 0.1 })).progress).toBe(
      0.6,
    );
  });
  test('missing pieces and unreachable peers are distinguished', () => {
    expect(stage(torrent({ rateDownload: 0, desiredAvailable: 0 })).label).toBe(
      'Waiting for pieces',
    );
    expect(stage(torrent({ rateDownload: 0, peersConnected: 0, isStalled: true })).label).toBe(
      'No reachable peers',
    );
  });
  test('tracker failure is not called stalled when pieces are arriving', () => {
    const t = torrent();
    t.trackerStats[0].lastAnnounceSucceeded = false;
    expect(stage(t).label).toBe('Downloading');
  });
  test('storage errors override activity', () => {
    expect(stage(torrent({ error: 3, errorString: 'Permission denied' })).detail).toBe(
      'Permission denied',
    );
  });
  test('paused complete torrents are completed, not seeding', () => {
    expect(stage(torrent({ status: 0, percentDone: 1 })).label).toBe('Completed');
  });
});
test('file tree retains real file indices, nested folder aggregates, and collapse', () => {
  const t = torrent();
  const tree = fileTree(t.files!);
  expect(tree[0].ids).toEqual([0, 1, 2]);
  expect(tree[0].length).toBe(5900011000);
  expect(tree[0].children[0].name).toBe('Docs');
  expect(flatten(tree, new Set(['Ubuntu 24.04']))).toHaveLength(1);
  expect(flatten(tree, new Set())).toHaveLength(5);
});
test('formatting handles unknown and invalid data', () => {
  expect(bytes(Number.NaN)).toBe('0 B');
  expect(duration(-1)).toBe('—');
  expect(duration(3600)).toBe('1h 0m');
});
