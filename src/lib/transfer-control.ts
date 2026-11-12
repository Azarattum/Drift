import type { Torrent } from './types';

export function transferControl(t: Pick<Torrent, 'status' | 'percentDone'>) {
  const stopped = t.status === 0;
  const complete = t.percentDone >= 1;
  return {
    method: stopped ? 'torrent-start' : 'torrent-stop',
    label: complete
      ? stopped
        ? 'Start seeding'
        : 'Stop seeding'
      : stopped
        ? 'Resume download'
        : 'Pause download',
    icon: stopped ? 'play' : complete ? 'stop' : 'pause',
  } as const;
}
