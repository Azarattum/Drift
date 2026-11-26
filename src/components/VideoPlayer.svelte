<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import {
    Airplay,
    Check,
    CheckCircle2,
    Captions,
    ChevronDown,
    Circle,
    CircleArrowDown,
    Download,
    MinusCircle,
    Film,
    FolderOpen,
    Languages,
    ListVideo,
    LoaderCircle,
    Maximize,
    Minimize,
    Pause,
    PictureInPicture2,
    Play,
    RotateCcw,
    RotateCw,
    Trash2,
    Volume2,
    VolumeX,
  } from '@lucide/svelte';
  import Modal from './Modal.svelte';
  import DiscardFileDialog from './DiscardFileDialog.svelte';
  import { canDiscardFileData } from '../lib/file-discard';
  import PriorityControl from './PriorityControl.svelte';
  import { client } from '../lib/client.svelte';
  import type { FileStat, Torrent } from '../lib/types';
  import { bytes, percent } from '../lib/format';
  import {
    clock,
    playbackAudio,
    savePlaybackAudio,
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
  import {
    canEnhanceFormats,
    mediaTrackLabel,
    needsAudioDecoder,
    probeMatroskaTracks,
    type MatroskaTrack,
  } from '../lib/media-format';
  import type { openEmbeddedSubtitles } from '../lib/embedded-subtitles';
  import type { FormatEngine } from '../lib/format-engine';
  import { fetchSubtitle, subtitleLabel, type SubtitleSource } from '../lib/subtitles';
  let { torrent, fileIndex, close }: { torrent: Torrent; fileIndex?: number; close: () => void } =
    $props();
  const endpoint = client.rpc.endpoint;
  const savedAudio = playbackAudio();
  let files = $state<VideoFile[]>([]);
  let selected = $state<VideoFile | null>(null);
  let phase = $state<'loading' | 'choose' | 'preparing' | 'ready' | 'error'>('loading');
  let message = $state('');
  let source = $state('');
  let enhanced = $state(false);
  let enhancing = $state(false);
  let formatAttempted = false;
  let formatProbed = false;
  let containerProbe: Promise<void> | undefined;
  let formatEngine: FormatEngine | undefined;
  let formatCleanup: Promise<void> = Promise.resolve();
  let audioNotice = $state('');
  type NativeAudioTrack = { label: string; language: string; enabled: boolean };
  type NativeAudioTracks = EventTarget & ArrayLike<NativeAudioTrack>;
  let nativeAudioTracks = $state.raw<NativeAudioTrack[]>([]);
  let formatAudioTracks = $state.raw<FormatEngine['audioTracks']>([]);
  let audioIndex = $state(-1);
  let audioSwitching = $state(false);
  let audioStatus = $state('');
  let containerAudio = $state<MatroskaTrack[]>([]);
  let containerTracks: MatroskaTrack[] = [];
  let remuxed = $state(false);
  let remuxRequest: AbortController | null = null;
  let remuxPrevious: AbortController | null = null;
  let restorePause = false;
  let audioOptionsSource = $derived(
    enhanced
      ? formatAudioTracks
      : nativeAudioTracks.length > 1
        ? nativeAudioTracks
        : containerAudio,
  );
  let audioOptions = $derived(
    audioOptionsSource.map(
      (track, i) =>
        (!enhanced &&
          !remuxed &&
          nativeAudioTracks.length > 1 &&
          'label' in track &&
          track.label) ||
        mediaTrackLabel(track, `Track ${i + 1}`),
    ),
  );
  $effect(() => {
    const tracks = (video as (HTMLVideoElement & { audioTracks?: NativeAudioTracks }) | undefined)
      ?.audioTracks;
    function update() {
      nativeAudioTracks = Array.from(tracks ?? []);
      if (nativeAudioTracks.length > 1)
        audioIndex = nativeAudioTracks.findIndex((track) => track.enabled);
      else if (!containerAudio.length) audioIndex = -1;
    }
    if (enhanced || remuxed) return;
    untrack(update);
    for (const event of ['addtrack', 'removetrack', 'change'])
      tracks?.addEventListener(event, update);
    return () => {
      for (const event of ['addtrack', 'removetrack', 'change'])
        tracks?.removeEventListener(event, update);
    };
  });
  async function setAudio(index: number) {
    audioStatus = '';
    const engine = formatEngine;
    if (!engine) {
      if (remuxed || nativeAudioTracks.length <= 1) {
        if (containerAudio[index] && index !== audioIndex) await switchStreamAudio(index);
        return;
      }
      if (!nativeAudioTracks[index]) return;
      for (const [i, track] of nativeAudioTracks.entries()) track.enabled = i === index;
      audioIndex = index;
      return;
    }
    const track = formatAudioTracks[index];
    if (!track || audioSwitching) return;
    audioSwitching = true;
    try {
      await engine.setAudioTrack(track.id);
      if (engine === formatEngine) audioIndex = index;
    } catch {
      if (engine === formatEngine) audioStatus = 'Could not switch audio tracks.';
    } finally {
      if (engine === formatEngine) audioSwitching = false;
    }
  }
  async function switchStreamAudio(index: number, seekTime?: number, nativeFailed = false) {
    const target = video;
    const track = containerAudio[index];
    if (!target || !track || audioSwitching || phase !== 'ready') return;
    if (typeof MediaSource === 'undefined') {
      audioStatus = 'This browser cannot switch the embedded audio in this file.';
      return;
    }
    const time = seekTime ?? resume ?? target.currentTime;
    const shouldPlay =
      resume === null &&
      (seekTime !== undefined || target.readyState === 0 ? !userPaused : !target.paused);
    const previous = remuxRequest;
    const request = new AbortController();
    remuxRequest = request;
    remuxPrevious = previous;
    const url = source;
    audioSwitching = true;
    audioStatus = 'Switching audio…';
    let attached = false;
    let ready = false;
    const failure = () => {
      if (request.signal.aborted || remuxRequest !== request || disposed) return;
      request.abort();
      if (ready) {
        remuxRequest = null;
        audioStatus = 'Waiting for more video data…';
        buffering();
        return;
      }
      remuxRequest = previous && !attached ? previous : null;
      remuxPrevious = null;
      audioSwitching = false;
      audioStatus =
        'Could not switch audio tracks. Try again when more of the file has downloaded.';
      if (nativeFailed) {
        remuxed = false;
        pendingSeek = time;
        userPaused = !shouldPlay;
        if (canEnhanceFormats() && !formatAttempted) void enhanceFormat();
        else {
          phase = 'error';
          message =
            'This browser could not play the recording. Wait for more data or try another browser.';
          stop();
          controller.abort();
        }
        return;
      }
      if (!attached) return;
      remuxed = false;
      const preferred = containerAudio.findIndex((item) => item.preferred);
      audioIndex = Math.max(0, preferred);
      pendingSeek = time;
      restorePause = !shouldPlay;
      target.src = url;
    };
    const timeout = setTimeout(failure, 45000);
    try {
      const { remuxAudio } = await import('../lib/audio-remux');
      if (request.signal.aborted) return;
      await remuxAudio(
        target,
        url,
        track.number,
        time,
        !complete,
        request.signal,
        () => {
          previous?.abort();
          remuxPrevious = null;
          attached = true;
          remuxed = true;
          target.pause();
        },
        () => {
          if (request.signal.aborted) return;
          clearTimeout(timeout);
          ready = true;
          audioIndex = index;
          audioSwitching = false;
          audioStatus = '';
          target.playbackRate = rate;
          if (shouldPlay) void play();
        },
      );
      if (!ready) failure();
    } catch {
      failure();
    } finally {
      clearTimeout(timeout);
    }
  }
  function seekRemux() {
    if (!remuxed || !video || audioSwitching) return;
    const time = video.currentTime;
    for (let i = 0; i < video.buffered.length; i++) {
      if (time >= video.buffered.start(i) - 0.05 && time <= video.buffered.end(i)) return;
    }
    void switchStreamAudio(audioIndex, time);
  }
  async function enhanceFormat() {
    if (!video || formatAttempted || !canEnhanceFormats() || phase !== 'ready') return false;
    formatAttempted = true;
    enhancing = true;
    const target = video;
    const signal = controller.signal;
    const at = pendingSeek ?? target.currentTime;
    const shouldPlay = resume === null && !userPaused;
    const timer = setTimeout(() => {
      if (signal.aborted || disposed || target !== video) return;
      message = 'This video format could not be prepared. Try again or open it in your video app.';
      phase = 'error';
      stop();
      controller.abort();
    }, 45000);
    target.pause();
    buffered();
    waiting = true;
    try {
      const { attachFormatEngine } = await import('../lib/format-engine');
      if (signal.aborted || disposed) return false;
      await formatCleanup;
      prioritizeSoon();
      const engine = await attachFormatEngine(target, source, signal, () => {
        if (signal.aborted || disposed) return;
        message =
          'This video format could not be played. Try another browser or open it in your video app.';
        phase = 'error';
        stop();
        controller.abort();
      });
      if (signal.aborted || disposed) {
        await engine.destroy();
        return false;
      }
      formatEngine = engine;
      enhanced = true;
      formatAudioTracks = engine.audioTracks;
      audioIndex = formatAudioTracks.length ? 0 : -1;
      enhancing = false;
      audioNotice = '';
      if (at > 0) pendingSeek = at;
      restored = false;
      metadata();
      if (!shouldPlay) target.pause();
      return true;
    } catch {
      if (!signal.aborted && !disposed) {
        enhancing = false;
        waiting = false;
        phase = 'error';
        message =
          'This video format could not be played. Try another browser or open it in your video app.';
        stop();
        controller.abort();
      }
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
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
      if (priorityURL === url) waitingForPieces = false;
      /* The streaming connection and bounded recovery own user-facing errors. */
    } finally {
      clearTimeout(timer);
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
    muted = $state(savedAudio.muted || savedAudio.volume === 0);
  $effect(() => {
    if (!video) return;
    const settings = playbackAudio();
    video.volume = settings.volume;
    video.muted = settings.muted;
  });
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
    if (remuxed && audioIndex >= 0) {
      void switchStreamAudio(audioIndex, at);
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
        enhancing ||
        audioSwitching ||
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
  let fileStats = $state<FileStat[]>([]);
  let discardAvailable = $state(false);
  let discardTarget = $state<VideoFile | null>(null);
  $effect(() => {
    const request = new AbortController();
    void canDiscardFileData(
      endpoint,
      client.rpc.username,
      client.rpc.password,
      request.signal,
    ).then((available) => {
      if (!request.signal.aborted) discardAvailable = available;
    });
    return () => request.abort();
  });
  let fileMenu = $state<{ file: VideoFile; left: number; top: number } | null>(null);
  let fileMenuElement = $state<HTMLDivElement>();
  let fileMenuTrigger: HTMLElement | null = null;
  let fileMenuScrollTop = 0;
  let fileActionBusy = $state(false);
  let fileMenuPress: { x: number; y: number; timer: ReturnType<typeof setTimeout> } | null = null;
  let longPressedFile: number | null = null;
  function cancelFileMenuPress() {
    clearTimeout(fileMenuPress?.timer);
    fileMenuPress = null;
  }
  function startFileMenuPress(event: PointerEvent, file: VideoFile) {
    cancelFileMenuPress();
    longPressedFile = null;
    if (event.pointerType !== 'touch' || !event.isPrimary) return;
    const trigger = event.currentTarget as HTMLElement;
    const { clientX: x, clientY: y } = event;
    fileMenuPress = {
      x,
      y,
      timer: setTimeout(() => {
        fileMenuPress = null;
        if (!trigger.isConnected) return;
        longPressedFile = file.index;
        void openVideoFileMenu(trigger, file, { x, y });
      }, 500),
    };
  }
  function closeVideoFileMenu(restoreFocus = true) {
    fileMenu = null;
    if (restoreFocus) fileMenuTrigger?.focus({ preventScroll: true });
    fileMenuTrigger = null;
  }
  async function openVideoFileMenu(
    trigger: HTMLElement,
    file: VideoFile,
    point?: { x: number; y: number },
  ) {
    const anchor = trigger.getBoundingClientRect();
    const view = trigger.closest('dialog')!.getBoundingClientRect();
    fileMenuTrigger = trigger;
    fileMenuScrollTop = fileList?.scrollTop ?? 0;
    fileMenu = { file, left: point?.x ?? anchor.left, top: point?.y ?? anchor.bottom };
    await tick();
    if (!fileMenuElement || fileMenu?.file.index !== file.index) return;
    fileMenuElement.style.maxHeight = `${view.height - 16}px`;
    const menu = fileMenuElement.getBoundingClientRect();
    const left = Math.max(
      view.left + 8,
      Math.min(point?.x ?? anchor.left, view.right - menu.width - 8),
    );
    const below = (point?.y ?? anchor.bottom) + 5;
    const above = (point?.y ?? anchor.top) - menu.height - 5;
    const top = below + menu.height <= view.bottom - 8 ? below : Math.max(view.top + 8, above);
    fileMenu = { file, left, top };
    fileMenuElement.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus({
      preventScroll: true,
    });
  }
  async function updateVideoFile(
    file: VideoFile,
    change: { priority: number } | { wanted: boolean },
  ) {
    if (fileActionBusy || client.rpc.endpoint !== endpoint) return;
    const previous = fileStats[file.index];
    const property =
      'wanted' in change
        ? change.wanted
          ? 'files-wanted'
          : 'files-unwanted'
        : change.priority === 1
          ? 'priority-high'
          : change.priority === -1
            ? 'priority-low'
            : 'priority-normal';
    fileActionBusy = true;
    try {
      await client.rpc.call('torrent-set', { ids: [torrent.hashString], [property]: [file.index] });
      if (disposed || client.rpc.endpoint !== endpoint) return;
      fileStats[file.index] = {
        bytesCompleted: file.bytesCompleted,
        wanted: previous?.wanted ?? true,
        priority: previous?.priority ?? 0,
        ...change,
      };
      void client.poll(true);
      if ('wanted' in change && fileMenu?.file.index === file.index) closeVideoFileMenu();
    } catch (error) {
      if (!disposed)
        client.toast(error instanceof Error ? error.message : 'Could not update the file.');
    } finally {
      fileActionBusy = false;
    }
  }
  let listOpen = $state(false);
  let fileList = $state<HTMLUListElement>();
  let filesButton = $state<HTMLButtonElement>();
  $effect(() => {
    if (!fileList || !listOpen) return;
    const active = fileList.querySelector('[aria-current="true"]');
    if (!active) return;
    const row = active.getBoundingClientRect();
    const top = fileList.getBoundingClientRect().top + fileList.clientTop;
    const bottom = top + fileList.clientHeight;
    if (row.top < top) fileList.scrollTop += Math.floor(row.top - top);
    else if (row.bottom > bottom) fileList.scrollTop += Math.ceil(row.bottom - bottom);
  });
  let rate = $state(1);
  let recoverySubtitle: number | undefined;
  let captions = $state<TextTrack[]>([]);
  let captionMenu = $state(false);
  let captionIndex = $state(-1);
  let subtitleSources = $state<SubtitleSource[]>([]);
  let subtitleURLs = $state<Record<number, string>>({});
  let captionStatus = $state('');
  let subtitleLoading = $state<number | null>(null);
  let captionLoad: AbortController | null = null;
  let captionRetry: ReturnType<typeof setTimeout>;
  const embeddedTracks = new Map<TextTrack, number>();
  let embedded: {
    request: AbortController;
    track: TextTrack;
    reader?: Awaited<ReturnType<typeof openEmbeddedSubtitles>>;
    loading: boolean;
    from: number;
    until: number;
  } | null = null;
  function addContainerSubtitles(target: HTMLVideoElement, tracks: MatroskaTrack[]) {
    if (
      !tracks.length ||
      embeddedTracks.size > 0 ||
      typeof VTTCue === 'undefined' ||
      Array.from(target.textTracks).some(
        (track) =>
          !externalSource(track) && (track.kind === 'subtitles' || track.kind === 'captions'),
      )
    )
      return;
    tracks
      .filter((track) => track.type === 17)
      .forEach((track, index) => {
        if (track.codec !== 'S_TEXT/UTF8') return;
        const textTrack = target.addTextTrack(
          'subtitles',
          mediaTrackLabel(track, `Embedded track ${index + 1}`),
          track.language,
        );
        embeddedTracks.set(textTrack, index);
      });
  }
  function updateEmbeddedSubtitles() {
    const active = embedded;
    if (!active?.reader || active.loading || !video) return;
    const time = video.currentTime;
    if (time >= active.from && time + 5 < active.until) return;
    if (time < active.from) {
      const index = embeddedTracks.get(active.track);
      if (index !== undefined) selectEmbeddedSubtitle(active.track, index, true);
      return;
    }
    clearTimeout(captionRetry);
    active.loading = true;
    const readFrom = Math.max(time, active.until);
    const reader = active.reader;
    for (const cue of Array.from(active.track.cues ?? [])) {
      if (cue.endTime < time - 10) active.track.removeCue(cue);
    }
    active.from = Math.max(active.from, time - 10);
    void reader
      .read(readFrom, time + 18, (cue) => {
        if (embedded !== active || active.request.signal.aborted) return;
        // Text in the container must not be interpreted as WebVTT markup.
        const text = cue.text
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;');
        // Retried byte ranges may contain cues that were already displayed.
        if (
          !Array.from(active.track.cues ?? []).some(
            (existing) =>
              existing.startTime === cue.start &&
              existing.endTime === cue.end &&
              (existing as VTTCue).text === text,
          )
        )
          active.track.addCue(new VTTCue(cue.start, cue.end, text));
        captionStatus = '';
      })
      .then((until) => {
        if (embedded !== active) return;
        active.until = until;
        captionStatus = '';
        if (until < time + 5) captionRetry = setTimeout(updateEmbeddedSubtitles, 100);
      })
      .catch(() => {
        if (embedded !== active) return;
        captionStatus = 'Waiting for embedded subtitles…';
        const index = embeddedTracks.get(active.track);
        if (index !== undefined)
          captionRetry = setTimeout(() => selectEmbeddedSubtitle(active.track, index, true), 2000);
      })
      .finally(() => {
        active.loading = false;
      });
  }
  function selectEmbeddedSubtitle(track: TextTrack, index: number, restart = false) {
    if (embedded?.track === track && !restart) return;
    if (restart && video && video.currentTime < (embedded?.from ?? -1))
      for (const cue of Array.from(track.cues ?? [])) track.removeCue(cue);
    cancelCaptionLoad();
    const request = new AbortController();
    const active: NonNullable<typeof embedded> = {
      request,
      track,
      loading: false,
      from: -1,
      until: -1,
    };
    embedded = active;
    captionStatus = 'Loading embedded subtitles…';
    const url = source;
    const open = async () => {
      if (request.signal.aborted) return;
      try {
        const { openEmbeddedSubtitles } = await import('../lib/embedded-subtitles');
        active.reader = await openEmbeddedSubtitles(url, index, !complete, request.signal);
        if (!request.signal.aborted) updateEmbeddedSubtitles();
      } catch {
        if (request.signal.aborted) return;
        captionStatus = 'Waiting for embedded subtitles…';
        captionRetry = setTimeout(open, 2000);
      }
    };
    void open();
  }
  function cancelCaptionLoad() {
    clearTimeout(captionRetry);
    captionLoad?.abort();
    captionLoad = null;
    embedded?.request.abort();
    embedded = null;
    subtitleLoading = null;
    captionStatus = '';
  }
  function clearSubtitles() {
    cancelCaptionLoad();
    for (const url of Object.values(subtitleURLs)) URL.revokeObjectURL(url);
    subtitleURLs = {};
    subtitleSources = [];
    embeddedTracks.clear();
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
    const index = embeddedTracks.get(track);
    if (index !== undefined) {
      selectEmbeddedSubtitle(track, index);
      return;
    }
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
            { ids: [torrent.hashString], fields: ['hashString', 'files', 'fileStats'] },
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
            if (!fileActionBusy && updated.fileStats) fileStats = updated.fileStats;
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
  $effect(() => {
    if (phase !== 'choose' && (!listOpen || !complete)) return;
    const request = new AbortController();
    let refreshing = false;
    const timer = setInterval(async () => {
      if (refreshing || document.hidden || client.rpc.endpoint !== endpoint) return;
      refreshing = true;
      try {
        const { torrents } = await client.rpc.call<{ torrents: Torrent[] }>(
          'torrent-get',
          { ids: [torrent.hashString], fields: ['hashString', 'files', 'fileStats'] },
          request.signal,
        );
        const updated = torrents.find((item) => item.hashString === torrent.hashString);
        if (request.signal.aborted || !updated) return;
        files = videoFiles(updated.files);
        if (!fileActionBusy && updated.fileStats) fileStats = updated.fileStats;
      } catch {
        // Keep the last known list while the connection is unavailable.
      } finally {
        refreshing = false;
      }
    }, 3000);
    return () => {
      clearInterval(timer);
      request.abort();
    };
  });
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
    const engine = formatEngine;
    formatEngine = undefined;
    if (engine) formatCleanup = engine.destroy().catch(() => {});
    remuxRequest?.abort();
    remuxPrevious?.abort();
    remuxRequest = null;
    remuxPrevious = null;
    remuxed = false;
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
    enhanced = false;
    enhancing = false;
    formatAttempted = false;
    formatProbed = false;
    containerProbe = undefined;
    audioNotice = '';
    audioStatus = '';
    audioSwitching = false;
    formatAudioTracks = [];
    containerAudio = [];
    containerTracks = [];
    restorePause = false;
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
    closeVideoFileMenu(false);
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
      inspectContainer();
      buffering();
      if (video) video.playbackRate = rate;
      if (previousSubtitle !== undefined) {
        const track = video?.querySelector<HTMLTrackElement>(
          `track[data-subtitle-index="${previousSubtitle}"]`,
        );
        if (track) {
          captions = Array.from(video!.textTracks).filter(
            (t) => t.kind === 'subtitles' || t.kind === 'captions',
          );
          setCaption(captions.indexOf(track.track));
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
  function inspectContainer() {
    if (formatProbed) return containerProbe;
    if (!video || !selected || !/\.(mkv|webm)$/i.test(selected.name)) return;
    formatProbed = true;
    const target = video;
    const signal = controller.signal;
    containerProbe = probeMatroskaTracks(source, signal).then((tracks) => {
      if (signal.aborted || disposed || target !== video) return;
      if (!tracks.length) {
        // The streaming range may have reached an unverified piece before the track header.
        formatProbed = false;
        return;
      }
      containerTracks = tracks;
      containerAudio = tracks.filter((track) => track.type === 2);
      if (target.readyState > 0) {
        addContainerSubtitles(target, tracks);
        if (!enhanced && !remuxed && nativeAudioTracks.length <= 1)
          audioIndex = Math.max(
            0,
            containerAudio.findIndex((track) => track.preferred),
          );
      }
      const codec = (containerAudio.find((track) => track.preferred) ?? containerAudio[0])?.codec;
      if (enhanced || remuxed || !needsAudioDecoder(codec, target)) return;
      if (!canEnhanceFormats()) audioNotice = 'This browser can’t play the audio in this video.';
      else void enhanceFormat();
    });
    return containerProbe;
  }
  function metadata() {
    if (!video || enhancing) return;
    duration = video.duration;
    inspectContainer();
    addContainerSubtitles(video, containerTracks);
    if (remuxed) return;
    if (!enhanced && audioIndex < 0 && containerAudio.length && nativeAudioTracks.length <= 1)
      audioIndex = Math.max(
        0,
        containerAudio.findIndex((track) => track.preferred),
      );
    if (pendingSeek !== null) {
      const at = pendingSeek;
      pendingSeek = null;
      restored = true;
      if (restorePause) {
        restorePause = false;
        video.currentTime = at;
      } else void play(at);
      return;
    }
    if (restored) return;
    restored = true;
    if (resume !== null && (!Number.isFinite(duration) || resume >= duration - 10)) resume = null;
    if (resume === null) void play();
  }
  async function mediaError() {
    if (!video?.error || !source || phase !== 'ready' || audioSwitching) return;
    if (remuxed) {
      recover(current, 'The audio stream could not be resumed. Try again shortly.', !userPaused);
      return;
    }
    const code = video.error.code;
    const at = pendingSeek ?? video.currentTime;
    const resumePlayback = resume === null && !userPaused;
    const missingPieces = waitingForPieces;
    const url = source;
    recoverySubtitle = externalSource(captions[captionIndex])?.index;
    const signal = controller.signal;
    buffered();
    const status = await streamStatus(url, signal);
    if (disposed || signal.aborted || source !== url) return;
    const ready = status === 200 || status === 206;
    if (
      ready &&
      !missingPieces &&
      (code === 3 || code === 4) &&
      typeof MediaSource !== 'undefined'
    ) {
      await inspectContainer();
      if (disposed || signal.aborted || source !== url || audioSwitching || enhancing) return;
      const defaultAudio = Math.max(
        0,
        containerAudio.findIndex((track) => track.preferred),
      );
      if (containerAudio[defaultAudio]?.codec === 'A_AAC') {
        await switchStreamAudio(defaultAudio, at, true);
        return;
      }
    }
    if (
      ready &&
      !missingPieces &&
      (code === 3 || code === 4) &&
      !formatAttempted &&
      canEnhanceFormats()
    ) {
      pendingSeek = at;
      userPaused = !resumePlayback;
      await enhanceFormat();
      return;
    }
    phase = 'error';
    message = 'Checking the stream connection…';
    stop();
    controller.abort();
    controller = new AbortController();
    const recoverySignal = controller.signal;
    const terminal: Record<number, string> = {
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
      if (!disposed && !recoverySignal.aborted) recover(at, reason, resumePlayback);
    }, 350);
  }
  function keys(e: KeyboardEvent) {
    if (phase === 'ready') keyboardControls = true;
    if (
      phase !== 'ready' ||
      enhancing ||
      !video ||
      e.altKey ||
      e.ctrlKey ||
      e.metaKey ||
      resume !== null
    )
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
    const content = node.closest<HTMLElement>('.watch-content')!;
    const controls = node.querySelector<HTMLElement>('.watch-controls');
    let frame = 0;
    function update() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (node.classList.contains('watch-fullscreen')) return;
        const media = node.querySelector('video, .watch-preparing-frame');
        if (!media) return;
        const style = getComputedStyle(dialog);
        const maximum = parseFloat(style.maxHeight);
        if (controls)
          content.style.setProperty(
            '--watch-measured-controls-space',
            `${controls.offsetHeight}px`,
          );
        node.style.setProperty('--watch-full-width-height', `${(dialog.clientWidth * 9) / 16}px`);
        const player = node.closest('.drift-player')!;
        const other =
          player.getBoundingClientRect().top -
          body.getBoundingClientRect().top +
          player.getBoundingClientRect().height -
          media.getBoundingClientRect().height;
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
    if (controls) observer.observe(controls);
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
          { ids: [torrent.hashString], fields: ['id', 'hashString', 'name', 'files', 'fileStats'] },
          signal,
        );
        if (disposed || signal.aborted) return;
        const found = r.torrents.find((t) => t.hashString === torrent.hashString);
        if (!found) throw new Error('This torrent is no longer available.');
        files = videoFiles(found.files);
        fileStats = found.fileStats ?? [];
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
      cancelFileMenuPress();
      stop();
      controller.abort();
      window.removeEventListener('pagehide', persist);
      document.removeEventListener('visibilitychange', visibility);
    };
  });
</script>

<svelte:window
  onkeydown={keys}
  onresize={() => closeVideoFileMenu(false)}
  onclick={(event) => {
    if (fileMenu && event.target instanceof Element && !event.target.closest('.watch-file-menu'))
      closeVideoFileMenu(false);
    if (
      captionMenu &&
      event.target instanceof Element &&
      !event.target.closest('.watch-caption-picker')
    )
      captionMenu = false;
  }}
/>
{#snippet titleIcon()}
  {#if selected}
    <span class="watch-mark" aria-hidden="true"><Film size={30} /></span>
  {:else}
    <span class="watch-collection-icon" aria-hidden="true"><FolderOpen size={24} /></span>
  {/if}
{/snippet}
{#snippet titleDetails()}
  {#if selected}
    <div class="watch-meta">
      <p title={torrent.name}>{torrent.name}</p>
      <span class="watch-download" class:complete>
        {#if complete}<CheckCircle2 size={14} />Downloaded
        {:else}<span class="watch-live-dot"></span>{percent(
            selected.length ? downloaded / selected.length : 0,
          )} downloaded{/if}
      </span>
      {#if audioNotice}<span class="watch-audio-notice" title={audioNotice}>{audioNotice}</span
        >{/if}
    </div>
  {/if}
{/snippet}
{#snippet headerActions()}
  {#if files.length > 1 && selected}
    <div class="watch-actions">
      {#if files[fileNumber]}
        <button class="button secondary watch-next-button" onclick={() => watch(files[fileNumber])}>
          <span>Next video</span><Play size={14} />
        </button>
      {/if}
      <button
        bind:this={filesButton}
        class="button secondary watch-files-button"
        class:active={listOpen}
        aria-label="Show video files"
        aria-expanded={listOpen}
        aria-controls={listOpen ? 'watch-file-list' : undefined}
        onclick={() => (listOpen = !listOpen)}
        ><ListVideo size={18} /><span>Files</span><small>{fileNumber}/{files.length}</small></button
      >
    </div>
  {/if}
{/snippet}
<Modal
  title={selected ? (selected.name.split('/').at(-1) ?? selected.name) : torrent.name}
  {titleIcon}
  {titleDetails}
  {headerActions}
  close={leave}
  player={selected ? 'playback' : 'chooser'}
>
  <div
    class="watch-content"
    class:watch-with-library={(phase === 'ready' || phase === 'preparing') && listOpen}
  >
    {#if phase === 'loading'}
      <div class="watch-placeholder" role="status">
        <LoaderCircle class="watch-spinner" size={30} />
        <h3>Finding your videos</h3>
        <p>Getting the file list…</p>
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
    {:else if phase === 'preparing'}
      <div class="drift-player watch-canvas watch-preparing" use:fitPlayer>
        <div class="watch-preparing-frame"></div>
        <div class="watch-overlay" role="status">
          <LoaderCircle class="watch-spinner" size={30} />
          <h3>Preparing your video</h3>
        </div>
      </div>
    {:else if phase === 'ready'}
      <video-player class="drift-player">
        <media-container
          bind:this={canvas}
          use:fitPlayer
          class="watch-canvas"
          data-format-enhanced={enhanced || undefined}
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
              updateEmbeddedSubtitles();
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
            onseeking={() => {
              seekRemux();
              buffering();
            }}
            onseeked={() => {
              if (video && video.readyState >= 3) buffered();
              else buffering();
              updateEmbeddedSubtitles();
              save(true);
            }}
            onvolumechange={() => {
              if (!video) return;
              muted = video.muted || video.volume === 0;
              savePlaybackAudio(video.volume, video.muted);
            }}
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
          {:else if paused && !waiting && !enhancing && duration > 0}<button
              class="watch-big-play"
              aria-label={current >= duration && duration > 0 ? 'Replay video' : 'Play video'}
              onclick={() => play()}><Play size={30} fill="currentColor" /></button
            >{/if}
          {#if (waiting || enhancing || duration <= 0) && resume === null}<div
              class="watch-buffering"
              role="status"
            >
              <LoaderCircle class="watch-spinner" size={25} /><span
                >{enhancing
                  ? 'Preparing playback…'
                  : waitingForPieces
                    ? 'Waiting for download…'
                    : duration <= 0
                      ? 'Loading video…'
                      : 'Buffering…'}</span
              >
            </div>{/if}
          <media-controls
            class="watch-controls"
            inert={enhancing || resume !== null}
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
                <div class="watch-transport">
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
                    ><media-time type="current"></media-time><span>/</span><media-time
                      type="duration"
                    ></media-time></span
                  >
                </div>
                <div class="watch-control-options">
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
                  {#if audioOptions.length > 1 && !enhancing}
                    <label class="watch-audio">
                      <Languages size={19} />
                      <span>Audio</span><ChevronDown size={12} />
                      <select
                        aria-label="Audio track"
                        value={audioIndex}
                        disabled={audioSwitching}
                        onchange={(event) => {
                          const select = event.currentTarget;
                          const index = Number(select.value);
                          select.value = String(audioIndex);
                          void setAudio(index);
                        }}
                      >
                        {#if audioIndex < 0}<option value={-1} disabled>Choose a track</option>{/if}
                        {#each audioOptions as label, i}
                          <option value={i}>{label}</option>
                        {/each}
                      </select>
                    </label>
                  {/if}
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
                              canvas
                                ?.querySelector<HTMLElement>('[aria-label="Subtitles"]')
                                ?.focus();
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
                  {#if !enhanced}<media-airplay-button
                      class="watch-control watch-airplay"
                      aria-label="AirPlay"><Airplay size={20} /></media-airplay-button
                    >
                    <media-pip-button
                      class="watch-control watch-pip"
                      aria-label="Picture in picture"
                      ><PictureInPicture2 size={20} /></media-pip-button
                    >{/if}
                  <media-fullscreen-button
                    class="watch-control watch-fullscreen"
                    aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
                    ><span class="when-windowed"><Maximize size={20} /></span><span
                      class="when-fullscreen"><Minimize size={20} /></span
                    ></media-fullscreen-button
                  >
                </div>
              </media-controls-group>
            </media-controls-content>
          </media-controls>
          <media-status-announcer></media-status-announcer>
          {#if captionStatus || audioStatus}<div class="watch-subtitle-status" role="status">
              {audioStatus || captionStatus}
            </div>{/if}
        </media-container>
      </video-player>
    {/if}
    {#if phase === 'choose' || listOpen}
      <section id="watch-file-list" class="watch-library" aria-label="Video files">
        <header>
          <h3>{phase === 'choose' ? 'Choose a video' : 'Video files'}</h3>
          <span>{files.length} files</span>
        </header>
        <ul
          class="watch-file-list"
          role="list"
          bind:this={fileList}
          onscroll={() => {
            cancelFileMenuPress();
            if (fileMenu && fileList?.scrollTop !== fileMenuScrollTop) closeVideoFileMenu(false);
          }}
        >
          {#each files as file (file.index)}
            {@const position = playbackPosition(positionKey(endpoint, torrent.hashString, file))}
            {@const active = selected?.index === file.index}
            <li>
              <button
                class="watch-file"
                class:active
                aria-current={active ? 'true' : undefined}
                aria-haspopup="dialog"
                aria-expanded={fileMenu?.file.index === file.index}
                aria-keyshortcuts="Shift+F10"
                oncontextmenu={(event) => {
                  event.preventDefault();
                  if (fileMenuPress) longPressedFile = file.index;
                  cancelFileMenuPress();
                  void openVideoFileMenu(event.currentTarget, file, {
                    x: event.clientX,
                    y: event.clientY,
                  });
                }}
                onkeydown={(event) => {
                  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))
                    return;
                  event.preventDefault();
                  void openVideoFileMenu(event.currentTarget, file);
                }}
                onpointerdown={(event) => startFileMenuPress(event, file)}
                onpointermove={(event) => {
                  if (
                    fileMenuPress &&
                    Math.hypot(event.clientX - fileMenuPress.x, event.clientY - fileMenuPress.y) > 8
                  )
                    cancelFileMenuPress();
                }}
                onpointerup={cancelFileMenuPress}
                onpointercancel={cancelFileMenuPress}
                onclick={(event) => {
                  if (longPressedFile === file.index && event.detail > 0) {
                    longPressedFile = null;
                    event.stopPropagation();
                    return;
                  }
                  if (listOpen) filesButton?.focus({ preventScroll: true });
                  if (active) listOpen = false;
                  else void watch(file);
                }}
              >
                <span class="watch-file-icon" aria-hidden="true"><Film size={16} /></span>
                <span class="watch-file-name">
                  <b>{file.name.split('/').at(-1)}</b>
                  <small class="watch-file-meta">
                    {#if position}<span>Continue from {clock(position.time)} ·</span>{/if}
                    <span>{bytes(file.length)} ·</span>
                    <span
                      class="watch-file-progress"
                      class:complete={file.bytesCompleted >= file.length}
                      class:partial={file.bytesCompleted > 0 && file.bytesCompleted < file.length}
                    >
                      {#if file.bytesCompleted >= file.length}
                        <CheckCircle2 aria-hidden="true" size={13} />Downloaded
                      {:else if file.bytesCompleted > 0}
                        <CircleArrowDown aria-hidden="true" size={13} />{percent(
                          file.bytesCompleted / file.length,
                        )} downloaded
                      {:else}
                        <Circle aria-hidden="true" size={13} />Not downloaded
                      {/if}
                    </span>
                  </small>
                </span>
                <span class="watch-file-action" aria-hidden="true">
                  {#if active}<Check size={16} />{:else}<Play size={16} />{/if}
                </span>
              </button>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  </div>
  {#if fileMenu}
    {@const file = fileMenu.file}
    {@const wanted = fileStats[file.index]?.wanted ?? true}
    <div
      class="context-menu file-context-menu watch-file-menu"
      role="dialog"
      aria-label="Video file actions"
      tabindex="-1"
      style:left={`${fileMenu.left}px`}
      style:top={`${fileMenu.top}px`}
      bind:this={fileMenuElement}
      onkeydown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        closeVideoFileMenu();
      }}
    >
      <div class="menu-caption">File priority</div>
      <PriorityControl
        value={fileStats[file.index]?.priority ?? 0}
        disabled={fileActionBusy}
        onchange={(priority) => void updateVideoFile(file, { priority })}
      />
      <button disabled={fileActionBusy} onclick={() => updateVideoFile(file, { wanted: !wanted })}>
        {#if wanted}<MinusCircle size={16} />Skip download{:else}<Download size={16} />Include in
          download{/if}
      </button>
      {#if discardAvailable && file.bytesCompleted > 0}
        <button
          class="danger"
          disabled={fileActionBusy}
          onclick={() => {
            const target = file;
            closeVideoFileMenu();
            discardTarget = target;
          }}><Trash2 size={16} />Delete downloaded data…</button
        >
      {/if}
    </div>
  {/if}
</Modal>

{#if discardTarget}
  <DiscardFileDialog
    name={discardTarget.name}
    hash={torrent.hashString}
    index={discardTarget.index}
    close={() => (discardTarget = null)}
    closePlayback={async () => {
      if (!selected) return;
      stop();
      controller.abort();
      selected = null;
      phase = 'choose';
      await Promise.all([tick(), formatCleanup]);
    }}
    deleted={() => {
      const file = discardTarget!;
      fileStats[file.index] = {
        priority: fileStats[file.index]?.priority ?? 0,
        bytesCompleted: file.bytesCompleted,
        wanted: false,
      };
      discardTarget = null;
      client.toast('Downloaded data deleted.');
    }}
  />
{/if}
