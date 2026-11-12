import { expect, test } from 'bun:test';
import { peerKey, peerPlot } from '../../src/lib/peer-plot';
import { torrent } from '../fixtures';

test('peer distance uses live transfer speed and circle size uses downloaded bytes', () => {
  const peers = torrent()
    .peers!.slice(0, 3)
    .map((peer, i) => ({
      ...peer,
      rateToClient: [1000000, 10000, 0][i],
      rateToPeer: 0,
      bytes_to_client: [1000, 1000000000, 0][i],
    }));
  const nodes = peerPlot(peers, false, null);
  const distance = (i: number) => Math.hypot(nodes[i].x - 160, nodes[i].y - 132);
  expect(distance(0)).toBeLessThan(distance(1));
  expect(distance(1)).toBeLessThan(distance(2));
  expect(nodes[1].radius).toBeGreaterThan(nodes[0].radius);
  const upload = peerPlot([{ ...peers[0], rateToClient: 0, rateToPeer: 1000000 }], false, null)[0];
  expect(Math.hypot(upload.x - 160, upload.y - 132)).toBeCloseTo(distance(0));
  expect(peerPlot(peers, false, peerKey(peers[0]))[0].radius).toBe(nodes[0].radius);
});

test('peer positions survive response reordering and compact plots retain a selected peer', () => {
  const peers = torrent().peers!;
  expect(peerPlot(peers, false, null)).toEqual(peerPlot([...peers].reverse(), false, null));
  const many = Array.from({ length: 60 }, (_, i) => ({
    ...peers[0],
    address: `192.0.2.${i + 1}`,
    rateToClient: i * 1000,
  }));
  const selected = peerKey(many[0]);
  expect(peerPlot(many, true, selected)).toHaveLength(8);
  expect(peerPlot(many, true, selected).some((n) => n.key === selected)).toBe(true);
  expect(peerPlot(many, false, null)).toHaveLength(12);
});

test('idle and unavailable peer metrics produce honest finite geometry', () => {
  expect(peerPlot([], false, null)).toEqual([]);
  const peer = { ...torrent().peers![0], rateToClient: 0, rateToPeer: 0, bytes_to_client: 0 };
  const idle = peerPlot([peer], false, null)[0];
  expect(Math.hypot(idle.x - 160, idle.y - 132)).toBeCloseTo(105);
  expect(idle.hasVolume).toBe(true);
  const missing = peerPlot(
    [{ ...peer, bytes_to_client: undefined, rateToClient: Number.NaN }],
    true,
    null,
  )[0];
  expect(missing.hasVolume).toBe(false);
  expect(Number.isFinite(missing.x + missing.y + missing.radius)).toBe(true);
});
