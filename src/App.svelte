<script lang="ts">
  import { motion } from './lib/motion';
  import { magnetLink } from './lib/clipboard';
  import { onMount, tick } from 'svelte';
  import { fade, fly, slide } from 'svelte/transition';
  import { flip } from 'svelte/animate';
  import {
    Activity,
    ArrowDown,
    ArrowDownToLine,
    ArrowUp,
    ArrowUpDown,
    Check,
    CheckCheck,
    ChevronDown,
    ChevronRight,
    CircleAlert,
    Clipboard,
    Copy,
    Download,
    ExternalLink,
    Folder,
    Gauge,
    HardDrive,
    Info,
    Layers,
    Link,
    ListFilter,
    Menu,
    Moon,
    MoreHorizontal,
    Pause,
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
  import type { Filter, Torrent } from './lib/types';
  import TorrentRow from './components/TorrentRow.svelte';
  import SpeedGraph from './components/SpeedGraph.svelte';
  import Inspector from './components/Inspector.svelte';
  import Modal from './components/Modal.svelte';

  let sidebar = $state(false),
    inspector = $state(true),
    chart = $state(true),
    dragging = $state(false);
  let modal = $state<null | 'add' | 'remove' | 'move' | 'settings'>(null);
  let settingsTab = $state('Connection');
  let mobile = $state(matchMedia('(max-width: 900px)').matches);
  let mobileSection = $state<'transfers' | 'activity' | 'settings'>('transfers');
  let mobileSettingsInitialized = false;
  let filterSheet = $state(false);
  let queryInput = $state<HTMLInputElement>();
  let context = $state<{ x: number; y: number; t: Torrent } | null>(null);
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
  let theme = $state(localStorage.getItem('drift.theme') || 'system');
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
  let dragDepth = 0;
  let systemDark = $state(matchMedia('(prefers-color-scheme: dark)').matches);
  let dark = $derived(theme === 'dark' || (theme === 'system' && systemDark));
  $effect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    localStorage.setItem('drift.theme', theme);
  });

  onMount(() => {
    const mobileMedia = matchMedia('(max-width: 900px)');
    const viewportChanged = (e: MediaQueryListEvent) => {
      mobile = e.matches;
      if (!mobile) mobileSection = 'transfers';
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
    document.addEventListener('visibilitychange', visibility);
    return () => {
      mobileMedia.removeEventListener('change', viewportChanged);
      media.removeEventListener('change', themeChanged);
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibility);
    };
  });
  function openSettings(tab?: string) {
    if (!mobile || !mobileSettingsInitialized) {
      sessionDraft = { ...client.session };
      endpoint = client.rpc.endpoint;
      settingsTab = tab || 'Connection';
    } else if (tab) settingsTab = tab;
    context = null;
    if (mobile) {
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
        context = {
          ...context,
          x: Math.max(8, Math.min(context.x, innerWidth - bounds.width - 8)),
          y: Math.max(8, Math.min(context.y, innerHeight - bounds.height - 8)),
        };
      }
      menu?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    });
  }
  function requestRemove() {
    if (!client.selected.length) return;
    deleteData = false;
    modal = 'remove';
    context = null;
  }
  async function copy(kind: 'magnetLink' | 'hashString') {
    const text = selectedTorrents
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
    context = null;
    void client.safeAction(method);
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
          filename: link,
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
      client.rpc.endpoint = u.href;
      client.rpc.username = username;
      client.rpc.password = password;
      client.rpc.token = '';
      await client.rpc.call('session-get');
      localStorage.setItem('drift.endpoint', u.href);
      await client.poll(true);
      modal = null;
      client.toast('Connected to Transmission');
    } catch (e) {
      client.toast(e instanceof Error ? e.message : 'Could not connect');
    } finally {
      saving = false;
    }
  }
  async function saveSession() {
    saving = true;
    try {
      const allowed = [
        'download-dir',
        'incomplete-dir',
        'incomplete-dir-enabled',
        'rename-partial-files',
        'start-added-torrents',
        'speed-limit-down-enabled',
        'speed-limit-down',
        'speed-limit-up-enabled',
        'speed-limit-up',
        'alt-speed-enabled',
        'alt-speed-down',
        'alt-speed-up',
        'download-queue-enabled',
        'download-queue-size',
        'seed-queue-enabled',
        'seed-queue-size',
        'seedRatioLimited',
        'seedRatioLimit',
        'idle-seeding-limit-enabled',
        'idle-seeding-limit',
        'peer-port',
        'port-forwarding-enabled',
        'peer-limit-global',
        'peer-limit-per-torrent',
        'encryption',
        'dht-enabled',
        'pex-enabled',
        'lpd-enabled',
        'utp-enabled',
        'blocklist-enabled',
        'blocklist-url',
      ];
      const args = Object.fromEntries(
        allowed.filter((k) => sessionDraft[k] !== undefined).map((k) => [k, sessionDraft[k]]),
      );
      await client.rpc.call('session-set', args);
      await client.poll(true);
      client.toast('Settings saved');
      modal = null;
    } catch (e) {
      client.toast(String(e));
    } finally {
      saving = false;
    }
  }
  function keyboard(e: KeyboardEvent) {
    const editable = (e.target as HTMLElement)?.closest('input,textarea,select,[contenteditable]');
    if (e.key === 'Escape') {
      context = null;
      if (!modal) {
        client.selected = [];
        sidebar = false;
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
    if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
      e.preventDefault();
      client.selected = client.visible.map((t) => t.id);
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'o') {
      e.preventDefault();
      openAdd();
    }
    if (['Delete', 'Backspace'].includes(e.key) && client.selected.length) {
      e.preventDefault();
      requestRemove();
    }
    if (e.key === 'Enter' && client.focused) inspector = true;
    if (['ArrowDown', 'ArrowUp'].includes(e.key) && !context) {
      e.preventDefault();
      const at = client.visible.findIndex((t) => t.id === client.selected.at(-1));
      const t =
        client.visible[
          Math.min(client.visible.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)))
        ];
      if (t) {
        client.select(t);
        void tick().then(() =>
          document.querySelector(`[data-row="${t.id}"]`)?.scrollIntoView({ block: 'nearest' }),
        );
      }
    }
  }
</script>

<svelte:window
  onkeydown={keyboard}
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
<div class="app-shell" class:inspecting={inspector && !!client.focused && !mobile} class:mobile>
  {#if sidebar}<button
      class="sidebar-scrim"
      aria-label="Close navigation"
      onclick={() => (sidebar = false)}
    ></button>{/if}
  {#if !mobile}<aside class="sidebar" class:open={sidebar}>
      <a
        class="brand"
        aria-label="Drift"
        href="./"
        onclick={(e) => {
          e.preventDefault();
          client.filter = 'all';
          client.query = '';
          sidebar = false;
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
              sidebar = false;
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
            ><small title={client.session['download-dir']}
              >{client.session['download-dir'] || 'Connect a daemon'}</small
            >
          </div>
        </div>
        <button class="nav-settings" onclick={() => openSettings()}
          ><Settings size={16} /><span>Settings</span><kbd>⌘ ,</kbd></button
        >
        <div class="sidebar-footer">
          <span class="server-status"
            ><i class:connected={client.online}></i>{client.online
              ? 'Connected'
              : client.ready
                ? 'Reconnecting'
                : 'Connecting'}</span
          ><button
            class="icon-button"
            title={`Theme: ${theme}`}
            aria-label="Change color theme"
            onclick={() =>
              (theme = theme === 'system' ? 'dark' : theme === 'dark' ? 'light' : 'system')}
            >{#if dark}<Moon size={14} />{:else}<Sun size={14} />{/if}</button
          >
        </div>
      </div>
    </aside>{/if}
  <main class="main-pane">
    {#if mobile && mobileSection === 'settings'}
      <header class="mobile-page-header"><h1>Settings</h1></header>
      <div class="mobile-page-scroll mobile-settings">{@render settingsContent()}</div>
    {:else if mobile && mobileSection === 'activity'}
      <header class="mobile-page-header">
        <h1>Activity</h1>
        <span class="server-status"
          ><i class:connected={client.online}></i>{client.online ? 'Live' : 'Offline'}</span
        >
      </header>
      <div class="mobile-page-scroll activity-page">
        <SpeedGraph samples={client.samples} expanded />
        <div class="activity-stats">
          <div>
            <span>Downloaded this session</span><b
              >{bytes(client.stats['current-stats']?.downloadedBytes || 0)}</b
            >
          </div>
          <div>
            <span>Uploaded this session</span><b
              >{bytes(client.stats['current-stats']?.uploadedBytes || 0)}</b
            >
          </div>
        </div>
        <div class="section-heading"><h2>Active transfers</h2></div>
        {#each client.torrents.filter((t) => t.rateDownload > 0 || t.rateUpload > 0) as t (t.id)}<button
            class="activity-transfer"
            onclick={() => {
              client.select(t);
              inspector = true;
              mobileSection = 'transfers';
            }}
            ><span>{t.name}</span><small
              ><span class="download">↓ {speed(t.rateDownload)}</span><span class="upload"
                >↑ {speed(t.rateUpload)}</span
              ></small
            ><ChevronRight size={16} /></button
          >{:else}<p class="hint">No data is being transferred right now.</p>{/each}
      </div>
    {:else}
      <header class="topbar">
        <div class="heading-left">
          <button
            class="icon-button mobile-menu"
            aria-label="Open navigation"
            onclick={() => (sidebar = true)}><Menu size={18} /></button
          >
          <h1>{activeTitle}</h1>
          <span class="count-badge">{client.visible.length}</span>
        </div>
        <div class="topbar-actions">
          <div class="search-box">
            <Search size={14} /><input
              bind:this={queryInput!}
              aria-label="Search transfers"
              placeholder="Search"
              bind:value={client.query}
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
      {#if client.error}<div class="connection-error" role="alert">
          <CircleAlert size={15} /><span
            >{client.error}{#if client.ready}
              · Showing last received data{/if}</span
          ><button class="text-button" onclick={() => client.poll(true)}>Retry</button><button
            class="text-button"
            onclick={() => openSettings()}>Connection settings</button
          >
        </div>{/if}
      <div class="overview-toolbar">
        <div class="overview-state">
          <span class="live-dot" class:connected={client.online}></span>{client.online
            ? `${client.torrents.filter((t) => t.rateDownload || t.rateUpload).length} active transfers`
            : client.ready
              ? 'Connection interrupted'
              : 'Connecting to Transmission…'}
        </div>
        <div>
          <button
            class="icon-button"
            aria-label="Toggle speed graph"
            aria-pressed={chart}
            onclick={() => (chart = !chart)}><Activity size={16} /></button
          ><button
            class="icon-button"
            aria-label="Toggle inspector"
            aria-pressed={inspector}
            onclick={() => (inspector = !inspector)}><Info size={16} /></button
          >
        </div>
      </div>
      {#if chart}<div class="graph-wrap" transition:slide={{ duration: motion(180) }}>
          <SpeedGraph samples={client.samples} />
        </div>{/if}
      <div class="list-toolbar">
        {#if client.selected.length > 1}<span class="selection-count"
            >{client.selected.length} selected</span
          ><button
            class="text-button"
            onclick={() => run(anyRunning ? 'torrent-stop' : 'torrent-start')}
            >{#if anyRunning}<Pause size={13} />Pause{:else}<Play size={13} />Resume{/if}</button
          ><button class="text-button danger" onclick={requestRemove}
            ><Trash2 size={13} />Remove</button
          ><button class="text-button" onclick={() => (client.selected = [])}>Clear</button
          >{:else}<span class="eyebrow">TRANSFERS</span>{/if}
        {#if mobile}<button
            class="mobile-filter"
            aria-label="Filter transfers"
            onclick={() => (filterSheet = true)}
            ><ListFilter size={18} /><span>{client.filter === 'all' ? 'Filter' : activeTitle}</span
            ></button
          >{/if}
        <div class="sort-control">
          <ArrowUpDown size={12} /><select aria-label="Sort transfers" bind:value={client.sort}
            ><option value="addedDate">Date added</option><option value="name">Name</option><option
              value="rateDownload">Download speed</option
            ><option value="percentDone">Progress</option><option value="sizeWhenDone">Size</option
            ><option value="queuePosition">Queue order</option></select
          ><button
            class="tiny-button"
            aria-label="Reverse sort direction"
            onclick={() => (client.ascending = !client.ascending)}
            ><ChevronDown
              size={13}
              style={`transform:rotate(${client.ascending ? 180 : 0}deg)`}
            /></button
          >
        </div>
      </div>
      <div class="torrent-list" role="listbox" aria-label="Transfers" aria-multiselectable="true">
        {#each client.visible as t (t.id)}<div
            data-row={t.id}
            animate:flip={{
              duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 200,
            }}
          >
            <TorrentRow
              torrent={t}
              selected={client.selected.includes(t.id)}
              open={() => {
                client.select(t);
                inspector = true;
              }}
              menu={openMenu}
            />
          </div>{:else}<div class="empty-library">
            {#if !client.ready}<span class="loading-ring"></span>
              <h2>Connecting to Transmission</h2>
              <p>
                {client.error
                  ? 'Open settings to check your connection.'
                  : 'Your transfers will appear here.'}
              </p>{:else if client.query}<Search size={28} />
              <h2>No matching transfers</h2>
              <p>Try a different name, label, or folder.</p>
              <button class="button" onclick={() => (client.query = '')}>Clear search</button
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
      <footer class="statusbar">
        <span
          >{client.torrents.length} transfer{client.torrents.length === 1 ? '' : 's'}<span
            class="statusbar-size"
          >
            · {bytes(client.torrents.reduce((n, t) => n + t.sizeWhenDone, 0))}</span
          ></span
        >
        <div>
          <span class="download"><ArrowDown size={12} />{speed(client.stats.downloadSpeed)}</span
          ><span class="upload"><ArrowUp size={12} />{speed(client.stats.uploadSpeed)}</span>
        </div>
        <button
          class="text-button"
          onclick={() => openSettings('Limits')}
          aria-label="Open bandwidth settings"
          ><Gauge size={13} /><span
            >{client.session['alt-speed-enabled'] ? 'Slow mode' : 'Bandwidth'}</span
          ></button
        >
      </footer>
    {/if}
  </main>
  {#if inspector && client.focused && (!mobile || mobileSection === 'transfers')}<Inspector
      {mobile}
      torrent={client.details?.id === client.focused.id
        ? { ...client.details, ...client.focused }
        : client.focused}
      close={() => {
        client.selected = [];
        inspector = true;
      }}
    />{/if}
</div>

{#if mobile}<div class="mobile-dock">
    <nav class="mobile-tabbar" aria-label="Main navigation">
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
    onclick={() => (context = null)}
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
      if (e.key === 'Escape') context = null;
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
      {client.selected.length > 1 ? `${client.selected.length} transfers` : context.t.name}
    </div>
    <button role="menuitem" onclick={() => run(anyRunning ? 'torrent-stop' : 'torrent-start')}
      >{#if anyRunning}<Pause size={15} />Pause{:else}<Play size={15} />Resume{/if}<kbd>Space</kbd
      ></button
    ><button role="menuitem" onclick={() => run('torrent-start-now')}
      ><Play size={15} />Start now <small>Skip queue</small></button
    >
    {#if client.fullSpeedAvailable && client.selected.length === 1 && context.t.percentDone < 1}<button
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
    <hr />
    <button
      role="menuitem"
      onclick={() => {
        inspector = true;
        context = null;
      }}><Info size={15} />Show details <kbd>↵</kbd></button
    ><button role="menuitem" onclick={() => run('torrent-verify')}
      ><CheckCheck size={15} />Verify local files</button
    ><button role="menuitem" onclick={() => run('torrent-reannounce')}
      ><RefreshCw size={15} />Ask trackers for peers</button
    ><button
      role="menuitem"
      onclick={() => {
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
    <div class="queue-actions">
      <span>Queue</span><button
        role="menuitem"
        title="Move to top"
        onclick={() => run('queue-move-top')}>Top</button
      ><button role="menuitem" title="Move up" onclick={() => run('queue-move-up')}>↑</button
      ><button role="menuitem" title="Move down" onclick={() => run('queue-move-down')}>↓</button
      ><button role="menuitem" title="Move to bottom" onclick={() => run('queue-move-bottom')}
        >Bottom</button
      >
    </div>
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
        <span class="muted"
          >{addFiles.length > 0
            ? 'File selection is available in the inspector.'
            : 'Magnet file lists arrive after connecting to peers.'}</span
        ><button class="button primary" disabled={adding || (!addText.trim() && !addFiles.length)}
          >{adding ? 'Adding…' : 'Add transfer'}<ChevronRight size={14} /></button
        >
      </div>
    </form></Modal
  >{/if}
{#if modal === 'remove'}<Modal
    title={`Remove ${client.selected.length === 1 ? 'transfer' : `${client.selected.length} transfers`}?`}
    close={() => (modal = null)}
    ><form
      class="modal-form"
      onsubmit={async (e) => {
        e.preventDefault();
        await client.safeAction('torrent-remove', client.selected, {
          'delete-local-data': deleteData,
        });
        modal = null;
      }}
    >
      <p class="remove-description">
        {client.selected.length === 1
          ? client.focused?.name
          : `${client.selected.length} selected transfers`}
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
        await client.safeAction('torrent-set-location', client.selected, {
          location: moveDir,
          move: moveData,
        });
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
  <div class="settings-tabs">
    {#each ['Connection', 'Limits', 'Transfers', 'Network', 'Appearance'] as name}<button
        class:active={settingsTab === name}
        onclick={() => (settingsTab = name)}>{name}</button
      >{/each}
  </div>
  {#if settingsTab === 'Connection'}<form
      class="modal-form"
      onsubmit={(e) => {
        e.preventDefault();
        void connect();
      }}
    >
      <label
        >Transmission RPC URL<input
          class="input mono"
          type="url"
          required
          bind:value={endpoint}
          placeholder="http://localhost:9091/transmission/rpc"
        /></label
      >
      <div class="two-fields">
        <label>Username<input class="input" autocomplete="username" bind:value={username} /></label
        ><label
          >Password<input
            class="input"
            type="password"
            autocomplete="current-password"
            bind:value={password}
          /></label
        >
      </div>
      <p class="hint">
        The address is saved on this device. Credentials stay in memory. Remote servers must permit
        your origin through CORS or a same-origin proxy.
      </p>
      <div class="server-version">
        <span class="status-dot" class:success={client.online}></span>Transmission {client.session
          .version || '—'}<span>RPC {client.session['rpc-version'] || '—'}</span>
      </div>
      <button class="button primary" disabled={saving}>{saving ? 'Connecting…' : 'Connect'}</button>
    </form>
  {:else if settingsTab === 'Appearance'}<div class="modal-form">
      <label
        >Color theme<select class="input" bind:value={theme}
          ><option value="system">Follow system</option><option value="light">Light</option><option
            value="dark">Dark</option
          ></select
        ></label
      >
      <h3>Keyboard shortcuts</h3>
      <dl class="shortcuts">
        <div>
          <dt>Search</dt>
          <dd>⌘ / Ctrl F</dd>
        </div>
        <div>
          <dt>Add torrent</dt>
          <dd>⌘ / Ctrl O</dd>
        </div>
        <div>
          <dt>Select all</dt>
          <dd>⌘ / Ctrl A</dd>
        </div>
        <div>
          <dt>Navigate transfers</dt>
          <dd>↑ / ↓</dd>
        </div>
        <div>
          <dt>Inspect</dt>
          <dd>Enter</dd>
        </div>
        <div>
          <dt>Remove</dt>
          <dd>Delete</dd>
        </div>
        <div>
          <dt>Close / clear selection</dt>
          <dd>Escape</dd>
        </div>
      </dl>
      <p class="hint">Drift 0.1 · Static, self-hosted, and private by default.</p>
    </div>
  {:else}<form
      class="modal-form settings-form"
      onsubmit={(e) => {
        e.preventDefault();
        void saveSession();
      }}
    >
      {#if settingsTab === 'Limits'}
        {#if client.fullSpeedAvailable}<p class="hint">
            This server adjusts bandwidth automatically. Use Full speed on a download to bypass its
            automatic limits.
          </p>{/if}
        {#each [{ check: 'speed-limit-down-enabled', key: 'speed-limit-down', title: 'Limit download', unit: 'KB/s' }, { check: 'speed-limit-up-enabled', key: 'speed-limit-up', title: 'Limit upload', unit: 'KB/s' }, { check: 'download-queue-enabled', key: 'download-queue-size', title: 'Download queue', unit: 'active' }, { check: 'seed-queue-enabled', key: 'seed-queue-size', title: 'Seeding queue', unit: 'active' }, { check: 'seedRatioLimited', key: 'seedRatioLimit', title: 'Seed ratio limit', unit: 'ratio' }, { check: 'idle-seeding-limit-enabled', key: 'idle-seeding-limit', title: 'Stop idle seeding', unit: 'minutes' }] as field}<label
            class="check-row"
            ><input type="checkbox" bind:checked={sessionDraft[field.check]} />{field.title}<span
              class="number-unit"
              ><input
                aria-label={field.title}
                type="number"
                min="0"
                step="any"
                bind:value={sessionDraft[field.key]}
              />{field.unit}</span
            ></label
          >{/each}
        <h3>Slow mode</h3>
        <label class="check-row"
          ><input type="checkbox" bind:checked={sessionDraft['alt-speed-enabled']} />Enable
          alternative speed limits</label
        ><label class="field-row"
          >Download (KB/s)<input
            type="number"
            min="0"
            bind:value={sessionDraft['alt-speed-down']}
          /></label
        ><label class="field-row"
          >Upload (KB/s)<input
            type="number"
            min="0"
            bind:value={sessionDraft['alt-speed-up']}
          /></label
        >
      {:else if settingsTab === 'Transfers'}<label
          >Download directory<input
            class="input mono"
            bind:value={sessionDraft['download-dir']}
          /></label
        ><label class="check-row"
          ><input type="checkbox" bind:checked={sessionDraft['incomplete-dir-enabled']} />Use a
          temporary directory</label
        ><label
          >Temporary directory<input
            class="input mono"
            bind:value={sessionDraft['incomplete-dir']}
          /></label
        ><label class="check-row"
          ><input type="checkbox" bind:checked={sessionDraft['rename-partial-files']} />Append .part
          to incomplete files</label
        ><label class="check-row"
          ><input type="checkbox" bind:checked={sessionDraft['start-added-torrents']} />Start new
          torrents automatically</label
        >
      {:else if settingsTab === 'Network'}<label class="field-row"
          >Peer port<input
            type="number"
            min="1"
            max="65535"
            bind:value={sessionDraft['peer-port']}
          /></label
        ><button
          type="button"
          class="text-button"
          onclick={async () => {
            try {
              const r = await client.rpc.call('port-test');
              client.toast(
                r['port-is-open']
                  ? 'Peer port is reachable'
                  : 'Peer port is closed. Outgoing connections can still work.',
              );
            } catch (e) {
              client.toast(String(e));
            }
          }}>Test incoming port <ExternalLink size={12} /></button
        ><label class="field-row"
          >Global peer limit<input
            type="number"
            min="1"
            bind:value={sessionDraft['peer-limit-global']}
          /></label
        ><label class="field-row"
          >Peers per torrent<input
            type="number"
            min="1"
            bind:value={sessionDraft['peer-limit-per-torrent']}
          /></label
        ><label class="field-row"
          >Encryption<select bind:value={sessionDraft.encryption}
            ><option value="tolerated">Allow unencrypted</option><option value="preferred"
              >Prefer encrypted</option
            ><option value="required">Require encrypted</option></select
          ></label
        >{#each [['port-forwarding-enabled', 'Automatic port forwarding'], ['dht-enabled', 'Distributed hash table (DHT)'], ['pex-enabled', 'Peer exchange (PEX)'], ['lpd-enabled', 'Local peer discovery'], ['utp-enabled', 'µTP transport'], ['blocklist-enabled', 'Peer blocklist']] as field}<label
            class="check-row"
            ><input type="checkbox" bind:checked={sessionDraft[field[0]]} />{field[1]}</label
          >{/each}<label
          >Blocklist URL<input
            class="input mono"
            type="url"
            bind:value={sessionDraft['blocklist-url']}
          /></label
        ><button
          type="button"
          class="text-button"
          onclick={async () => {
            try {
              const r = await client.rpc.call('blocklist-update');
              client.toast(`Blocklist updated: ${r['blocklist-size']} entries`);
            } catch (e) {
              client.toast(String(e));
            }
          }}><RefreshCw size={12} />Update blocklist</button
        >{/if}
      <button class="button primary" disabled={saving || !client.online}
        >{saving ? 'Saving…' : 'Save changes'}</button
      >
    </form>{/if}
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
        Your browser blocked automatic copying. Select the text and press ⌘C or Ctrl+C.
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
