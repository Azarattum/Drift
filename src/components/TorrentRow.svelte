<script lang="ts">
  import {
    ArrowDown,
    ArrowUp,
    Check,
    ChevronRight,
    File,
    Folder,
    LoaderCircle,
    MoreHorizontal,
    Pause,
    Play,
    Square,
    Zap,
  } from '@lucide/svelte';
  import { client } from '../lib/client.svelte';
  import { bytes, duration, percent, speed } from '../lib/format';
  import { stage } from '../lib/stage';
  import { transferControl } from '../lib/transfer-control';
  import type { Torrent } from '../lib/types';
  let {
    torrent: t,
    selected,
    open,
    menu,
    menuOpen = false,
  }: {
    torrent: Torrent;
    selected: boolean;
    open: () => void;
    menu: (e: MouseEvent, t: Torrent) => void;
    menuOpen?: boolean;
  } = $props();
  let s = $derived(stage(t));
  let full = $derived(client.isFullSpeed(t));
  let control = $derived(transferControl(t));
</script>

<div
  class="torrent-row"
  class:selected
  class:menu-open={menuOpen}
  data-testid="torrent-row"
  role="option"
  aria-selected={selected}
  tabindex="0"
  onclick={(e) => client.select(t, e)}
  ondblclick={open}
  oncontextmenu={(e) => {
    e.preventDefault();
    menu(e, t);
  }}
  onkeydown={(e) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter') open();
    if (e.key === ' ') {
      e.preventDefault();
      client.select(t);
    }
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      menu(e as unknown as MouseEvent, t);
    }
  }}
>
  <div class="torrent-icon" class:complete={t.percentDone === 1}>
    {#if t.metadataPercentComplete < 1}<LoaderCircle
        size={18}
        class="slow-spin"
      />{:else if t.percentDone === 1}<Check size={19} />{:else if (t.fileCount || 0) > 1}<Folder
        size={18}
      />{:else}<File size={18} />{/if}
  </div>
  <div class="torrent-main">
    <div class="torrent-name" title={t.name}>{t.name}</div>
    <div class="torrent-subline">
      <span
        class="stage"
        class:blue={s.tone === 'blue'}
        class:amber={s.tone === 'amber'}
        class:red={s.tone === 'red'}
        class:green={s.tone === 'green'}
        ><span
          class="status-dot"
          class:pulse={s.active && t.rateDownload === 0 && t.rateUpload === 0}
        ></span>{s.label}</span
      ><span class="size muted"
        >{t.errorString || s.tone === 'amber' || s.tone === 'red'
          ? t.errorString || s.detail
          : t.status === 2
            ? s.detail
            : t.metadataPercentComplete < 1
              ? 'Retrieving file list'
              : `${bytes(t.sizeWhenDone)}${t.percentDone < 1 ? ` · ${percent(t.percentDone)}` : ''}`}</span
      >{#if t.bandwidthPriority === 1 || t.bandwidthPriority === -1}<span
          class="torrent-priority"
          title="Bandwidth priority relative to other torrents"
          >{#if t.bandwidthPriority === 1}<ArrowUp size={12} />High priority{:else}<ArrowDown
              size={12}
            />Low priority{/if}</span
        >{/if}
      {#if full && client.fullSpeedAvailable && t.percentDone < 1}<span
          class="full-indicator"
          title={!client.fullSpeedAvailable
            ? 'Full speed controller is unavailable'
            : client.fullSpeedApplied(t)
              ? 'Full speed active'
              : 'Waiting for controller'}
          ><Zap size={11} />{!client.fullSpeedAvailable
            ? 'Controller unavailable'
            : client.fullSpeedApplied(t)
              ? 'Full speed'
              : 'Applying…'}</span
        >{/if}
    </div>
    <div
      class="row-progress"
      class:finished={t.percentDone === 1}
      class:indeterminate={s.active && s.progress === undefined}
    >
      <span
        style={`width:${Math.max(0, Math.min(100, (s.progress || 0) * 100))}%;background:${s.tone === 'green' ? 'var(--teal)' : s.tone === 'red' ? 'var(--red)' : 'var(--blue)'}`}
      ></span>
    </div>
  </div>
  <div class="row-stage-detail muted" title={s.detail}>{t.errorString || s.detail}</div>
  <div class="row-metrics">
    <div class="row-speeds">
      {#if t.rateDownload > 0}<span class="download" title="Download speed"
          ><ArrowDown size={16} />{speed(t.rateDownload)}</span
        >{/if}
      {#if t.rateUpload > 0}<span class="upload" title="Upload speed"
          ><ArrowUp size={16} />{speed(t.rateUpload)}</span
        >{/if}
    </div>
    {#if t.status === 4 && t.rateDownload > 0 && t.percentDone < 1 && t.eta >= 0}<div
        class="row-eta muted"
      >
        {duration(t.eta)} left
      </div>{/if}
  </div>
  <div class="row-actions">
    <button
      class="icon-button row-toggle"
      disabled={!client.online || client.busy.has(t.id)}
      aria-label={`${control.label} ${t.name}`}
      title={control.label}
      onclick={(e) => {
        e.stopPropagation();
        void client.safeAction(control.method, [t.id]);
      }}
      >{#if control.icon === 'play'}<Play size={15} />{:else if control.icon === 'stop'}<Square
          size={15}
        />{:else}<Pause size={15} />{/if}</button
    >{#if client.fullSpeedAvailable && t.percentDone < 1}<button
        class="icon-button row-boost"
        class:full
        aria-pressed={full}
        aria-label={`${full ? 'Disable' : 'Enable'} Full speed for ${t.name}`}
        title={full ? 'Restore automatic limits' : 'Full speed · bypass automatic limits'}
        onclick={(e) => {
          e.stopPropagation();
          void client.fullSpeed(t);
        }}><Zap size={16} /><span>Full speed</span></button
      >{/if}<button
      class="icon-button row-menu"
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      aria-label={`Actions for ${t.name}`}
      onclick={(e) => {
        e.stopPropagation();
        menu(e, t);
      }}><MoreHorizontal size={16} /></button
    ><button
      class="icon-button mobile-detail"
      aria-label={`Details for ${t.name}`}
      onclick={(e) => {
        e.stopPropagation();
        client.select(t);
        open();
      }}><ChevronRight size={16} /></button
    >
  </div>
</div>
