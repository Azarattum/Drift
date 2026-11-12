import { expect, test } from 'bun:test';
import { magnetLink, normalizeMagnetLink } from '../../src/lib/clipboard';
import { torrent } from '../fixtures';

const hash = 'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c';
test('generated magnets preserve literal topic delimiters and encode names and trackers', () => {
  const t = torrent({
    hashString: hash,
    name: 'Video & extras + subtitles',
    magnetLink: undefined,
  });
  const link = magnetLink(t);
  expect(link.startsWith(`magnet:?xt=urn:btih:${hash}&`)).toBe(true);
  const params = new URL(link).searchParams;
  expect(params.get('dn')).toBe(t.name);
  expect(params.getAll('tr')).toEqual(t.trackerStats.map((tracker) => tracker.announce));
});
test('previously copied encoded topics and cached magnets are normalized without changing trackers', () => {
  const link = `magnet:?xt=urn%3Abtih%3A${hash}&dn=Big+Buck+Bunny&tr=udp%3A%2F%2Ftracker.example%3A1337`;
  const expected = link.replace(`urn%3Abtih%3A${hash}`, `urn:btih:${hash}`);
  expect(normalizeMagnetLink(link)).toBe(expected);
  expect(magnetLink(torrent({ magnetLink: link }))).toBe(expected);
  expect(normalizeMagnetLink(expected)).toBe(expected);
  expect(normalizeMagnetLink('magnet:?xt=%ZZ')).toBe('magnet:?xt=%ZZ');
});
