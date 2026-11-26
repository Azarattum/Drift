import {
  ALL_FORMATS,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  UrlSource,
} from 'mediabunny';

// A growing torrent can have playable clusters before its trailing seek index.
class GrowingMatroskaSource extends UrlSource {
  _getFileSize(): null {
    return null;
  }
}

function waitFor(target: EventTarget, name: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    function finish(error?: Error) {
      target.removeEventListener(name, ready);
      target.removeEventListener('error', failed);
      signal.removeEventListener('abort', aborted);
      if (error) reject(error);
      else resolve();
    }
    const ready = () => finish();
    const failed = () => finish(new Error('The browser could not buffer the selected audio.'));
    const aborted = () => finish(new DOMException('Playback cancelled', 'AbortError'));
    target.addEventListener(name, ready, { once: true });
    target.addEventListener('error', failed, { once: true });
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

export async function remuxAudio(
  video: HTMLVideoElement,
  url: string,
  trackNumber: number,
  time: number,
  growing: boolean,
  signal: AbortSignal,
  started: () => void,
  ready: () => void,
) {
  const Source = growing ? GrowingMatroskaSource : UrlSource;
  const input = new Input({
    source: new Source(url, {
      requestInit: { credentials: 'include' },
      getRetryDelay: (attempt) => (signal.aborted || attempt > 2 ? null : 1),
      maxCacheSize: 8 * 1024 * 1024,
    }),
    formats: ALL_FORMATS,
  });
  let output: Output | undefined;
  let objectURL: string | undefined;
  const dispose = () => {
    input.dispose();
    if (objectURL) URL.revokeObjectURL(objectURL);
  };
  signal.addEventListener('abort', dispose, { once: true });
  try {
    if (signal.aborted) return;
    const [picture, sounds] = await Promise.all([
      input.getPrimaryVideoTrack(),
      input.getAudioTracks(),
    ]);
    const sound = sounds.find((track) => track.id === trackNumber);
    if (!picture || !sound) throw new Error('The requested audio track could not be found.');
    const [videoCodec, audioCodec, pictureConfig, soundConfig, duration] = await Promise.all([
      picture.getCodec(),
      sound.getCodec(),
      picture.getDecoderConfig(),
      sound.getDecoderConfig(),
      input.getDurationFromMetadata([picture, sound]),
    ]);
    if (!videoCodec || !audioCodec || !pictureConfig || !soundConfig)
      throw new Error('The selected audio format is unsupported.');
    // The fMP4 muxer writes HEVC as hvc1 even if the input reports hev1.
    const pictureMime = pictureConfig.codec.replace(/^hev1\./, 'hvc1.');
    const mime = `video/mp4; codecs="${pictureMime}, ${soundConfig.codec}"`;
    if (!MediaSource.isTypeSupported(mime))
      throw new Error('The selected audio format is unsupported.');

    const pictures = new EncodedPacketSink(picture);
    const audio = new EncodedPacketSink(sound);
    const firstPicture =
      (time > 0.5 ? await pictures.getKeyPacket(time) : null) ?? (await pictures.getFirstPacket());
    const firstSound =
      firstPicture &&
      ((await audio.getPacket(firstPicture.timestamp)) ?? (await audio.getFirstPacket()));
    if (!firstPicture || !firstSound || signal.aborted) {
      if (signal.aborted) return;
      throw new Error('The selected audio track is unavailable.');
    }

    const source = new MediaSource();
    objectURL = URL.createObjectURL(source);
    const opened = waitFor(source, 'sourceopen', signal);
    started();
    video.src = objectURL;
    await opened;
    const buffer = source.addSourceBuffer(mime);
    if (duration && Number.isFinite(duration)) source.duration = duration;
    let announced = false;
    const target = new StreamTarget(
      new WritableStream({
        async write({ data }) {
          while (
            !signal.aborted &&
            announced &&
            buffer.buffered.length &&
            buffer.buffered.end(buffer.buffered.length - 1) > video.currentTime + 35
          ) {
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          if (signal.aborted) return;
          if (buffer.buffered.length && video.currentTime - buffer.buffered.start(0) > 40) {
            buffer.remove(buffer.buffered.start(0), video.currentTime - 20);
            await waitFor(buffer, 'updateend', signal);
          }
          buffer.appendBuffer(data);
          await waitFor(buffer, 'updateend', signal);
          if (!announced && buffer.buffered.length) {
            const start = buffer.buffered.start(0);
            const end = buffer.buffered.end(buffer.buffered.length - 1);
            if (time < end) {
              announced = true;
              video.currentTime = Math.max(start, time);
              ready();
            }
          }
        },
      }),
    );
    output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 1 }),
      target,
    });
    const pictureOut = new EncodedVideoPacketSource(videoCodec);
    const soundOut = new EncodedAudioPacketSource(audioCodec);
    output.addVideoTrack(pictureOut);
    output.addAudioTrack(soundOut);
    await output.start();
    const videoPackets = pictures.packets(firstPicture);
    const audioPackets = audio.packets(firstSound);
    let nextVideo = await videoPackets.next();
    let nextAudio = await audioPackets.next();
    try {
      while (!signal.aborted && (!nextVideo.done || !nextAudio.done)) {
        if (
          !nextVideo.done &&
          (nextAudio.done || nextVideo.value.timestamp <= nextAudio.value.timestamp)
        ) {
          const packet = nextVideo.value;
          await pictureOut.add(
            packet,
            packet === firstPicture ? { decoderConfig: pictureConfig } : undefined,
          );
          nextVideo = await videoPackets.next();
        } else if (!nextAudio.done) {
          const packet = nextAudio.value;
          await soundOut.add(
            packet,
            packet === firstSound ? { decoderConfig: soundConfig } : undefined,
          );
          nextAudio = await audioPackets.next();
        }
      }
    } finally {
      void videoPackets.return();
      void audioPackets.return();
    }
    if (signal.aborted) return;
    await output.finalize();
    if (!announced && buffer.buffered.length) {
      video.currentTime = Math.max(
        buffer.buffered.start(0),
        Math.min(time, buffer.buffered.end(0)),
      );
      ready();
    }
    if (source.readyState === 'open') source.endOfStream();
  } finally {
    if (output?.state === 'started') await output.cancel().catch(() => {});
    dispose();
    signal.removeEventListener('abort', dispose);
  }
}
