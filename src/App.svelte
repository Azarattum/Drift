<script lang="ts">
  import { ArrowDownWideNarrow, ArrowUpNarrowWide } from '@lucide/svelte';
  import SettingsPanel from './components/SettingsPanel.svelte';
  import QueueControl from './components/QueueControl.svelte';
  import { preference, savePreference } from './lib/preferences';
  import { motion } from './lib/motion';
  import { magnetLink, normalizeMagnetLink } from './lib/clipboard';
  import { onMount, tick } from 'svelte';
  import { fade, fly, slide } from 'svelte/transition';
  import { flip } from 'svelte/animate';
  import {
    Activity,
    ArrowDown,
    ArrowDownToLine,
    ArrowUp,
    Check,
    CheckCheck,
    ChevronDown,
    ChevronRight,
    ChevronLeft,
    CircleAlert,
    Clipboard,
    Copy,
    Download,
    ExternalLink,
    Folder,
    Film,
    Gauge,
    HardDrive,
    Info,
    Layers,
    Link,
    ListFilter,
    Moon,
    Monitor,
    Square,
    WifiOff,
    MoreHorizontal,
    Pause,
    Pencil,
    Play,
    Plus,
    RefreshCw,
    Search,
    Settings,
    Sun,
    Trash2,
    Upload,
    X,
    Zap,
  } from '@lucide/svelte';
  import { client } from './lib/client.svelte';
  import { bytes, speed } from './lib/format';
  import { transferControl } from './lib/transfer-control';
  import type { Filter, Torrent } from './lib/types';
  import TorrentRow from './components/TorrentRow.svelte';
  import SpeedGraph from './components/SpeedGraph.svelte';
  import Inspector from './components/Inspector.svelte';
  import Modal from './components/Modal.svelte';
  import RenameTorrent from './components/RenameTorrent.svelte';
  import VideoPlayer from './components/VideoPlayer.svelte';

  let watching = $state<{ torrent: Torrent; fileIndex?: number } | null>(null);
  function watchTorrent(torrent: Torrent, fileIndex?: number) {
    context = null;
    watching = { torrent, fileIndex };
  }
  let dragging = $state(false);
  let modal = $state<null | 'add' | 'remove' | 'move' | 'rename' | 'settings'>(null);
  let settingsTab = $state('Connection');
  let mobile = $state(matchMedia('(max-width: 900px)').matches);
  let mobileSection = $state<'transfers' | 'activity' | 'settings'>('transfers');
  let mobileSettingsInitialized = false;
  let mobileSettingsDetail = $state(false);
  let filterSheet = $state(false);
  let queryInput = $state<HTMLInputElement>();
  let context = $state<{ x: number; y: number; t: Torrent } | null>(null);
  let renameTorrent = $state<Torrent | null>(null);
  let addText = $state(''),
    addDir = $state(''),
    addPaused = $state(false),
    addFiles = $state<File[]>([]),
    adding = $state(false);
  let deleteData = $state(false),
    moveDir = $state(''),
    moveData = $state(true);
  let endpoint = $state(client.rpc.endpoint),
    username = $state(''),
    password = $state('');
  let sessionDraft = $state<Record<string, any>>({}),
    saving = $state(false);
  let sessionPending = $derived(
    Object.keys(client.optionDrafts).some((key) => key.startsWith('session:')),
  );
  let theme = $state(preference('drift.theme') || 'system');
  const filters: { id: Filter; label: string; icon: typeof Layers }[] = [
    { id: 'all', label: 'All transfers', icon: Layers },
    { id: 'downloading', label: 'Downloading', icon: ArrowDown },
    { id: 'seeding', label: 'Seeding', icon: ArrowUp },
    { id: 'complete', label: 'Completed', icon: CheckCheck },
    { id: 'paused', label: 'Paused', icon: Pause },
    { id: 'attention', label: 'Needs attention', icon: CircleAlert },
  ];
  let activeTitle = $derived(filters.find((f) => f.id === client.filter)?.label || 'Transfers');
  let selectedTorrents = $derived(client.torrents.filter((t) => client.selected.includes(t.id)));
  let anyRunning = $derived(selectedTorrents.some((t) => t.status !== 0));
  let actionTorrents = $derived(
    context && !client.selected.includes(context.t.id)
      ? [client.torrents.find((t) => t.id === context?.t.id) || context.t]
      : selectedTorrents,
  );
  let actionAnyRunning = $derived(actionTorrents.some((t) => t.status !== 0));
  let actionAllComplete = $derived(
    actionTorrents.length > 0 && actionTorrents.every((t) => t.percentDone >= 1),
  );
  let pendingTorrents = $state<Torrent[]>([]);
  let menuTrigger: HTMLElement | null = null;
  function closeMenu() {
    context = null;
    if (menuTrigger?.isConnected) menuTrigger.focus({ preventScroll: true });
  }

  let allComplete = $derived(
    selectedTorrents.length > 0 && selectedTorrents.every((t) => t.percentDone >= 1),
  );
  let dragDepth = 0;
  let systemDark = $state(matchMedia('(prefers-color-scheme: dark)').matches);
  let dark = $derived(theme === 'dark' || (theme === 'system' && systemDark));
  $effect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    savePreference('drift.theme', theme);
  });

  onMount(() => {
    const mobileMedia = matchMedia('(max-width: 900px)');
    const viewportChanged = (e: MediaQueryListEvent) => {
      const settingsOpen = modal === 'settings' || mobileSection === 'settings';
      mobile = e.matches;
      if (settingsOpen) {
        modal = mobile ? null : 'settings';
        mobileSection = mobile ? 'settings' : 'transfers';
        mobileSettingsInitialized = true;
        mobileSettingsDetail = true;
      } else if (!mobile) mobileSection = 'transfers';
    };
    mobileMedia.addEventListener('change', viewportChanged);
    const media = matchMedia('(prefers-color-scheme: dark)');
    const themeChanged = (event: MediaQueryListEvent) => (systemDark = event.matches);
    media.addEventListener('change', themeChanged);
    let stopped = false;
    async function loop() {
      await client.poll();
      if (!stopped) timer = setTimeout(loop, document.hidden ? 8000 : 2000);
    }
    let timer: ReturnType<typeof setTimeout>;
    void loop();
    const visibility = () => {
      if (!document.hidden) void client.poll(true);
    };
    const saveHistory = () => client.saveHistory();
    window.addEventListener('pagehide', saveHistory);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      mobileMedia.removeEventListener('change', viewportChanged);
      media.removeEventListener('change', themeChanged);
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', saveHistory);
    };
  });
  function openSettings(tab?: string) {
    const returningToSettings = mobileSection !== 'settings' && mobileSettingsInitialized;
    if (!mobile || !mobileSettingsInitialized) {
      sessionDraft = { ...client.session };
      endpoint = client.rpc.endpoint;
      settingsTab = tab || 'Connection';
    } else if (tab) settingsTab = tab;
    context = null;
    if (mobile) {
      if (tab || !returningToSettings) mobileSettingsDetail = !!tab;
      mobileSettingsInitialized = true;
      mobileSection = 'settings';
      client.selected = [];
    } else modal = 'settings';
  }
  function openAdd() {
    addDir = client.session['download-dir'] || '';
    modal = 'add';
  }
  function openMenu(e: MouseEvent, t: Torrent) {
    menuTrigger = e.currentTarget as HTMLElement;
    const rect = (e.currentTarget as HTMLElement)?.getBoundingClientRect();
    context = {
      x: Math.min(Math.max(8, e.clientX || rect?.left || 8), innerWidth - 240),
      y: Math.min(Math.max(8, e.clientY || rect?.bottom || 8), innerHeight - 380),
      t,
    };
    void tick().then(() => {
      const menu = document.querySelector<HTMLElement>('.context-menu');
      if (context && menu && !mobile) {
        const bounds = menu.getBoundingClientRect();
        const anchored = menuTrigger?.classList.contains('row-menu') && rect;
        let x = context.x;
        let y = context.y;
        if (anchored) {
          const below = innerHeight - rect.bottom - 14;
          const above = rect.top - 14;
          x = rect.right - bounds.width;
          if (bounds.height > Math.max(below, above)) {
            x = rect.left - bounds.width - 6;
            y = rect.top;
          } else {
            y = bounds.height <= below ? rect.bottom + 6 : rect.top - bounds.height - 6;
          }
        }
        context = {
          ...context,
          x: Math.max(8, Math.min(x, innerWidth - bounds.width - 8)),
          y: Math.max(8, Math.min(y, innerHeight - bounds.height - 8)),
        };
      }
      menu?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    });
  }
  function requestRemove() {
    if (!actionTorrents.length) return;
    pendingTorrents = [...actionTorrents];
    deleteData = false;
    modal = 'remove';
    context = null;
  }
  async function copy(kind: 'magnetLink' | 'hashString') {
    const text = actionTorrents
      .map((t) =>
        kind === 'hashString'
          ? t.hashString
          : magnetLink(client.details?.id === t.id ? client.details : t),
      )
      .join('\n');
    context = null;
    await client.copy(text);
  }
  function run(method: string) {
    const ids = actionTorrents.map((t) => t.id);
    closeMenu();
    if (ids.length) void client.safeAction(method, ids);
  }
  async function add() {
    adding = true;
    try {
      const links = addText
        .split(/\n/)
        .map((x) => x.trim())
        .filter(Boolean);
      if (links.some((x) => !/^(magnet:\?|https?:\/\/)/i.test(x)))
        throw new Error('Paste a magnet link or an http(s) torrent URL');
      let last: number | undefined;
      for (const link of links) {
        const r = await client.rpc.call('torrent-add', {
          filename: normalizeMagnetLink(link),
          paused: addPaused,
          ...(addDir ? { 'download-dir': addDir } : {}),
        });
        last = (r['torrent-added'] || r['torrent-duplicate'])?.id;
      }
      for (const file of addFiles) {
        const buffer = new Uint8Array(await file.arrayBuffer());
        let binary = '';
        for (let i = 0; i < buffer.length; i += 8192)
          binary += String.fromCharCode(...buffer.subarray(i, i + 8192));
        const r = await client.rpc.call('torrent-add', {
          metainfo: btoa(binary),
          paused: addPaused,
          ...(addDir ? { 'download-dir': addDir } : {}),
        });
        last = (r['torrent-added'] || r['torrent-duplicate'])?.id;
      }
      if (last !== undefined) {
        client.selected = [last];
        if (mobile) mobileSection = 'transfers';
      }
      modal = null;
      addText = '';
      addFiles = [];
      await client.poll(true);
      client.toast('Transfer added');
    } catch (e) {
      client.toast(e instanceof Error ? e.message : 'Could not add torrent');
    } finally {
      adding = false;
    }
  }
  async function connect() {
    saving = true;
    try {
      const u = new URL(endpoint, location.href);
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password)
        throw new Error('Use an http(s) URL; enter credentials in the fields below');
      await client.settleOptions();
      client.changeConnection(u.href, username, password);
      await client.rpc.call('session-get');
      savePreference('drift.endpoint', u.href);
      await client.poll(true);
      modal = null;
      client.toast('Connected to Transmission');
    } catch (e) {
      client.toast(e instanceof Error ? e.message : 'Could not connect');
    } finally {
      saving = false;
    }
  }
  function keyboard(e: KeyboardEvent) {
    if (watching) return;
    const target = e.target as HTMLElement;
    const inLibrary =
      !!target?.closest('.torrent-list') ||
      (target === document.body && !client.focused && (!mobile || mobileSection === 'transfers'));
    const editable = (e.target as HTMLElement)?.closest('input,textarea,select,[contenteditable]');
    if (e.key === 'Escape') {
      if (context) {
        context = null;
        return;
      }
      if (editable) {
        if (e.target === queryInput) client.query = '';
        (e.target as HTMLElement).blur();
        return;
      }
      if (!modal) {
        client.selected = [];
      }
      return;
    }
    if (editable || modal || e.defaultPrevented) return;
    if ((e.metaKey || e.ctrlKey) && e.key === ',') {
      e.preventDefault();
      openSettings();
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      queryInput?.focus();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'a' && inLibrary) {
      e.preventDefault();
      client.selected = client.visible.map((t) => t.id);
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'o') {
      e.preventDefault();
      openAdd();
    }
    if (['Delete', 'Backspace'].includes(e.key) && client.selected.length && inLibrary) {
      e.preventDefault();
      requestRemove();
    }

    if (['ArrowDown', 'ArrowUp'].includes(e.key) && !context && inLibrary) {
      e.preventDefault();
      const at = client.visible.findIndex((t) => t.id === client.selected.at(-1));
      const t =
        client.visible[
          Math.min(client.visible.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)))
        ];
      if (t) {
        client.select(t);
        void tick().then(() => {
          const row = document.querySelector<HTMLElement>(
            `[data-row="${t.id}"] [data-testid="torrent-row"]`,
          );
          row?.scrollIntoView({ block: 'nearest' });
          if (!mobile) row?.focus({ preventScroll: true });
        });
      }
    }
  }
</script>

<svelte:window
  onkeydown={keyboard}
  onclick={(e) => {
    const target = e.target as HTMLElement;
    if (target.closest('.torrent-list') && !target.closest('.torrent-row')) client.selected = [];
  }}
  ondragenter={(e) => {
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault();
      dragDepth++;
      dragging = true;
    }
  }}
  ondragleave={() => {
    dragDepth--;
    if (dragDepth <= 0) dragging = false;
  }}
  ondragover={(e) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  }}
  ondrop={(e) => {
    e.preventDefault();
    dragging = false;
    dragDepth = 0;
    const files = [...(e.dataTransfer?.files || [])].filter((f) =>
      f.name.toLowerCase().endsWith('.torrent'),
    );
    if (files.length) {
      addFiles = files;
      openAdd();
    } else client.toast('Drop .torrent files to add transfers');
  }}
/>
<div
  class="app-shell"
  class:inspecting={client.selected.length === 1 && !!client.focused && !mobile}
  class:mobile
>
  {#if !mobile}<aside class="sidebar">
      <a
        class="brand"
        aria-label="Drift"
        href="./"
        onclick={(e) => {
          e.preventDefault();
          client.filter = 'all';
          client.query = '';
          client.labelFilter = null;
        }}
        ><span class="brand-mark" aria-hidden="true">d</span><span aria-hidden="true"
          >rift<span class="brand-period">.</span></span
        ></a
      >
      <div class="sidebar-label">LIBRARY</div>
      <nav aria-label="Transfer filters">
        {#each filters as f}<button
            class:active={client.filter === f.id}
            onclick={() => {
              client.filter = f.id;
              client.selected = [];
            }}
            ><f.icon size={16} /><span>{f.label}</span><small>{client.count(f.id) || ''}</small
            ></button
          >{/each}
      </nav>
      <div class="sidebar-bottom">
        <div class="storage">
          <HardDrive size={14} />
          <div>
            <span
              >{client.session['download-dir-free-space'] !== undefined
                ? `${bytes(client.session['download-dir-free-space'])} available`
                : 'Storage'}</span
            >
          </div>
        </div>
        <button class="nav-settings" aria-label="Settings" onclick={() => openSettings()}
          ><Settings size={16} /><span>Settings</span><kbd>⌘ ,</kbd></button
        >
        <div class="sidebar-footer">
          <button
            class="icon-button"
            aria-label="Open bandwidth settings"
            title="Bandwidth settings"
            onclick={() => openSettings('Limits')}><Gauge size={16} /></button
          ><button
            class="icon-button"
            title={`Theme: ${theme}`}
            aria-label="Change color theme"
            onclick={() =>
              (theme = theme === 'system' ? 'dark' : theme === 'dark' ? 'light' : 'system')}
            >{#if theme === 'system'}<Monitor size={16} />{:else if theme === 'dark'}<Moon
                size={16}
              />{:else}<Sun size={16} />{/if}</button
          >
        </div>
      </div>
    </aside>{/if}
  <main
    class="main-pane"
    class:stale={client.ready && !client.online}
    inert={mobile &&
      client.selected.length === 1 &&
      !!client.focused &&
      mobileSection === 'transfers'}
  >
    {#if mobile && mobileSection === 'settings'}
      <header class="mobile-page-header" class:settings-detail-header={mobileSettingsDetail}>
        {#if mobileSettingsDetail}<button
            class="icon-button"
            aria-label="Back to settings"
            onclick={() => (mobileSettingsDetail = false)}><ChevronLeft size={24} /></button
          >{/if}
        <h1>
          {mobileSettingsDetail
            ? { Limits: 'Bandwidth', Transfers: 'Downloads' }[settingsTab] || settingsTab
            : 'Settings'}
        </h1>
        {#if mobileSettingsDetail && settingsTab === 'Connection'}<button
            class="settings-save"
            aria-label="Connect"
            disabled={saving}
            onclick={() =>
              document
                .querySelector<HTMLButtonElement>('.settings-mobile .settings-submit')
                ?.click()}>{saving ? 'Connecting…' : 'Connect'}</button
          >{:else if mobileSettingsDetail && sessionPending}<span
            class="option-save-state"
            role="status">Saving…</span
          >{/if}
      </header>
      <div class="mobile-page-scroll mobile-settings">{@render settingsContent()}</div>
    {:else if mobile && mobileSection === 'activity'}
      <header class="mobile-page-header">
        <h1>Activity</h1>
        <span class="server-status"
          ><i class:connected={client.online}></i>{client.online
            ? 'Live'
            : client.ready || client.startupFailed
              ? 'Offline'
              : 'Connecting'}</span
        >
      </header>
      <div class="mobile-page-scroll activity-page">
        <SpeedGraph
          downloadSpeed={client.stats.downloadSpeed}
          uploadSpeed={client.stats.uploadSpeed}
          samples={client.samples}
          expanded
        />
        <section class="activity-summary" aria-label="Session totals">
          <h2>This session</h2>
          <dl class="activity-stats">
            <div>
              <dt>Downloaded</dt>
              <dd>{bytes(client.stats['current-stats']?.downloadedBytes || 0)}</dd>
            </div>
            <div>
              <dt>Uploaded</dt>
              <dd>{bytes(client.stats['current-stats']?.uploadedBytes || 0)}</dd>
            </div>
          </dl>
        </section>
        {#if client.torrents.some((t) => t.rateDownload > 0 || t.rateUpload > 0)}
          <div class="section-heading"><h2>Active transfers</h2></div>
          {#each client.torrents.filter((t) => t.rateDownload > 0 || t.rateUpload > 0) as t (t.id)}<button
              class="activity-transfer"
              onclick={() => {
                client.select(t);
                mobileSection = 'transfers';
              }}
              ><span>{t.name}</span><small
                ><span class="download">↓ {speed(t.rateDownload)}</span><span class="upload"
                  >↑ {speed(t.rateUpload)}</span
                ></small
              ><ChevronRight size={16} /></button
            >{/each}{/if}
      </div>
    {:else}
      <header class="topbar">
        <div class="heading-left">
          <h1>{activeTitle}</h1>
          {#if client.ready && !client.online}<button
              class="connection-state"
              aria-label="Connection lost. Retry"
              title={`${client.error}. Showing last received data. Click to retry.`}
              onclick={() => client.poll(true)}
              ><WifiOff size={15} /><span role="alert"
                >Reconnecting · showing last received data</span
              ></button
            >{/if}
          {#if client.ready}<span class="count-badge">{client.visible.length}</span>{/if}
        </div>
        <div class="topbar-actions">
          <div class="search-box" class:has-query={!!client.query}>
            <Search size={18} /><input
              bind:this={queryInput!}
              aria-label="Search transfers"
              placeholder="Search"
              bind:value={client.query}
              oninput={() => (client.selected = [])}
            />{#if client.query}<button
                class="tiny-button"
                aria-label="Clear search"
                onclick={() => (client.query = '')}><X size={12} /></button
              >{:else}<kbd>⌘ F</kbd>{/if}
          </div>
          <button
            class="button primary add-button"
            aria-label="Add torrent"
            onclick={openAdd}
            disabled={!client.online}><Plus size={15} /><span>Add torrent</span></button
          >
        </div>
      </header>

      {#if client.ready}<div class="graph-wrap">
          <SpeedGraph
            downloadSpeed={client.stats.downloadSpeed}
            uploadSpeed={client.stats.uploadSpeed}
            samples={client.samples}
          />
        </div>{/if}
      <div class="list-toolbar">
        {#if mobile}<button
            class="mobile-filter"
            aria-label="Filter transfers"
            onclick={() => (filterSheet = true)}
            ><ListFilter size={18} /><span>{client.filter === 'all' ? 'Filter' : activeTitle}</span
            ></button
          >{/if}
        {#if client.labelFilter}<button
            class="label-chip"
            aria-label="Clear label filter"
            onclick={() => (client.labelFilter = null)}>{client.labelFilter}<X size={14} /></button
          >{/if}
        {@render sortControl()}
      </div>
      {#if client.selected.length > 1}
        <div class="selection-toolbar" role="toolbar" aria-label="Selected transfers">
          <span class="selection-count">{client.selected.length} selected</span><button
            class="text-button"
            onclick={() => run(anyRunning ? 'torrent-stop' : 'torrent-start')}
            >{#if allComplete && anyRunning}<Square size={13} fill="currentColor" />Stop seeding{:else if allComplete}<Play
                size={13}
              />Start seeding{:else if anyRunning}<Pause size={13} />Pause{:else}<Play
                size={13}
              />Resume{/if}</button
          ><button class="text-button danger" onclick={requestRemove}
            ><Trash2 size={13} />Remove</button
          ><button class="text-button" onclick={() => (client.selected = [])}>Clear</button>
        </div>
      {/if}
      <div class="torrent-list" role="listbox" aria-label="Transfers" aria-multiselectable="true">
        {#each client.visible as t, index (t.id)}<div
            class:selection-joined-above={client.selected.includes(t.id) &&
              index > 0 &&
              client.selected.includes(client.visible[index - 1].id)}
            class:selection-joined-below={client.selected.includes(t.id) &&
              index < client.visible.length - 1 &&
              client.selected.includes(client.visible[index + 1].id)}
            data-row={t.id}
            animate:flip={{
              duration: motion(200),
            }}
          >
            <TorrentRow
              torrent={t}
              selected={client.selected.includes(t.id)}
              open={() => {
                client.select(t);
              }}
              watch={() => watchTorrent(t)}
              menu={openMenu}
              menuOpen={context?.t.id === t.id}
            />
          </div>{:else}<div class="empty-library">
            {#if !client.ready}{#if client.startupFailed}<WifiOff size={28} />
                <h2>Unable to connect</h2>
                <p role="alert">{client.error}</p>
                <div class="empty-actions">
                  <button class="button" onclick={() => client.poll(true)}
                    ><RefreshCw size={16} />Retry</button
                  ><button class="button" onclick={() => openSettings()}>Connection settings</button
                  >
                </div>{:else}<span class="loading-ring"></span>
                <h2>Connecting to Transmission</h2>
                <p>
                  Your transfers will appear here.
                </p>{/if}{:else if client.query || client.labelFilter}<Search size={28} />
              <h2>No matching transfers</h2>
              <p>Try a different name, label, or folder.</p>
              <button
                class="button"
                onclick={() => {
                  client.query = '';
                  client.labelFilter = null;
                }}>Clear filters</button
              >{:else if client.filter !== 'all'}<CheckCheck size={28} />
              <h2>Nothing here</h2>
              <p>No transfers in this view.</p>
              <button class="text-button" onclick={() => (client.filter = 'all')}
                >Show all transfers</button
              >{:else}<ArrowDownToLine size={32} />
              <h2>A little room for something new.</h2>
              <p>Drop a torrent file, or add a magnet link.</p>
              <button class="button primary" onclick={openAdd}><Plus size={15} />Add torrent</button
              >{/if}
          </div>{/each}
      </div>
    {/if}
  </main>
  {#if client.selected.length === 1 && client.focused && (!mobile || mobileSection === 'transfers')}<Inspector
      {mobile}
      watch={(torrent, index) => watchTorrent(torrent, index)}
      torrent={client.details?.id === client.focused.id
        ? { ...client.details, ...client.focused }
        : client.focused}
      close={() => {
        client.selected = [];
      }}
    />{/if}
</div>

{#snippet sortControl()}<div class="sort-control">
    <span class="sort-label">Sort by</span>
    <select aria-label="Sort transfers" bind:value={client.sort}
      ><option value="addedDate">Date added</option><option value="name">Name</option><option
        value="rateDownload">Download speed</option
      ><option value="percentDone">Progress</option><option value="sizeWhenDone">Size</option
      ><option value="queuePosition">Queue order</option></select
    >
    <button
      class="tiny-button"
      aria-label="Reverse sort direction"
      onclick={() => (client.ascending = !client.ascending)}
      >{#if client.ascending}<ArrowUpNarrowWide size={18} />{:else}<ArrowDownWideNarrow
          size={18}
        />{/if}</button
    >
  </div>{/snippet}
{#if mobile}<div class="mobile-dock">
    <nav
      class="mobile-tabbar"
      aria-label="Main navigation"
      style={`--tab-index:${mobileSection === 'transfers' ? 0 : mobileSection === 'activity' ? 1 : 2}`}
    >
      <button
        aria-current={mobileSection === 'transfers' ? 'page' : undefined}
        onclick={() => {
          if (mobileSection === 'transfers') client.selected = [];
          mobileSection = 'transfers';
          context = null;
        }}><Layers size={21} /><span>Transfers</span></button
      >
      <button
        aria-current={mobileSection === 'activity' ? 'page' : undefined}
        onclick={() => {
          mobileSection = 'activity';
          context = null;
        }}><Activity size={21} /><span>Activity</span></button
      >
      <button
        aria-current={mobileSection === 'settings' ? 'page' : undefined}
        onclick={() => openSettings()}><Settings size={21} /><span>Settings</span></button
      >
    </nav>
    <button class="mobile-add" aria-label="Add torrent" disabled={!client.online} onclick={openAdd}
      ><Plus size={26} /></button
    >
  </div>{/if}
{#if filterSheet}<Modal title="Show transfers" close={() => (filterSheet = false)}
    ><nav class="mobile-filter-list" aria-label="Transfer filters">
      {#each filters as f}<button
          aria-pressed={client.filter === f.id}
          onclick={() => {
            client.filter = f.id;
            client.selected = [];
            filterSheet = false;
          }}><f.icon size={19} /><span>{f.label}</span><small>{client.count(f.id)}</small></button
        >{/each}
    </nav></Modal
  >{/if}

{#if context}
  <button
    class="context-scrim"
    aria-label="Dismiss context menu"
    onclick={closeMenu}
    oncontextmenu={(e) => {
      e.preventDefault();
      context = null;
    }}
  ></button>
  <div
    class="context-menu"
    role="menu"
    tabindex="-1"
    aria-label="Transfer actions"
    style={`left:${context.x}px;top:${context.y}px`}
    transition:fly={{ y: -4, duration: motion(100) }}
    onkeydown={(e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeMenu();
        return;
      }
      if (['ArrowDown', 'ArrowUp'].includes(e.key)) {
        e.preventDefault();
        const items = [
          ...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
        ];
        const i = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      }
    }}
  >
    <div class="menu-caption">
      {actionTorrents.length > 1 ? `${actionTorrents.length} transfers` : context.t.name}
    </div>
    {#if actionTorrents.length === 1}{@const control = transferControl(context.t)}<button
        role="menuitem"
        onclick={() => run(control.method)}
        >{#if control.icon === 'play'}<Play size={15} />{:else if control.icon === 'stop'}<Square
            size={15}
            fill="currentColor"
          />{:else}<Pause size={15} />{/if}{control.label}<kbd>Space</kbd></button
      >{:else}<button
        role="menuitem"
        onclick={() => run(actionAnyRunning ? 'torrent-stop' : 'torrent-start')}
        >{#if actionAllComplete && actionAnyRunning}<Square size={15} fill="currentColor" />Stop
          seeding{:else if actionAllComplete}<Play size={15} />Start seeding{:else if actionAnyRunning}<Pause
            size={15}
          />Pause downloads{:else}<Play size={15} />Resume downloads{/if}</button
      >{/if}
    {#if actionTorrents.some((t) => t.status === 3 || t.status === 5)}<button
        role="menuitem"
        onclick={() => run('torrent-start-now')}
        ><Play size={15} />{actionTorrents.every((t) => t.percentDone >= 1)
          ? 'Seed now'
          : 'Download now'}<small>Skip queue</small></button
      >{/if}
    {#if client.fullSpeedAvailable && actionTorrents.length === 1 && context.t.percentDone < 1}<button
        role="menuitem"
        class:full={client.isFullSpeed(context.t)}
        onclick={() => {
          void client.fullSpeed(context!.t);
          context = null;
        }}
        ><Zap size={15} />{client.isFullSpeed(context.t)
          ? 'Turn off Full speed'
          : 'Full speed'}{#if client.isFullSpeed(context.t)}<Check size={13} />{/if}</button
      >{/if}
    {#if actionTorrents.length === 1 && context.t.metadataPercentComplete >= 1}<button
        role="menuitem"
        onclick={() => watchTorrent(context!.t)}><Film size={15} />Watch video</button
      >{/if}
    <hr />
    <button
      role="menuitem"
      onclick={() => {
        client.select(context!.t);
        context = null;
      }}><Info size={15} />Show details <kbd>↵</kbd></button
    ><button role="menuitem" onclick={() => run('torrent-verify')}
      ><CheckCheck size={15} />Verify local files</button
    ><button role="menuitem" onclick={() => run('torrent-reannounce')}
      ><RefreshCw size={15} />Ask trackers for peers</button
    >
    {#if actionTorrents.length === 1 && context.t.metadataPercentComplete >= 1 && Number(client.session['rpc-version']) >= 15}<button
        role="menuitem"
        onclick={() => {
          const target = context!.t;
          closeMenu();
          renameTorrent = target;
          modal = 'rename';
        }}><Pencil size={15} />Rename…</button
      >{/if}
    <button
      role="menuitem"
      onclick={() => {
        pendingTorrents = [...actionTorrents];
        moveDir = context!.t.downloadDir;
        moveData = true;
        modal = 'move';
        context = null;
      }}><Folder size={15} />Set location…</button
    >
    <hr />
    <button role="menuitem" onclick={() => copy('magnetLink')}
      ><Link size={15} />Copy magnet link</button
    ><button role="menuitem" onclick={() => copy('hashString')}
      ><Copy size={15} />Copy info hash</button
    >
    {#if client.torrents.filter((t) => t.percentDone < 1).length > 1 && actionTorrents.length && actionTorrents.every((t) => t.percentDone < 1)}
      <hr />
      <QueueControl torrents={actionTorrents} move={(method) => run(method)} />
    {/if}
    <hr />
    <button role="menuitem" class="danger" onclick={requestRemove}
      ><Trash2 size={15} />Remove… <kbd>⌫</kbd></button
    >
  </div>
{/if}
{#if modal === 'add'}<Modal
    title="Add a transfer"
    close={() => {
      if (!adding) modal = null;
    }}
    ><form
      class="modal-form"
      onsubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      <label
        >Magnet link or torrent URL<textarea
          class="input link-input"
          rows="3"
          placeholder="magnet:?xt=urn:btih:…"
          bind:value={addText}></textarea></label
      ><label class="file-drop"
        ><Download size={20} /><span
          >{addFiles.length
            ? `${addFiles.length} torrent file${addFiles.length === 1 ? '' : 's'} selected`
            : 'Choose .torrent files'}</span
        ><small>or drop files anywhere</small><input
          type="file"
          multiple
          accept=".torrent,application/x-bittorrent"
          aria-label="Choose torrent files"
          onchange={(e) => (addFiles = [...(e.currentTarget.files || [])])}
        /></label
      >{#if addFiles.length}<div class="picked-files">
          {#each addFiles as f, i}<span
              >{f.name}<button
                type="button"
                class="tiny-button"
                aria-label={`Remove ${f.name}`}
                onclick={() => (addFiles = addFiles.filter((_, n) => n !== i))}
                ><X size={12} /></button
              ></span
            >{/each}
        </div>{/if}<label
        >Download folder<input
          class="input mono"
          placeholder="Use server default"
          bind:value={addDir}
        /></label
      ><label class="check-row"><input type="checkbox" bind:checked={addPaused} />Add paused</label>
      <div class="modal-footer">
        <button class="button primary" disabled={adding || (!addText.trim() && !addFiles.length)}
          >{adding ? 'Adding…' : 'Add transfer'}<ChevronRight size={14} /></button
        >
      </div>
    </form></Modal
  >{/if}
{#if modal === 'rename' && renameTorrent}<RenameTorrent
    torrent={renameTorrent}
    close={() => {
      modal = null;
      renameTorrent = null;
    }}
  />{/if}
{#if modal === 'remove'}<Modal
    title={`Remove ${pendingTorrents.length === 1 ? 'transfer' : `${pendingTorrents.length} transfers`}?`}
    close={() => (modal = null)}
    ><form
      class="modal-form"
      onsubmit={async (e) => {
        e.preventDefault();
        await client.safeAction(
          'torrent-remove',
          pendingTorrents.map((t) => t.id),
          {
            'delete-local-data': deleteData,
          },
        );
        modal = null;
      }}
    >
      <p class="remove-description">
        {pendingTorrents.length === 1
          ? pendingTorrents[0]?.name
          : `${pendingTorrents.length} selected transfers`}
      </p>
      <label class="check-row danger"
        ><input type="checkbox" bind:checked={deleteData} />Also delete downloaded files</label
      >
      <p class="hint">
        {deleteData
          ? 'Downloaded files will be permanently deleted.'
          : 'Your downloaded files will be kept.'}
      </p>
      <div class="modal-footer">
        <button type="button" class="button" onclick={() => (modal = null)}>Cancel</button><button
          class="button destructive"><Trash2 size={14} />Remove</button
        >
      </div>
    </form></Modal
  >{/if}
{#if modal === 'move'}<Modal title="Set download location" close={() => (modal = null)}
    ><form
      class="modal-form"
      onsubmit={async (e) => {
        e.preventDefault();
        await client.safeAction(
          'torrent-set-location',
          pendingTorrents.map((t) => t.id),
          {
            location: moveDir,
            move: moveData,
          },
        );
        modal = null;
      }}
    >
      <label>Folder on the server<input class="input mono" required bind:value={moveDir} /></label
      ><label class="check-row"
        ><input type="checkbox" bind:checked={moveData} />Move existing files to this folder</label
      >
      <p class="hint">Turn off if you already moved the files yourself.</p>
      <button class="button primary">Set location</button>
    </form></Modal
  >{/if}
{#snippet settingsContent()}
  <SettingsPanel
    bind:section={settingsTab}
    bind:draft={sessionDraft}
    bind:endpoint
    bind:username
    bind:password
    bind:theme
    bind:showDetail={mobileSettingsDetail}
    {saving}
    {mobile}
    {connect}
  />
{/snippet}
{#if modal === 'settings'}<Modal title="Settings" close={() => (modal = null)} wide
    >{@render settingsContent()}</Modal
  >{/if}
{#if dragging}<div class="drag-overlay" transition:fade={{ duration: motion(100) }}>
    <div>
      <Download size={35} />
      <h2>Drop to add transfers</h2>
      <p>.torrent files</p>
    </div>
  </div>{/if}
{#if client.notice}<div
    class="toast"
    role="status"
    transition:fly={{ y: 8, duration: motion(160) }}
  >
    <span>{client.notice}</span><button
      class="tiny-button"
      aria-label="Dismiss notification"
      onclick={() => (client.notice = '')}><X size={13} /></button
    >
  </div>{/if}

{#if client.copyValue !== null}<Modal title="Copy text" close={() => (client.copyValue = null)}>
    <div class="modal-form">
      <p class="hint">
        {mobile
          ? 'Touch and hold the text to select and copy it.'
          : 'Select the text and press ⌘C or Ctrl+C.'}
      </p>
      <textarea
        class="input mono manual-copy"
        aria-label="Text to copy"
        rows="5"
        readonly
        value={client.copyValue}
        onfocus={(e) => e.currentTarget.select()}></textarea>
    </div>
  </Modal>{/if}

{#if watching}<VideoPlayer
    torrent={watching.torrent}
    fileIndex={watching.fileIndex}
    close={() => (watching = null)}
  />{/if}
