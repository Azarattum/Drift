import type { Peer } from './types';

export const peerKey = (peer: Peer) => `${peer.address}:${peer.port}`;
const positive = (value: number | undefined) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
export const peerRate = (peer: Peer) => positive(peer.rateToClient) + positive(peer.rateToPeer);

export function peerPlot(peers: Peer[], compact: boolean, chosen: string | null) {
  const limit = compact ? 8 : 12;
  const visible = [...peers]
    .sort((a, b) => peerRate(b) - peerRate(a) || peerKey(a).localeCompare(peerKey(b)))
    .slice(0, limit);
  const selected = peers.find((p) => peerKey(p) === chosen);
  if (selected && !visible.includes(selected)) visible[visible.length - 1] = selected;
  visible.sort((a, b) => peerKey(a).localeCompare(peerKey(b)));
  const maxRate = Math.max(1024, ...peers.map(peerRate));
  const maxBytes = Math.max(1, ...peers.map((p) => positive(p.bytes_to_client)));
  const center = compact ? 96 : 132;
  const outer = compact ? 70 : 105;
  const inner = compact ? 40 : 44;
  return visible.map((peer, i) => {
    const angle = (i / visible.length) * Math.PI * 2 - Math.PI / 2;
    const rate = peerRate(peer);
    const distance =
      outer - ((outer - inner) * Math.log1p(rate / 1024)) / Math.log1p(maxRate / 1024);
    const downloaded = positive(peer.bytes_to_client);
    return {
      peer,
      key: peerKey(peer),
      x: 160 + Math.cos(angle) * distance,
      y: center + Math.sin(angle) * distance,
      radius: Math.sqrt(9 + (187 * downloaded) / maxBytes),
      hasVolume: typeof peer.bytes_to_client === 'number' && Number.isFinite(peer.bytes_to_client),
    };
  });
}
