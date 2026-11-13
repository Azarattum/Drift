<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import {
    Airplay,
    Check,
    CheckCircle2,
    Captions,
    ChevronDown,
    Film,
    ListVideo,
    LoaderCircle,
    Maximize,
    Minimize,
    Pause,
    PictureInPicture2,
    Play,
    RotateCcw,
    RotateCw,
    Volume2,
    VolumeX,
  } from '@lucide/svelte';
  import Modal from './Modal.svelte';
  import { client } from '../lib/client.svelte';
  import type { Torrent } from '../lib/types';
  import { bytes, percent } from '../lib/format';
  import {
    clock,
    playbackPosition,
    positionKey,
    prepareStream,
    prioritizeStream,
    streamStatus,
    savePosition,
    videoFiles,
    type VideoFile,
  } from '../lib/playback';
  import { loadPlayerEngine } from '../lib/player-engine';
  import { fetchSubtitle, subtitleLabel, type SubtitleSource } from '../lib/subtitles';
  let { torrent, fileIndex, close }: { torrent: Torrent; fileIndex?: number; close: () => void } =
    $props();
  const endpoint = client.rpc.endpoint;
  let files = $state<VideoFile[]>([]);
  let selected = $state<VideoFile | null>(null);
  let phase = $state<'loading' | 'choose' | 'preparing' | 'ready' | 'error'>('loading');
  let message = $state('');
  let source = $state('');
  let priorityURL = '';
  let priorityTimer: ReturnType<typeof setTimeout>;
  let priorityRequest: AbortController | null = null;
  let waitingForPieces = $state(false);
  let userPaused = false;
  function authorization() {
    return client.rpc.username
      ? `Basic ${btoa(unescape(encodeURIComponent(`${client.rpc.username}:${client.rpc.password}`)))}`
      : undefined;
  }
  function prioritizeSoon(delay = 100) {
    clearTimeout(priorityTimer);
    if (priorityURL && phase === 'ready')
      priorityTimer = setTimeout(() => void prioritize(), delay);
  }
  async function prioritize() {
    if (!priorityURL || !video || disposed || phase !== 'ready' || priorityRequest) return;
    if ((video.readyState >= 3 && !video.seeking) || (resume !== null && video.readyState >= 1))
      return;
    const request = new AbortController();
    priorityRequest = request;
    const url = priorityURL;
    const timer = setTimeout(() => request.abort(), 3000);
    try {
      const result = await prioritizeStream(url, authorization(), request.signal);
      if (!request.signal.aborted && priorityURL === url)
        waitingForPieces = result?.pending ?? false;
    } catch {
      /* The streaming connection and bounded recovery own user-facing errors. */
    } finally {
      clearTimeout(timer);
      if (priorityURL === url) waitingForPieces = false;
      if (priorityRequest === request) priorityRequest = null;
      if (
        !disposed &&
        phase === 'ready' &&
        priorityURL === url &&
        video &&
        video.readyState < 3 &&
        !(userPaused && video.readyState >= 1 && !video.seeking) &&
        !(resume !== null && video.readyState >= 1)
      )
        prioritizeSoon(1500);
    }
  }
  let video = $state<HTMLVideoElement>();
  let canvas = $state<HTMLElement>();
  let fullscreen = $state(false);
  let keyboardControls = $state(false);
  $effect(() => {
    if (!canvas) return;
    const update = () => {
      const doc = document as Document & { webkitFullscreenElement?: Element };
      fullscreen = (doc.fullscreenElement || doc.webkitFullscreenElement) === canvas;
    };
    update();
    document.addEventListener('fullscreenchange', update);
    document.addEventListener('webkitfullscreenchange', update);
    return () => {
      document.removeEventListener('fullscreenchange', update);
      document.removeEventListener('webkitfullscreenchange', update);
    };
  });
  let paused = $state(true),
    waiting = $state(false),
    current = $state(0),
    duration = $state(0),
    muted = $state(false);
  let bufferTimer: ReturnType<typeof setTimeout>;
  let stallTimer: ReturnType<typeof setTimeout>;
  let reconnects = 0;
  let lastReconnect = -1;
  let lastRecoveryBytes = -1;
  function recover(at: number, reason: string, resumePlayback = true) {
    if (!selected) return;
    if (at > lastReconnect + 1 || downloaded > lastRecoveryBytes) reconnects = 0;
    lastReconnect = at;
    lastRecoveryBytes = downloaded;
    if (++reconnects > 2) {
      phase = 'error';
      message = reason;
      stop();
      controller.abort();
      return;
    }
    void watch(selected, resumePlayback ? at : undefined, true);
  }
  function buffering() {
    prioritizeSoon();
    clearTimeout(bufferTimer);
    bufferTimer = setTimeout(() => {
      waiting = !!video && video.readyState < 3;
    }, 350);
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      if (
        !video ||
        !selected ||
        userPaused ||
        resume !== null ||
        video.readyState >= 3 ||
        phase !== 'ready'
      )
        return;
      if (waitingForPieces) {
        // A live request waiting on verified pieces needs download time, not a restart.
        buffering();
        return;
      }
      const at = pendingSeek ?? video.currentTime;
      recover(
        at,
        'The stream is still waiting for video data. Your position is saved. Try again shortly.',
      );
    }, 8000);
  }
  function buffered() {
    clearTimeout(bufferTimer);
    clearTimeout(stallTimer);
    clearTimeout(priorityTimer);
    priorityRequest?.abort();
    priorityRequest = null;
    waiting = false;
    waitingForPieces = false;
  }
  let resume = $state<number | null>(null);
  let pendingSeek: number | null = null;
  let listOpen = $state(false);
  let rate = $state(1);
  let captions = $state<TextTrack[]>([]);
  let captionMenu = $state(false);
  let captionIndex = $state(-1);
  let subtitleSources = $state<SubtitleSource[]>([]);
  let subtitleURLs = $state<Record<number, string>>({});
  let captionStatus = $state('');
  let subtitleLoading = $state<number | null>(null);
  let captionLoad: AbortController | null = null;
  let captionRetry: ReturnType<typeof setTimeout>;
  let recoverySubtitle: number | undefined;
  function cancelCaptionLoad() {
    clearTimeout(captionRetry);
    captionLoad?.abort();
    captionLoad = null;
    subtitleLoading = null;
    captionStatus = '';
  }
  function clearSubtitles() {
    cancelCaptionLoad();
    for (const url of Object.values(subtitleURLs)) URL.revokeObjectURL(url);
    subtitleURLs = {};
    subtitleSources = [];
  }
  function externalSource(track?: TextTrack) {
    const node = Array.from(
      video?.querySelectorAll<HTMLTrackElement>('track[data-subtitle-index]') ?? [],
    ).find((node) => node.track === track);
    return node
      ? subtitleSources.find((source) => source.index === Number(node.dataset.subtitleIndex))
      : undefined;
  }
  function ensureSubtitle(track: TextTrack) {
    const source = externalSource(track);
    if (!source || subtitleURLs[source.index] || subtitleLoading === source.index) return;
    cancelCaptionLoad();
    const request = new AbortController();
    captionLoad = request;
    subtitleLoading = source.index;
    const attempt = async () => {
      if (request.signal.aborted || disposed) return;
      if (document.hidden) {
        captionRetry = setTimeout(attempt, 2000);
        return;
      }
      try {
        const result = await fetchSubtitle(source, request.signal);
        if (request.signal.aborted || disposed) return;
        if (typeof result === 'string') {
          captionStatus =
            result === 'downloading'
              ? 'Waiting for subtitles to download…'
              : 'Subtitle service is busy. Retrying…';
          captionRetry = setTimeout(attempt, 2000);
          return;
        }
        subtitleURLs = { ...subtitleURLs, [source.index]: URL.createObjectURL(result) };
        subtitleLoading = null;
        captionLoad = null;
        captionStatus = '';
      } catch {
        if (!request.signal.aborted && !disposed) {
          subtitleLoading = null;
          captionLoad = null;
          captionStatus = 'Subtitles could not be loaded. Choose the track again to retry.';
        }
      }
    };
    void attempt();
  }
  $effect(() => {
    if (!video) return;
    const tracks = video.textTracks;
    const update = () => {
      const available = Array.from(tracks).filter(
        (t) => t.kind === 'subtitles' || t.kind === 'captions',
      );
      captions = available;
      captionIndex = available.findIndex((t) => t.mode === 'showing');
      if (captionIndex >= 0) ensureSubtitle(available[captionIndex]);
    };
    untrack(update);
    tracks.addEventListener('addtrack', update);
    tracks.addEventListener('removetrack', update);
    tracks.addEventListener('change', update);
    return () => {
      tracks.removeEventListener('addtrack', update);
      tracks.removeEventListener('removetrack', update);
      tracks.removeEventListener('change', update);
    };
  });
  function setCaption(index: number) {
    cancelCaptionLoad();
    for (const [i, track] of captions.entries()) track.mode = i === index ? 'showing' : 'disabled';
    captionIndex = index;
    if (index >= 0) ensureSubtitle(captions[index]);
    captionMenu = false;
    canvas?.querySelector<HTMLElement>('[aria-label="Subtitles"]')?.focus();
  }
  async function toggleCaptions() {
    captionMenu = !captionMenu;
    await tick();
    if (captionMenu) canvas?.querySelector<HTMLElement>('.watch-caption-menu button')?.focus();
  }
  let controller = new AbortController();
  let disposed = false;
  let lastSave = 0;
  let restored = false;
  let hasPlayed = false;
  let selectedPosition = $derived(
    selected ? positionKey(endpoint, torrent.hashString, selected) : '',
  );
  let downloaded = $derived(
    selected
      ? client.details?.hashString === torrent.hashString
        ? (client.details.files?.[selected.index]?.bytesCompleted ?? selected.bytesCompleted)
        : selected.bytesCompleted
      : 0,
  );
  let monitorTimer: ReturnType<typeof setTimeout>;
  function monitor(file: VideoFile, signal: AbortSignal) {
    monitorTimer = setTimeout(async () => {
      if (signal.aborted || disposed || file.bytesCompleted >= file.length) return;
      try {
        if (!document.hidden) {
          const response = await client.rpc.call<{ torrents: Torrent[] }>(
            'torrent-get',
            { ids: [torrent.hashString], fields: ['hashString', 'files'] },
            signal,
          );
          const updated = response.torrents.find((t) => t.hashString === torrent.hashString);
          if (!updated && !signal.aborted && !disposed) {
            stop();
            controller.abort();
            phase = 'error';
            message =
              'This torrent was removed or replaced. Open the current transfer to continue watching.';
            return;
          }
          if (updated && !signal.aborted && !disposed) {
            files = videoFiles(updated.files);
            selected = files.find((f) => f.index === file.index) ?? selected;
          }
        }
      } catch {
        /* Streaming and the app's connection indicator handle temporary RPC failures. */
      }
      if (!signal.aborted && !disposed) monitor(selected ?? file, signal);
    }, 3000);
  }
  let complete = $derived(!!selected && downloaded >= selected.length);
  let fileNumber = $derived(selected ? files.findIndex((f) => f.index === selected!.index) + 1 : 0);
  function save(force = false) {
    if (!video || !selected || !hasPlayed || resume !== null || !Number.isFinite(video.duration))
      return;
    if (!force && Date.now() - lastSave < 5000) return;
    lastSave = Date.now();
    savePosition(selectedPosition, video.currentTime, video.duration);
  }
  function stop() {
    clearTimeout(monitorTimer);
    buffered();
    save(true);
    clearSubtitles();
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
  }
  function leave() {
    stop();
    controller.abort();
    close();
  }
  async function watch(file: VideoFile, reconnectAt?: number, recovery = false) {
    const previousSubtitle =
      externalSource(captions[captionIndex])?.index ?? (recovery ? recoverySubtitle : undefined);
    const previousRate = rate;
    if (reconnectAt === undefined && !recovery) {
      reconnects = 0;
      lastReconnect = -1;
      lastRecoveryBytes = -1;
    }
    stop();
    controller.abort();
    controller = new AbortController();
    const signal = controller.signal;
    selected = file;
    source = '';
    priorityURL = '';
    userPaused = false;
    phase = 'preparing';
    message = '';
    resume = null;
    pendingSeek = reconnectAt ?? null;
    restored = false;
    hasPlayed = false;
    current = 0;
    duration = 0;
    paused = true;
    waiting = false;
    rate = recovery ? previousRate : 1;
    listOpen = false;
    captionMenu = false;
    captionIndex = -1;
    try {
      const [stream] = await Promise.all([
        prepareStream(endpoint, torrent.hashString, file.index, authorization(), signal),
        loadPlayerEngine(),
      ]);
      if (disposed || signal.aborted) return;
      resume =
        reconnectAt === undefined
          ? (playbackPosition(positionKey(endpoint, torrent.hashString, file))?.time ?? null)
          : null;
      source = stream.src;
      priorityURL = stream.priority ?? '';
      subtitleSources = stream.subtitles;
      phase = 'ready';
      await tick();
      if (disposed || signal.aborted) return;
      buffering();
      if (previousSubtitle !== undefined) {
        const track = video?.querySelector<HTMLTrackElement>(
          `track[data-subtitle-index="${previousSubtitle}"]`,
        );
        if (track) {
          captions = Array.from(video!.textTracks).filter(
            (t) => t.kind === 'subtitles' || t.kind === 'captions',
          );
          setCaption(captions.indexOf(track.track));
      if (video) video.playbackRate = rate;
        }
      }
      if (file.bytesCompleted < file.length) monitor(file, signal);
      void client.poll(true);
    } catch (e) {
      if (signal.aborted || disposed) return;
      phase = 'error';
      message = e instanceof Error ? e.message : 'This video could not be opened.';
    }
  }
  async function play(at?: number) {
    if (!video) return;
    const target = video;
    userPaused = false;
    if (at !== undefined) {
      if (video.readyState >= 1 && Number.isFinite(video.duration))
        video.currentTime = Math.min(at, Math.max(0, video.duration - 0.1));
      else pendingSeek = at;
    }
    resume = null;
    try {
      await target.play();
    } catch {
      if (video === target) {
        paused = true;
        userPaused = true;
      }
    }
  }
  function metadata() {
    if (!video) return;
    duration = video.duration;
    if (pendingSeek !== null) {
      const at = pendingSeek;
      pendingSeek = null;
      restored = true;
      void play(at);
      return;
    }
    if (restored) return;
    restored = true;
    if (resume !== null && (!Number.isFinite(duration) || resume >= duration - 10)) resume = null;
    if (resume === null) void play();
  }
  async function mediaError() {
    if (!video?.error || !source || phase !== 'ready') return;
    const code = video.error.code;
    const at = pendingSeek ?? video.currentTime;
    const resumePlayback = resume === null && !userPaused;
    const missingPieces = waitingForPieces;
    const url = source;
    phase = 'error';
    message = 'Checking the stream connection…';
    stop();
    controller.abort();
    controller = new AbortController();
    const signal = controller.signal;
    const status = await streamStatus(url, signal);
    if (disposed || signal.aborted) return;
    const terminal: Record<number, string> = {
    recoverySubtitle = externalSource(captions[captionIndex])?.index;
      401: 'Sign in to Transmission again to watch this video.',
      403: 'This connection is not allowed to stream.',
      404: 'This video is no longer available on your device.',
      409: 'Transmission is checking this video. Try again when verification finishes.',
      415: 'This file is not a recognized video container.',
    };
    if (terminal[status]) {
      message = terminal[status];
      return;
    }
    const ready = status === 200 || status === 206;
    const reason =
      ready && !missingPieces && (code === 3 || code === 4)
        ? 'This video format can’t play in this browser. Try a compatible browser or open the file in your preferred video app.'
        : 'Video data is temporarily unavailable. Your position is saved. Try again shortly.';
    if (reconnects >= 2 && downloaded <= lastRecoveryBytes && at <= lastReconnect + 1) {
      message = reason;
      return;
    }
    message = 'Reconnecting to the video…';
    stallTimer = setTimeout(() => {
      if (!disposed && !signal.aborted) recover(at, reason, resumePlayback);
    }, 350);
  }
  function keys(e: KeyboardEvent) {
    if (phase === 'ready') keyboardControls = true;
    if (phase !== 'ready' || !video || e.altKey || e.ctrlKey || e.metaKey || resume !== null)
      return;
    const target = e.target as HTMLElement;
    if (target.closest('input,select,textarea,[contenteditable],[role="slider"]')) return;
    if ((e.key === ' ' || e.key === 'Enter') && target.closest('button,[role="button"]')) return;
    if (e.key === ' ' || e.key.toLowerCase() === 'k') {
      e.preventDefault();
      video.paused ? void play() : video.pause();
    } else if (['ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault();
      video.currentTime = Math.max(
        0,
        Math.min(video.duration, video.currentTime + (e.key === 'ArrowLeft' ? -10 : 10)),
      );
    } else if (e.key.toLowerCase() === 'm') {
      e.preventDefault();
      video.muted = !video.muted;
    } else if (e.key.toLowerCase() === 'f') {
      e.preventDefault();
      canvas?.querySelector<HTMLElement>('media-fullscreen-button')?.click();
    }
  }
  function fitPlayer(node: HTMLElement) {
    const dialog = node.closest('dialog')!;
    const body = dialog.querySelector<HTMLElement>('.modal-body')!;
    let frame = 0;
    function update() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (node.classList.contains('watch-fullscreen')) return;
        const media = node.querySelector('video');
        if (!media) return;
        const style = getComputedStyle(dialog);
        const maximum = parseFloat(style.maxHeight);
        const other = body.getBoundingClientRect().height - media.getBoundingClientRect().height;
        const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
        if (Number.isFinite(maximum))
          node.style.setProperty(
            '--watch-video-height',
            `${Math.max(0, Math.floor(maximum - other - border) - 1)}px`,
          );
      });
    }
    const observer = new ResizeObserver(update);
    observer.observe(body);
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    update();
    return {
      destroy() {
        cancelAnimationFrame(frame);
        observer.disconnect();
        window.removeEventListener('resize', update);
        window.visualViewport?.removeEventListener('resize', update);
      },
    };
  }
  onMount(() => {
    const signal = controller.signal;
    void (async () => {
      try {
        const r = await client.rpc.call<{ torrents: Torrent[] }>(
          'torrent-get',
          { ids: [torrent.hashString], fields: ['id', 'hashString', 'name', 'files'] },
          signal,
        );
        if (disposed || signal.aborted) return;
        const found = r.torrents.find((t) => t.hashString === torrent.hashString);
        if (!found) throw new Error('This torrent is no longer available.');
        files = videoFiles(found.files);
        if (!files.length) {
          phase = 'error';
          message = 'There are no supported video files in this torrent.';
          return;
        }
        const initial =
          fileIndex === undefined
            ? files.length === 1
              ? files[0]
              : null
            : files.find((f) => f.index === fileIndex);
        if (initial) await watch(initial);
        else phase = 'choose';
      } catch (e) {
        if (!disposed && !signal.aborted) {
          phase = 'error';
          message = e instanceof Error ? e.message : 'The file list could not be loaded.';
        }
      }
    })();
    const persist = () => save(true);
    const visibility = () => {
      if (document.hidden) persist();
    };
    window.addEventListener('pagehide', persist);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      disposed = true;
      stop();
      controller.abort();
      window.removeEventListener('pagehide', persist);
      document.removeEventListener('visibilitychange', visibility);
    };
  });
</script>

<svelte:window onkeydown={keys} />
<Modal title="Watch" close={leave} player>
  <div class="watch-heading">
    <span class="watch-mark"><Film size={21} /></span>
    <div>
      <h3>{selected ? selected.name.split('/').at(-1) : torrent.name}</h3>
      <p>
        {selected
          ? torrent.name
          : `${files.length || 'Finding'} video${files.length === 1 ? '' : 's'} · Choose a file to begin`}
      </p>
    </div>
    {#if selected}<span class="watch-header-status">
        <span class="watch-download" class:complete
          >{#if complete}<CheckCircle2 size={15} /><span>Downloaded</span>{:else}<span
              class="watch-live-dot"
            ></span><span
              >{percent(selected?.length ? downloaded / selected.length : 0)} downloaded</span
            >{/if}</span
        >{#if files[fileNumber]}<button class="text-button" onclick={() => watch(files[fileNumber])}
            >Next video<Play size={13} /></button
          >{/if}
      </span>{/if}
    {#if files.length > 1 && selected}<button
        class="button secondary watch-files-button"
        aria-label="Show video files"
        aria-expanded={listOpen}
        onclick={() => (listOpen = !listOpen)}
        ><ListVideo size={18} /><span>Files</span><small>{fileNumber}/{files.length}</small></button
      >{/if}
  </div>
  {#if phase === 'loading' || phase === 'preparing'}
    <div class="watch-placeholder" role="status">
      <LoaderCircle class="watch-spinner" size={30} />
      <h3>{phase === 'loading' ? 'Finding your videos' : 'Preparing your video'}</h3>
      <p>
        {phase === 'loading'
          ? 'Getting the file list…'
          : 'Enabling sequential download and connecting to your device…'}
      </p>
    </div>
  {:else if phase === 'error'}
    <div class="watch-placeholder watch-error" role="alert">
      <Film size={32} />
      <h3>{selected ? 'Unable to play this video' : 'Nothing to play yet'}</h3>
      <p>{message}</p>
      <div class="watch-error-actions">
        {#if selected}<button class="button primary" onclick={() => watch(selected!)}
            ><RotateCcw size={16} />Try again</button
          >{/if}{#if files.length > 1}<button
            class="button secondary"
            onclick={() => {
              stop();
              selected = null;
              phase = 'choose';
            }}><ListVideo size={16} />Choose another file</button
          >{/if}
      </div>
    </div>
  {:else if phase === 'ready'}
    <video-player class="drift-player">
      <media-container
        bind:this={canvas}
        use:fitPlayer
        class="watch-canvas"
        class:watch-fullscreen={fullscreen}
        class:watch-keyboard={keyboardControls}
        class:watch-resuming={resume !== null}
        onpointerdown={() => (keyboardControls = false)}
        role="group"
        aria-label="Video player"
      >
        <!-- Captions are exposed when the media provides text tracks. RPC text is never HTML. -->
        <!-- svelte-ignore a11y_media_has_caption -->
        <video
          bind:this={video}
          src={source}
          playsinline
          crossorigin="use-credentials"
          preload="auto"
          onloadedmetadata={metadata}
          onplay={() => (userPaused = false)}
          ontimeupdate={() => {
            current = video?.currentTime || 0;
            save();
          }}
          onplaying={() => {
            userPaused = false;
            paused = false;
            buffered();
            hasPlayed = true;
          }}
          onpause={() => {
            if (phase === 'ready' && video && video.readyState >= 1 && !video.error)
              userPaused = true;
            paused = true;
            buffered();
            save(true);
          }}
          oncanplay={buffered}
          onwaiting={buffering}
          onseeking={buffering}
          onseeked={() => {
            if (video && video.readyState >= 3) buffered();
            else buffering();
            save(true);
          }}
          onvolumechange={() => (muted = !!video?.muted || video?.volume === 0)}
          onended={() => {
            save(true);
            paused = true;
          }}
          onerror={mediaError}
        >
          {#each subtitleSources as subtitle (subtitle.index)}
            <track
              kind="subtitles"
              data-subtitle-index={subtitle.index}
              src={subtitleURLs[subtitle.index]}
              srclang={subtitle.language}
              label={subtitleLabel(subtitle)}
              onload={(e) => {
                const track = (e.currentTarget as HTMLTrackElement).track;
                track.mode = captions[captionIndex] === track ? 'showing' : 'disabled';
              }}
              onerror={(e) => {
                if (
                  subtitleURLs[subtitle.index] &&
                  captions[captionIndex] === (e.currentTarget as HTMLTrackElement).track
                )
                  captionStatus = 'These subtitles could not be displayed. Choose another track.';
              }}
            />
          {/each}
        </video>
        <media-gesture type="tap" pointer="mouse" action="togglePaused" disabled={resume !== null}
        ></media-gesture>
        <media-gesture
          type="doubletap"
          pointer="mouse"
          action="toggleFullscreen"
          disabled={resume !== null}
        ></media-gesture>
        {#if resume !== null}<div class="watch-overlay watch-resume">
            <span class="watch-overlay-icon"><RotateCcw size={26} /></span>
            <h3>Pick up where you left off</h3>
            <p>Continue from {clock(resume)}</p>
            <div>
              <button class="button primary" onclick={() => play(resume!)}
                ><Play size={17} fill="currentColor" />Resume from {clock(resume)}</button
              ><button class="button watch-start-over" onclick={() => play(0)}>Start over</button>
            </div>
          </div>
        {:else if paused && !waiting && duration > 0}<button
            class="watch-big-play"
            aria-label={current >= duration && duration > 0 ? 'Replay video' : 'Play video'}
            onclick={() => play()}><Play size={30} fill="currentColor" /></button
          >{/if}
        {#if (waiting || duration <= 0) && resume === null}<div
            class="watch-buffering"
            role="status"
          >
            <LoaderCircle class="watch-spinner" size={25} /><span
              >{waitingForPieces
                ? 'Waiting for download…'
                : duration <= 0
                  ? 'Loading video…'
                  : 'Buffering…'}</span
            >
          </div>{/if}
        <media-controls
          class="watch-controls"
          class:watch-controls-blocked={resume !== null}
          visibility={fullscreen && !captionMenu ? 'auto' : 'always'}
        >
          <media-controls-content>
            <media-time-slider aria-label="Seek video" class="watch-timeline"
              ><media-slider-track
                ><media-slider-buffer></media-slider-buffer><media-slider-fill
                ></media-slider-fill></media-slider-track
              ><media-slider-thumb></media-slider-thumb></media-time-slider
            >
            <media-controls-group class="watch-control-row" aria-label="Playback controls">
              <media-play-button class="watch-control" aria-label={paused ? 'Play' : 'Pause'}
                ><span class="when-paused"><Play size={20} fill="currentColor" /></span><span
                  class="when-playing"><Pause size={20} fill="currentColor" /></span
                ></media-play-button
              >
              <media-seek-button
                class="watch-control watch-skip"
                seconds={-10}
                aria-label="Back 10 seconds"
                ><RotateCcw size={19} /><small>10</small></media-seek-button
              >
              <media-seek-button
                class="watch-control watch-skip"
                seconds={10}
                aria-label="Forward 10 seconds"
                ><RotateCw size={19} /><small>10</small></media-seek-button
              >
              <span class="watch-time"
                ><media-time type="current"></media-time><span>/</span><media-time type="duration"
                ></media-time></span
              >
              <span class="watch-control-spacer"></span>
              <media-mute-button class="watch-control" aria-label={muted ? 'Unmute' : 'Mute'}
                ><span class="when-unmuted"><Volume2 size={20} /></span><span class="when-muted"
                  ><VolumeX size={20} /></span
                ></media-mute-button
              >
              <media-volume-slider class="watch-volume" aria-label="Volume"
                ><media-slider-track><media-slider-fill></media-slider-fill></media-slider-track
                ><media-slider-thumb></media-slider-thumb></media-volume-slider
              >
              <label class="watch-rate"
                ><span class="sr-only">Playback speed</span><select
                  aria-label="Playback speed"
                  bind:value={rate}
                  onchange={() => {
                    if (video) video.playbackRate = rate;
                  }}
                  >{#each [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as r}<option value={r}>{r}×</option
                    >{/each}</select
                ><ChevronDown size={12} /></label
              >
              {#if captions.length}<div class="watch-caption-picker">
                  <button
                    class="watch-control"
                    aria-label="Subtitles"
                    aria-busy={subtitleLoading !== null}
                    aria-expanded={captionMenu}
                    aria-haspopup="menu"
                    onclick={toggleCaptions}><Captions size={20} /></button
                  >{#if captionMenu}<div
                      class="watch-caption-menu"
                      role="menu"
                      aria-label="Subtitles"
                      tabindex="-1"
                      onkeydown={(e) => {
                        if (e.key === 'Escape') {
                          e.preventDefault();
                          e.stopPropagation();
                          captionMenu = false;
                          canvas?.querySelector<HTMLElement>('[aria-label="Subtitles"]')?.focus();
                        }
                        if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
                          e.preventDefault();
                          e.stopPropagation();
                          const buttons = Array.from(
                            e.currentTarget.querySelectorAll<HTMLButtonElement>('button'),
                          );
                          const index = buttons.indexOf(
                            document.activeElement as HTMLButtonElement,
                          );
                          buttons[
                            e.key === 'Home'
                              ? 0
                              : e.key === 'End'
                                ? buttons.length - 1
                                : (index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) %
                                  buttons.length
                          ]?.focus();
                        }
                      }}
                    >
                      <button
                        role="menuitemradio"
                        aria-checked={captionIndex === -1}
                        onclick={() => setCaption(-1)}
                        >Off{#if captionIndex === -1}<Check size={14} />{/if}</button
                      >{#each captions as track, i}<button
                          role="menuitemradio"
                          aria-checked={captionIndex === i}
                          onclick={() => setCaption(i)}
                          >{track.label ||
                            track.language ||
                            `Track ${i + 1}`}{#if captionIndex === i}<Check
                              size={14}
                            />{/if}</button
                        >{/each}
                    </div>{/if}
                </div>{/if}
              <media-airplay-button class="watch-control watch-airplay" aria-label="AirPlay"
                ><Airplay size={20} /></media-airplay-button
              >
              <media-pip-button class="watch-control watch-pip" aria-label="Picture in picture"
                ><PictureInPicture2 size={20} /></media-pip-button
              >
              <media-fullscreen-button
                class="watch-control watch-fullscreen"
                aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
                ><span class="when-windowed"><Maximize size={20} /></span><span
                  class="when-fullscreen"><Minimize size={20} /></span
                ></media-fullscreen-button
              >
            </media-controls-group>
          </media-controls-content>
        </media-controls>
        <media-status-announcer></media-status-announcer>
        {#if captionStatus}<div class="watch-subtitle-status" role="status">
            {captionStatus}
          </div>{/if}
      </media-container>
    </video-player>
  {/if}
  {#if phase === 'choose' || listOpen}
    <section class="watch-library" aria-label="Video files">
      <header>
        <span class="eyebrow">{phase === 'choose' ? 'CHOOSE A VIDEO' : 'IN THIS TORRENT'}</span
        ><span>{files.length} files</span>
      </header>
      {#each files as file}{@const position = playbackPosition(
          positionKey(endpoint, torrent.hashString, file),
        )}<button
          class="watch-file"
          class:active={selected?.index === file.index}
          onclick={() => watch(file)}
          ><span class="watch-file-icon"
            >{#if selected?.index === file.index}<Play size={18} fill="currentColor" />{:else}<Film
                size={20}
              />{/if}</span
          ><span class="watch-file-name"
            ><b>{file.name.split('/').at(-1)}</b><small
              >{position ? `Continue from ${clock(position.time)} · ` : ''}{bytes(file.length)} · {file.bytesCompleted >=
              file.length
                ? 'Downloaded'
                : `${percent(file.bytesCompleted / file.length)} downloaded`}</small
            ></span
          ><span class="watch-file-play"><Play size={16} /></span></button
        >{/each}
    </section>
  {/if}
</Modal>
