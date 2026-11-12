export type SubtitleSource = { index: number; label: string; language: string; src: string };

export function subtitleLabel(source: SubtitleSource): string {
  let language = source.language;
  if (language !== 'und') {
    try {
      if (typeof Intl.DisplayNames === 'function')
        language = new Intl.DisplayNames(['en'], { type: 'language' }).of(language) || language;
    } catch {
      /* Keep the language code on older locale implementations. */
    }
    const rest = source.label.toLowerCase().startsWith(source.language.toLowerCase())
      ? source.label.slice(source.language.length).replace(/^[._ -]+/, '')
      : source.label;
    return [
      language,
      ...rest
        .split(/[._ ]+/)
        .filter(Boolean)
        .map((s) => (['sdh', 'cc'].includes(s) ? s.toUpperCase() : s)),
    ]
      .filter(Boolean)
      .join(' · ');
  }
  return source.label;
}

/** Fetch only bounded, converted text; pending tracks can be retried while selected. */
export async function fetchSubtitle(
  source: SubtitleSource,
  signal: AbortSignal,
): Promise<Blob | 'downloading' | 'busy'> {
  const request = new AbortController();
  const abort = () => request.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) request.abort();
  const timer = setTimeout(abort, 10000);
  try {
    const response = await fetch(source.src, { credentials: 'include', signal: request.signal });
    if (response.status === 409 || response.status === 503) {
      await response.body?.cancel();
      return response.status === 409 ? 'downloading' : 'busy';
    }
    if (!response.ok || !response.headers.get('Content-Type')?.startsWith('text/vtt'))
      throw new Error('Subtitles could not be loaded. Choose the track again to retry.');
    const maximum = 1024 * 1024;
    if (Number(response.headers.get('Content-Length')) > maximum)
      throw new Error('Subtitles are too large.');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Subtitle data is unavailable.');
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let length = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw new Error('Subtitles are too large.');
      }
      chunks.push(next.value);
    }
    const blob = new Blob(chunks, { type: 'text/vtt' });
    if ((await blob.slice(0, 6).text()) !== 'WEBVTT') throw new Error('Invalid subtitle data.');
    return blob;
  } finally {
    request.abort();
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}
