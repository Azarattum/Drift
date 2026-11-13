// Keep format detection separate from the optional decoder bundle.
export function canEnhanceFormats(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    typeof WebAssembly !== 'undefined' &&
    typeof VideoFrame !== 'undefined' &&
    typeof AudioContext !== 'undefined'
  );
}

type Element = { id: number; start: number; end: number };
function element(bytes: Uint8Array, at: number, limit: number): Element | undefined {
  function vint(offset: number, id: boolean) {
    const first = bytes[offset];
    if (!first) return;
    let width = 1;
    while (width <= 8 && !(first & (128 >> (width - 1)))) width++;
    if (width > (id ? 4 : 8) || offset + width > limit) return;
    let value = id ? first : first & ((128 >> (width - 1)) - 1);
    let unknown = !id && value === (128 >> (width - 1)) - 1;
    for (let i = 1; i < width; i++) {
      value = value * 256 + bytes[offset + i];
      unknown &&= bytes[offset + i] === 255;
    }
    if (!unknown && !Number.isSafeInteger(value)) return;
    return { value, width, unknown };
  }
  const id = vint(at, true);
  if (!id) return;
  const size = vint(at + id.width, false);
  if (!size) return;
  const start = at + id.width + size.width;
  return { id: id.value, start, end: size.unknown ? limit : start + size.value };
}

/** Read only the Matroska Tracks header. Never scan through video frame bytes. */
export function matroskaAudioCodec(bytes: Uint8Array): string | undefined {
  const tracks: { codec: string; preferred: boolean }[] = [];
  function scan(start: number, end: number, depth: number) {
    if (depth > 3) return;
    for (let at = start; at < Math.min(end, bytes.length);) {
      const e = element(bytes, at, Math.min(end, bytes.length));
      if (!e || e.end <= at) return;
      if (e.id === 0x18538067 || e.id === 0x1654ae6b) scan(e.start, e.end, depth + 1);
      if (e.id === 0xae && e.end <= bytes.length) {
        let type = 0;
        let codec = '';
        let preferred = true;
        for (let p = e.start; p < e.end;) {
          const field = element(bytes, p, e.end);
          if (!field || field.end > e.end || field.end <= p) break;
          if (field.id === 0x83) type = bytes[field.start];
          if (field.id === 0x88) preferred = bytes[field.start] !== 0;
          if (field.id === 0x86)
            codec = new TextDecoder().decode(bytes.subarray(field.start, field.end));
          p = field.end;
        }
        if (type === 2 && codec) tracks.push({ codec, preferred });
      }
      // Clusters contain frames, not header metadata.
      if (e.id === 0x1f43b675) return;
      at = e.end;
    }
  }
  scan(0, bytes.length, 0);
  return (tracks.find((track) => track.preferred) ?? tracks[0])?.codec;
}

export function needsAudioDecoder(codec: string | undefined, video: HTMLVideoElement): boolean {
  const mime =
    codec === 'A_DTS'
      ? 'dtsc'
      : codec === 'A_TRUEHD'
        ? 'mlpa'
        : codec === 'A_AC3'
          ? 'ac-3'
          : codec === 'A_EAC3'
            ? 'ec-3'
            : undefined;
  return !!mime && !video.canPlayType(`audio/mp4; codecs="${mime}"`);
}

/** A bounded probe also handles servers which ignore Range without reading a whole movie. */
export async function probeMatroskaAudio(url: string, signal: AbortSignal) {
  const request = new AbortController();
  const abort = () => request.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) request.abort();
  const timer = setTimeout(abort, 2500);
  const limit = 65536;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(url, {
      headers: { Range: `bytes=0-${limit - 1}` },
      credentials: 'include',
      signal: request.signal,
    });
    if (!response.ok || !response.body) return;
    reader = response.body.getReader();
    const bytes = new Uint8Array(limit);
    let length = 0;
    while (length < limit) {
      const { value, done } = await reader.read();
      if (done) break;
      const count = Math.min(value.length, limit - length);
      bytes.set(value.subarray(0, count), length);
      length += count;
      const codec = matroskaAudioCodec(bytes.subarray(0, length));
      if (codec) return codec;
    }
    return matroskaAudioCodec(bytes.subarray(0, length));
  } catch {
    // An incomplete header must not turn a temporary download wait into a format error.
    return;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    await reader?.cancel().catch(() => {});
    request.abort();
  }
}
