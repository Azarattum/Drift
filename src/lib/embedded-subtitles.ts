import { attachLibavHttpReader } from '../../node_modules/avbridge/src/util/libav-http-reader';
import type {
  LibAVWrapper,
  Packet,
} from '../../node_modules/avbridge/vendor/libav/webcodecs/libav.types';

export type EmbeddedCue = { start: number; end: number; text: string };

export async function openEmbeddedSubtitles(
  url: string,
  subtitleIndex: number,
  growing: boolean,
  signal: AbortSignal,
) {
  const base = new URL(`${import.meta.env.BASE_URL}format-codecs/avbridge/`, document.baseURI);
  const module: LibAVWrapper = await import(
    /* @vite-ignore */ new URL('libav-avbridge.js', base).href
  );
  const libav = await module.LibAV({ base: base.href.replace(/\/$/, ''), nothreads: true });
  let busy: Promise<unknown> | undefined;
  let handle: Awaited<ReturnType<typeof attachLibavHttpReader>> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let context: number | undefined;
  let packet: number | undefined;
  let cleanup: Promise<void> | undefined;
  const filename = 'embedded-subtitles.mkv';
  const destroy = () => {
    cleanup ??= (async () => {
      await busy?.catch(() => {});
      try {
        if (packet !== undefined) await libav.av_packet_free_js(packet);
        if (context !== undefined) await libav.avformat_close_input_js(context);
      } finally {
        await handle?.detach();
        await reader?.cancel().catch(() => {});
        libav.terminate();
      }
    })();
    return cleanup;
  };
  const abort = () => void destroy().catch(() => {});
  try {
    if (signal.aborted) throw new DOMException('Subtitle selection cancelled', 'AbortError');
    if (growing) {
      // A sequential device keeps libav from reading a SeekHead entry whose
      // target is at the unverified end of a growing file.
      const response = await fetch(url, {
        credentials: 'include',
        signal,
        headers: { Range: 'bytes=0-' },
      });
      if (response.status !== 206 || !response.body) {
        await response.body?.cancel();
        throw new Error('Waiting for embedded subtitles.');
      }
      const body = response.body.getReader();
      reader = body;
      await libav.mkreaderdev(filename);
      libav.onread = (name) => {
        void body
          .read()
          .then(
            ({ value, done }) => libav.ff_reader_dev_send(name, done ? null : value),
            (error) => libav.ff_reader_dev_send(name, null, { error }),
          )
          .catch(() => {});
      };
    } else {
      handle = await attachLibavHttpReader(libav, filename, url, {
        requestInit: { credentials: 'include', signal },
        cacheBytes: 2 * 1024 * 1024,
      });
    }
    // Matroska declares its text streams in the header. Probing packets with
    // avformat_find_stream_info can wait on unrelated, unverified tracks.
    const format = await libav.avformat_open_input_js(filename, 0, 0);
    if (format <= 0) throw new Error('Could not read the embedded subtitle header.');
    context = format;
    const count = await libav.AVFormatContext_nb_streams(format);
    const streams = await Promise.all(
      Array.from({ length: count }, async (_, index) => {
        const pointer = await libav.AVFormatContext_streams_a(format, index);
        const parameters = await libav.AVStream_codecpar(pointer);
        const [codec_type, time_base_num, time_base_den] = await Promise.all([
          libav.AVCodecParameters_codec_type(parameters),
          libav.AVStream_time_base_num(pointer),
          libav.AVStream_time_base_den(pointer),
        ]);
        return { index, codec_type, time_base_num, time_base_den };
      }),
    );
    const readPacket = await libav.av_packet_alloc();
    packet = readPacket;
    if (signal.aborted) throw new DOMException('Subtitle selection cancelled', 'AbortError');
    const stream = streams.filter((item) => item.codec_type === libav.AVMEDIA_TYPE_SUBTITLE)[
      subtitleIndex
    ];
    if (!stream) throw new Error('Embedded subtitle track not found.');
    const decoder = new TextDecoder();
    let scannedUntil = 0;
    function seconds(
      low: number,
      high: number,
      item: Packet,
      streamInfo: (typeof streams)[number],
    ) {
      return (
        (high * 4294967296 + (low >>> 0)) *
        ((item.time_base_num || streamInfo.time_base_num) /
          (item.time_base_den || streamInfo.time_base_den))
      );
    }
    function read(from: number, until: number, add: (cue: EmbeddedCue) => void): Promise<number> {
      const operation = (async () => {
        if (!growing && (from > scannedUntil + 2 || from < scannedUntil - 45)) {
          const [lo, hi] = libav.f64toi64(Math.round(Math.max(0, from - 10) * 1000000));
          if ((await libav.av_seek_frame(format, -1, lo, hi, libav.AVSEEK_FLAG_BACKWARD)) < 0)
            throw new Error('Could not seek to embedded subtitles.');
          scannedUntil = from - 10;
        }
        // Limit every read and return control after a bounded batch of media.
        for (let i = 0; i < 64 && !signal.aborted && scannedUntil < until; i++) {
          const [status, packets] = await libav.ff_read_frame_multi(format, readPacket, {
            limit: 64 * 1024,
          });
          for (const item of streams) {
            for (const data of packets[item.index] ?? []) {
              if (data.pts === undefined) continue;
              const start = seconds(data.pts, data.ptshi ?? 0, data, item);
              if (item.codec_type === libav.AVMEDIA_TYPE_VIDEO)
                scannedUntil = Math.max(scannedUntil, start);
              if (item.index !== stream.index || !data.duration || data.data.length > 8192)
                continue;
              const end = start + seconds(data.duration, data.durationhi ?? 0, data, item);
              if (
                Number.isFinite(start) &&
                Number.isFinite(end) &&
                end > from &&
                end > Math.max(0, start)
              )
                add({ start: Math.max(0, start), end, text: decoder.decode(data.data) });
            }
          }
          if (status === libav.AVERROR_EOF) {
            scannedUntil = Number.POSITIVE_INFINITY;
            break;
          }
          if (status < 0 && status !== -libav.EAGAIN) throw new Error('Waiting for subtitle data.');
        }
        return scannedUntil;
      })();
      busy = operation;
      return operation;
    }
    signal.addEventListener('abort', abort, { once: true });
    return { read };
  } catch (error) {
    await destroy().catch(() => {});
    throw error;
  }
}
