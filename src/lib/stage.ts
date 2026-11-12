import type { Torrent } from './types';
export type Stage = {
  label: string;
  detail: string;
  tone: 'neutral' | 'blue' | 'green' | 'amber' | 'red';
  active: boolean;
  progress?: number;
};
export function stage(t: Torrent, now = Date.now() / 1000): Stage {
  const trackers = t.trackerStats || [];
  const peers = t.peersConnected || 0;
  const unreachable =
    trackers.length > 0 &&
    trackers.every((x) => x.lastAnnounceTime > 0 && !x.lastAnnounceSucceeded);
  if (t.error === 3)
    return {
      label: 'Download blocked',
      detail: t.errorString || 'Check storage and permissions',
      tone: 'red',
      active: false,
    };
  if (t.status === 0)
    return {
      label: t.percentDone === 1 ? 'Completed' : 'Paused',
      detail: t.percentDone === 1 ? 'All selected files downloaded' : 'Resume to continue',
      tone: 'neutral',
      active: false,
      progress: t.percentDone,
    };
  if (t.status === 1)
    return {
      label: 'Queued for check',
      detail: 'Waiting for a verification slot',
      tone: 'neutral',
      active: false,
    };
  if (t.status === 2)
    return {
      label: 'Checking files',
      detail: `${Math.round((t.recheckProgress || 0) * 100)}% verified`,
      tone: 'blue',
      active: true,
      progress: t.recheckProgress,
    };
  if (t.status === 3 || t.status === 5)
    return {
      label: t.status === 3 ? 'Queued' : 'Queued to seed',
      detail: 'Waiting for a transfer slot',
      tone: 'neutral',
      active: false,
      progress: t.percentDone,
    };
  if (t.metadataPercentComplete < 1) {
    if (peers)
      return {
        label: 'Fetching metadata',
        detail: `${peers} peer${peers === 1 ? '' : 's'} connected · receiving file list`,
        tone: 'blue',
        active: true,
        progress: t.metadataPercentComplete || undefined,
      };
    if (unreachable)
      return {
        label: 'Trackers unreachable',
        detail:
          trackers[0]?.lastAnnounceResult ||
          'Peer discovery is blocked. Check trackers and connectivity.',
        tone: 'amber',
        active: true,
      };
    const waiting = t.isStalled || (t.startDate > 0 && now - t.startDate > 90);
    return {
      label: waiting ? 'Waiting for peers' : 'Finding peers',
      detail: waiting
        ? 'No reachable peers yet · discovery continues'
        : trackers.some((x) => x.announceState === 3)
          ? 'Announcing to trackers · discovering peers'
          : 'Discovering peers to retrieve the file list',
      tone: waiting ? 'amber' : 'blue',
      active: true,
    };
  }
  if (t.status === 6)
    return {
      label: 'Seeding',
      detail:
        t.rateUpload > 0
          ? `Sharing with ${t.peersGettingFromUs || 1} peer${t.peersGettingFromUs === 1 ? '' : 's'}`
          : 'Complete · available to other peers',
      tone: 'green',
      active: t.rateUpload > 0,
      progress: 1,
    };
  if (t.rateDownload > 0)
    return {
      label: 'Downloading',
      detail:
        t.webseedsSendingToUs > 0
          ? `Receiving data from ${t.webseedsSendingToUs} web seed${t.webseedsSendingToUs === 1 ? '' : 's'}`
          : peers > 0
            ? `${t.peersSendingToUs || 1} of ${peers} peers sending data`
            : 'Receiving file data',
      tone: 'blue',
      active: true,
      progress: t.percentDone,
    };
  if (unreachable && !peers)
    return {
      label: 'Trackers unreachable',
      detail: trackers[0]?.lastAnnounceResult || 'Unable to discover peers',
      tone: 'amber',
      active: true,
      progress: t.percentDone,
    };
  if (!peers)
    return {
      label: t.isStalled ? 'No reachable peers' : 'Connecting to peers',
      detail: 'Peer discovery continues · no data source connected',
      tone: t.isStalled ? 'amber' : 'blue',
      active: true,
      progress: t.percentDone || undefined,
    };
  if (t.desiredAvailable === 0 && t.leftUntilDone > 0)
    return {
      label: 'Waiting for pieces',
      detail: 'Connected peers do not have the remaining pieces',
      tone: 'amber',
      active: true,
      progress: t.percentDone,
    };
  return {
    label: 'Waiting for data',
    detail: `${peers} peer${peers === 1 ? '' : 's'} connected · no pieces arriving yet`,
    tone: 'amber',
    active: true,
    progress: t.percentDone,
  };
}
