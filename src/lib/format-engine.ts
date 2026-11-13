import { createPlayer, type UnifiedPlayer } from 'avbridge';

const patched = [
  'play',
  'pause',
  'load',
  'currentTime',
  'duration',
  'paused',
  'volume',
  'muted',
  'playbackRate',
  'readyState',
  'seekable',
  'buffered',
  'videoWidth',
  'videoHeight',
] as const;

export type FormatEngine = { destroy: () => Promise<void> };
// avbridge caches a WASM runtime. Its previous input must be detached before reuse,
// including when a new modal opens while the old modal is still cleaning up.
let previousCleanup: Promise<void> = Promise.resolve();

/** Loaded only after detection finds a codec the native media element cannot play. */
export async function attachFormatEngine(
  video: HTMLVideoElement,
  source: string,
  signal: AbortSignal,
  onError: () => void,
): Promise<FormatEngine> {
  const previous = previousCleanup;
  let release!: () => void;
  const finished = new Promise<void>((resolve) => {
    release = resolve;
  });
  previousCleanup = previous.then(() => finished);
  await previous;
  if (signal.aborted) {
    release();
    throw new DOMException('Playback cancelled', 'AbortError');
  }
  const root = new URL(`${import.meta.env.BASE_URL}format-codecs/`, document.baseURI).href.replace(
    /\/$/,
    '',
  );
  (globalThis as typeof globalThis & { AVBRIDGE_LIBAV_BASE?: string }).AVBRIDGE_LIBAV_BASE ??= root;
  const descriptors = new Map(
    patched.map((key) => [key, Object.getOwnPropertyDescriptor(video, key)]),
  );
  const visibility = video.style.visibility;
  const volume = video.volume;
  const muted = video.muted;
  const rate = video.playbackRate;
  let player: UnifiedPlayer | undefined;
  let creation: Promise<UnifiedPlayer> | undefined;
  let disposed = false;
  let cleanup: Promise<void> | undefined;
  let resize: ResizeObserver | undefined;
  const pending = new Set<AbortController>();
  async function fetchMedia(input: RequestInfo | URL, init?: RequestInit) {
    const request = new AbortController();
    const abort = () => request.abort();
    const other = init?.signal;
    signal.addEventListener('abort', abort, { once: true });
    other?.addEventListener('abort', abort, { once: true });
    if (signal.aborted || other?.aborted || disposed) request.abort();
    pending.add(request);
    const finish = () => {
      pending.delete(request);
      signal.removeEventListener('abort', abort);
      other?.removeEventListener('abort', abort);
    };
    try {
      const response = await fetch(input, {
        ...init,
        credentials: 'include',
        signal: request.signal,
      });
      if (!response.body) {
        finish();
        return response;
      }
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const result = await reader.read();
            if (result.done) {
              finish();
              controller.close();
            } else controller.enqueue(result.value);
          } catch (error) {
            finish();
            controller.error(error);
          }
        },
        async cancel() {
          request.abort();
          try {
            await reader.cancel();
          } finally {
            finish();
          }
        },
      });
      const wrapped = new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
      Object.defineProperty(wrapped, 'url', { value: response.url });
      return wrapped;
    } catch (error) {
      finish();
      throw error;
    }
  }
  function restore() {
    for (const key of patched) {
      const descriptor = descriptors.get(key);
      if (descriptor) Object.defineProperty(video, key, descriptor);
      else Reflect.deleteProperty(video, key);
    }
    video.style.visibility = visibility;
  }
  function destroy(): Promise<void> {
    disposed = true;
    resize?.disconnect();
    for (const request of pending) request.abort();
    pending.clear();
    signal.removeEventListener('abort', abort);
    cleanup ??= (async () => {
      try {
        const active =
          player ??
          (await creation?.catch((error) => (error as { player?: UnifiedPlayer }).player));
        await active?.destroy();
      } finally {
        restore();
        release();
      }
    })();
    return cleanup;
  }
  const abort = () => {
    void destroy().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) throw new DOMException('Playback cancelled', 'AbortError');
    video.pause();
    video.removeAttribute('src');
    video.load();
    creation = createPlayer({
      source,
      target: video,
      initialStrategy: 'hybrid',
      autoEscalate: false,
      backgroundBehavior: 'continue',
      fetchFn: fetchMedia,
      cacheBytes: 8 * 1024 * 1024,
    });
    player = await creation;
    if (disposed || signal.aborted) {
      throw new DOMException('Playback cancelled', 'AbortError');
    }
    const active = player;
    const clock = Object.getOwnPropertyDescriptor(video, 'currentTime');
    let seek: Promise<void> | undefined;
    let nextSeek: number | undefined;
    let wantPlay = false;
    function queueSeek(at: number) {
      if (!Number.isFinite(at) || disposed) return;
      nextSeek = Math.max(0, Math.min(video.duration, at));
      seek ??= (async () => {
        while (nextSeek !== undefined && !disposed) {
          const target = nextSeek;
          nextSeek = undefined;
          await active.seek(target);
          if (!wantPlay) active.pause();
        }
      })()
        .catch(() => {
          if (!disposed && !signal.aborted) onError();
        })
        .finally(() => {
          seek = undefined;
        });
    }
    const surface = Array.from(video.parentElement?.children ?? []).find(
      (node): node is HTMLCanvasElement => node instanceof HTMLCanvasElement,
    );
    if (surface) {
      surface.style.pointerEvents = 'none';
      const fit = () => {
        surface.style.height = `${video.getBoundingClientRect().height}px`;
      };
      resize = new ResizeObserver(fit);
      resize.observe(video);
      fit();
    }
    Object.defineProperties(video, {
      play: {
        configurable: true,
        value: async () => {
          wantPlay = true;
          await seek;
          if (!disposed && wantPlay) await active.play();
        },
      },
      pause: {
        configurable: true,
        value: () => {
          wantPlay = false;
          active.pause();
        },
      },
      currentTime: { configurable: true, get: () => clock?.get?.call(video) ?? 0, set: queueSeek },
      load: { configurable: true, value: () => {} },
      videoWidth: { configurable: true, get: () => active.getDiagnostics().width ?? 0 },
      videoHeight: { configurable: true, get: () => active.getDiagnostics().height ?? 0 },
    });
    video.volume = volume;
    video.muted = muted;
    video.playbackRate = rate;
    player.on('error', () => {
      if (!disposed && !signal.aborted) onError();
    });
    return { destroy };
  } catch (error) {
    const failed = (error as { player?: UnifiedPlayer })?.player;
    if (!player && failed) player = failed;
    await destroy();
    restore();
    throw error;
  }
}
