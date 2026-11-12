<script lang="ts">
  import { onMount, tick } from 'svelte';
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
    savePosition,
    videoFiles,
    type VideoFile,
  } from '../lib/playback';
  import { loadPlayerEngine } from '../lib/player-engine';
  let { torrent, fileIndex, close }: { torrent: Torrent; fileIndex?: number; close: () => void } =
    $props();
  const endpoint = client.rpc.endpoint;
  let files = $state<VideoFile[]>([]);
  let selected = $state<VideoFile | null>(null);
  let phase = $state<'loading' | 'choose' | 'preparing' | 'ready' | 'error'>('loading');
  let message = $state('');
  let source = $state('');
  let video = $state<HTMLVideoElement>();
  let canvas = $state<HTMLElement>();
  let paused = $state(true),
    waiting = $state(false),
    current = $state(0),
    duration = $state(0),
    muted = $state(false);
  let resume = $state<number | null>(null);
  let listOpen = $state(false);
  let rate = $state(1);
  let captions = $state<TextTrack[]>([]);
  let captionMenu = $state(false);
  let captionIndex = $state(-1);
  $effect(() => {
    if (!video) return;
    const tracks = video.textTracks;
    const update = () => {
      captions = Array.from(tracks).filter((t) => t.kind === 'subtitles' || t.kind === 'captions');
    };
    update();
    tracks.addEventListener('addtrack', update);
    tracks.addEventListener('removetrack', update);
    return () => {
      tracks.removeEventListener('addtrack', update);
      tracks.removeEventListener('removetrack', update);
    };
  });
  function setCaption(index: number) {
    for (const [i, track] of captions.entries()) track.mode = i === index ? 'showing' : 'disabled';
    captionIndex = index;
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
            { ids: [torrent.id], fields: ['hashString', 'files'] },
            signal,
          );
          const updated = response.torrents.find((t) => t.hashString === torrent.hashString);
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
    save(true);
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
  async function watch(file: VideoFile) {
    stop();
    controller.abort();
    controller = new AbortController();
    const signal = controller.signal;
    selected = file;
    source = '';
    phase = 'preparing';
    message = '';
    resume = null;
    restored = false;
    hasPlayed = false;
    current = 0;
    duration = 0;
    paused = true;
    waiting = false;
    rate = 1;
    listOpen = false;
    captionMenu = false;
    captionIndex = -1;
    try {
      const authorization = client.rpc.username
        ? `Basic ${btoa(unescape(encodeURIComponent(`${client.rpc.username}:${client.rpc.password}`)))}`
        : undefined;
      const [url] = await Promise.all([
        prepareStream(endpoint, torrent.hashString, file.index, authorization, signal),
        loadPlayerEngine(),
      ]);
      if (disposed || signal.aborted) return;
      resume = playbackPosition(positionKey(endpoint, torrent.hashString, file))?.time ?? null;
      source = url;
      phase = 'ready';
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
    if (at !== undefined) video.currentTime = Math.min(at, Math.max(0, video.duration - 0.1));
    resume = null;
    try {
      await video.play();
    } catch {
      paused = true;
    }
  }
  function metadata() {
    if (!video) return;
    duration = video.duration;
    if (restored) return;
    restored = true;
    if (resume !== null && (!Number.isFinite(duration) || resume >= duration - 10)) resume = null;
    if (resume === null) void play();
  }
  function mediaError() {
    if (!video?.error || !source) return;
    save(true);
    const code = video.error.code;
    message =
      code === 3 || code === 4
        ? 'This video format can’t play in this browser. Try a compatible browser or open the file in your preferred video app.'
        : 'Playback was interrupted. Your position is saved. Check the connection or wait for more of the video to download, then try again.';
    phase = 'error';
  }
  function keys(e: KeyboardEvent) {
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
          { ids: [torrent.id], fields: ['id', 'hashString', 'name', 'files'] },
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
        aria-label="Video player"
      >
        <!-- Captions are exposed when the media provides text tracks. RPC text is never HTML. -->
        <!-- svelte-ignore a11y_media_has_caption -->
        <video
          bind:this={video}
          src={source}
          playsinline
          crossorigin="use-credentials"
          preload="metadata"
          onloadedmetadata={metadata}
          ontimeupdate={() => {
            current = video?.currentTime || 0;
            save();
          }}
          onplaying={() => {
            paused = false;
            waiting = false;
            hasPlayed = true;
          }}
          onpause={() => {
            paused = true;
            save(true);
          }}
          oncanplay={() => (waiting = false)}
          onwaiting={() => (waiting = true)}
          onseeking={() => (waiting = true)}
          onseeked={() => {
            waiting = false;
            save(true);
          }}
          onvolumechange={() => (muted = !!video?.muted || video?.volume === 0)}
          onended={() => {
            save(true);
            paused = true;
          }}
          onerror={mediaError}
        >
        </video>
        {#if resume !== null}<div class="watch-overlay watch-resume">
            <span class="watch-overlay-icon"><RotateCcw size={26} /></span>
            <h3>Pick up where you left off</h3>
            <p>Continue from {clock(resume)}</p>
            <div>
              <button class="button primary" disabled={!duration} onclick={() => play(resume!)}
                ><Play size={17} fill="currentColor" />Resume from {clock(resume)}</button
              ><button class="button watch-start-over" disabled={!duration} onclick={() => play(0)}
                >Start over</button
              >
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
              >{duration <= 0
                ? 'Loading video…'
                : complete
                  ? 'Buffering…'
                  : 'Waiting for video data…'}</span
            >
          </div>{/if}
        <media-controls class="watch-controls" class:watch-controls-blocked={resume !== null}>
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
                seconds="-10"
                aria-label="Back 10 seconds"
                ><RotateCcw size={19} /><small>10</small></media-seek-button
              >
              <media-seek-button
                class="watch-control watch-skip"
                seconds="10"
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
                aria-label="Toggle fullscreen"
                ><span class="when-windowed"><Maximize size={20} /></span><span
                  class="when-fullscreen"><Minimize size={20} /></span
                ></media-fullscreen-button
              >
            </media-controls-group>
          </media-controls-content>
        </media-controls>
        <media-status-announcer></media-status-announcer>
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
