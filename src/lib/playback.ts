import { preference, savePreference } from './preferences';
import type { SubtitleSource } from './subtitles';
import type { TorrentFile } from './types';
export type PreparedStream = { src: string; subtitles: SubtitleSource[]; priority?: string };

export const videoPattern = /\.(mp4|m4v|mov|mkv|webm|avi|ts|m2ts|mts)$/i;
export type VideoFile = TorrentFile & { index: number };
export function videoFiles(files: TorrentFile[] = []): VideoFile[] {
  return files
    .flatMap((file, index) =>
      videoPattern.test(file.name) && file.length > 0 ? [{ ...file, index }] : [],
    )
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}
export function streamBase(endpoint: string): URL {
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Streaming needs an HTTP or HTTPS connection to your Transmission device.');
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (port >= 65535) throw new Error('The media service address is unavailable.');
  url.port = String(port + 1);
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url;
}
export function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const n = Math.floor(seconds),
    h = Math.floor(n / 3600),
    m = Math.floor(n / 60) % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`
    : `${m}:${String(n % 60).padStart(2, '0')}`;
}
type PlaybackAudio = { volume: number; muted: boolean };
let audio: PlaybackAudio = { volume: 1, muted: false };
const audioKey = 'drift.playback.audio.v1';
export function playbackAudio(): PlaybackAudio {
  try {
    const stored = JSON.parse(preference(audioKey) || 'null');
    if (
      stored &&
      Number.isFinite(stored.volume) &&
      stored.volume >= 0 &&
      stored.volume <= 1 &&
      typeof stored.muted === 'boolean'
    )
      audio = { volume: stored.volume, muted: stored.muted };
  } catch {
    // Keep the session's audio settings when storage is unavailable or malformed.
  }
  return { ...audio };
}
export function savePlaybackAudio(volume: number, muted: boolean): void {
  if (!Number.isFinite(volume) || volume < 0 || volume > 1) return;
  audio = { volume, muted };
  savePreference(audioKey, JSON.stringify(audio));
}

export type PlaybackPosition = { time: number; duration: number; updated: number };
const storageKey = 'drift.playback.v1';
let memory: Record<string, PlaybackPosition> = {};
function positions(): Record<string, PlaybackPosition> {
  try {
    const stored = preference(storageKey);
    if (stored === null) return memory;
    const raw: unknown = JSON.parse(stored);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      memory = Object.fromEntries(
        Object.entries(raw)
          .filter(
            ([, p]) =>
              p &&
              typeof p === 'object' &&
              Number.isFinite(p.time) &&
              p.time >= 0 &&
              Number.isFinite(p.duration) &&
              p.duration > 0 &&
              p.time <= p.duration &&
              Number.isFinite(p.updated),
          )
          .slice(-100),
      );
    }
  } catch {
    /* Keep the session's positions when storage is unavailable or malformed. */
  }
  return memory;
}
export function positionKey(endpoint: string, hash: string, file: VideoFile): string {
  return JSON.stringify([new URL(endpoint).href, hash.toLowerCase(), file.index, file.length]);
}
export function playbackPosition(key: string): PlaybackPosition | null {
  const p = positions()[key];
  return p && p.time >= 5 && p.duration - p.time > 10 ? p : null;
}
export function savePosition(key: string, time: number, duration: number): void {
  if (!Number.isFinite(time) || !Number.isFinite(duration) || time < 0 || duration <= 0) return;
  const entries = positions();
  entries[key] = { time: Math.min(time, duration), duration, updated: Date.now() };
  memory = Object.fromEntries(
    Object.entries(entries)
      .sort((a, b) => b[1].updated - a[1].updated)
      .slice(0, 100),
  );
  savePreference(storageKey, JSON.stringify(memory));
}

export async function prepareStream(
  endpoint: string,
  hash: string,
  index: number,
  authorization: string | undefined,
  signal: AbortSignal,
): Promise<PreparedStream> {
  if (!/^[a-f0-9]{40}$/i.test(hash) || !Number.isSafeInteger(index) || index < 0)
    throw new Error('Invalid video selection.');
  hash = hash.toLowerCase();
  const base = streamBase(endpoint);
  const headers: Record<string, string> = { 'X-Drift-Stream': '1' };
  if (authorization) headers.Authorization = authorization;
  const request = new AbortController();
  const abort = () => request.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) request.abort();
  const timer = setTimeout(abort, 10000);
  try {
    let r: Response;
    try {
      r = await fetch(new URL(`v1/play/${hash}/${index}`, base), {
        method: 'POST',
        headers,
        credentials: 'include',
        signal: request.signal,
      });
    } catch (e) {
      if (signal.aborted) throw e;
      throw new Error(
        'The media service is not available. Start the streaming companion on your Transmission device, then try again.',
      );
    }
    if (!r.ok) {
      const messages: Record<number, string> = {
        401: 'Sign in to Transmission again to watch this video.',
        403: 'This connection is not allowed to stream. Check the server’s access settings.',
        404: 'This video is no longer available on your device.',
        409: 'Transmission is checking this video. Try again when verification finishes.',
        415: 'This file is not a recognized video.',
        503: 'The media service is busy. Try again in a moment.',
      };
      throw new Error(
        messages[r.status] ||
          'The video could not be prepared. Check that Transmission is running, then try again.',
      );
    }
    const data = await r.json().catch(() => {
      throw new Error('The media service returned an invalid response.');
    });
    const expected = `/v1/media/${hash}/${index}`;
    const media = new URL(typeof data?.src === 'string' ? data.src : '', base);
    const ticket = media.searchParams.get('ticket');
    if (
      data?.version !== 1 ||
      media.origin !== base.origin ||
      media.username ||
      media.password ||
      media.pathname !== expected ||
      media.hash ||
      (media.search &&
        (Array.from(media.searchParams).length !== 1 ||
          !ticket ||
          !/^[A-Za-z0-9_-]{43}$/.test(ticket)))
    )
      throw new Error('The media service returned an invalid video address.');
    const subtitles: SubtitleSource[] = [];
    if (Array.isArray(data.subtitles)) {
      for (const entry of data.subtitles.slice(0, 16)) {
        if (
          !entry ||
          !Number.isSafeInteger(entry.index) ||
          entry.index < 0 ||
          typeof entry.label !== 'string' ||
          !entry.label ||
          entry.label.length > 120 ||
          typeof entry.src !== 'string' ||
          subtitles.some((t) => t.index === entry.index)
        )
          continue;
        let url: URL;
        try {
          url = new URL(entry.src, base);
        } catch {
          continue;
        }
        if (
          url.origin !== base.origin ||
          url.username ||
          url.password ||
          url.hash ||
          url.pathname !== `/v1/subtitles/${hash}/${index}/${entry.index}` ||
          url.search !== media.search
        )
          continue;
        const language =
          typeof entry.language === 'string' &&
          entry.language.length <= 35 &&
          /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(entry.language)
            ? entry.language
            : 'und';
        subtitles.push({ index: entry.index, label: entry.label, language, src: url.href });
      }
    }
    let priority: string | undefined;
    if (typeof data.priority === 'string') {
      try {
        const url = new URL(data.priority, base);
        if (
          url.origin === base.origin &&
          !url.username &&
          !url.password &&
          !url.hash &&
          url.pathname === `/v1/priority/${hash}/${index}` &&
          url.search === media.search &&
          ticket
        )
          priority = url.href;
      } catch {
        // Optional capabilities must not prevent a valid media stream from playing.
      }
    }
    return { src: media.href, subtitles, ...(priority ? { priority } : {}) };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

export async function prioritizeStream(
  url: string,
  authorization: string | undefined,
  signal: AbortSignal,
): Promise<{ pending: boolean; firstPieceReady: boolean } | null> {
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    signal,
    headers: { 'X-Drift-Stream': '1', ...(authorization ? { Authorization: authorization } : {}) },
  });
  if (!response.ok) return null;
  const data = await response.json();
  return typeof data.pending === 'boolean' && typeof data.firstPieceReady === 'boolean'
    ? { pending: data.pending, firstPieceReady: data.firstPieceReady }
    : null;
}

/** Native media error codes conflate transport failures with unsupported codecs. */
export async function streamStatus(url: string, signal: AbortSignal): Promise<number> {
  const request = new AbortController();
  const abort = () => request.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) request.abort();
  const timer = setTimeout(abort, 5000);
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      headers: { Range: 'bytes=0-1' },
      credentials: 'include',
      signal: request.signal,
    });
    return response.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
    request.abort();
    signal.removeEventListener('abort', abort);
  }
}
