<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { motion } from '../lib/motion';
  import {
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    Copy,
    ExternalLink,
    File,
    Folder,
    FolderOpen,
    MoreHorizontal,
    Pencil,
    Check,
    Minus,
    List,
    Network,
    Pause,
    Play,
    Square,
    RefreshCw,
    ShieldCheck,
    Tag,
    ArrowDown,
    ArrowUp,
    CheckCircle2,
    X,
    Zap,
  } from '@lucide/svelte';
  import { fly } from 'svelte/transition';
  import { client } from '../lib/client.svelte';
  import { bytes, date, duration, percent, speed } from '../lib/format';
  import { stage } from '../lib/stage';
  import { transferControl } from '../lib/transfer-control';
  import { fileTree, flatten, type FileNode } from '../lib/files';
  import type { Torrent } from '../lib/types';
  import PeerGraph from './PeerGraph.svelte';
  import PriorityControl from './PriorityControl.svelte';
  import Modal from './Modal.svelte';
  let {
    torrent: t,
    close,
    mobile = false,
  }: { torrent: Torrent; close: () => void; mobile?: boolean } = $props();
  function panelIn(node: HTMLElement) {
    delete node.dataset.closing;
    for (const key of ['position', 'width', 'height', 'top', 'right', 'bottom', 'left', 'z-index'])
      node.style.removeProperty(key);
    return fly(node, { x: mobile ? 36 : 16, duration: motion(180) });
  }
  function panelOut(node: HTMLElement) {
    const rect = node.getBoundingClientRect();
    node.dataset.closing = 'true';
    Object.assign(node.style, {
      position: 'fixed',
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      top: `${rect.top}px`,
      left: `${rect.left}px`,
      right: 'auto',
      bottom: 'auto',
      zIndex: '30',
    });
    return fly(node, { x: mobile ? 36 : 16, duration: motion(180) });
  }
  const optionsFormId = $props.id();
  const tabsId = `${optionsFormId}-tabs`;
  let panel: HTMLElement;
  let scrollPane: HTMLDivElement;
  let tab = $state('Overview');
  let fileFocus = $state('');
  let collapsed = $state(new Set<string>());
  let fileQuery = $state('');
  let chosenPeer = $state<string | null>(null);
  type PeerSort = 'address' | 'progress' | 'rateToClient' | 'rateToPeer';
  let peerSort = $state<PeerSort>('address');
  let peerDescending = $state(false);
  const peerColumns = [
    { key: 'address', label: 'Peer / Client', hint: 'Sort by peer IP address' },
    { key: 'progress', label: 'Has', hint: 'Percentage of this torrent available from the peer' },
    {
      key: 'rateToClient',
      label: 'Download',
      hint: 'Sort by current download speed from the peer',
    },
    { key: 'rateToPeer', label: 'Upload', hint: 'Sort by current upload speed to the peer' },
  ] as const;
  let sortedPeers = $derived(
    [...(t.peers || [])].sort((a, b) => {
      const result =
        peerSort === 'address'
          ? a.address.localeCompare(b.address, undefined, { numeric: true }) || a.port - b.port
          : a[peerSort] - b[peerSort];
      return (peerDescending ? -1 : 1) * result;
    }),
  );
  function sortPeers(key: PeerSort) {
    if (peerSort === key) peerDescending = !peerDescending;
    else {
      peerSort = key;
      peerDescending = key !== 'address';
    }
  }

  function peerClient(name: string) {
    if (/qbittorrent/i.test(name)) return 'qB';
    if (/transmission/i.test(name)) return 'Tr';
    if (/deluge/i.test(name)) return 'De';
    if (/utorrent|µtorrent|μtorrent/i.test(name)) return 'µT';
    if (/libtorrent/i.test(name)) return 'LT';
    return 'BT';
  }
  $effect(() => {
    const selected = chosenPeer;
    if (selected)
      void tick().then(() => {
        const row = [...panel.querySelectorAll<HTMLElement>('.peer-row')].find(
          (el) => el.dataset.peer === selected,
        );
        if (!row) return;
        const bounds = row.getBoundingClientRect(),
          viewport = scrollPane.getBoundingClientRect();
        if (bounds.top < viewport.top || bounds.bottom > viewport.bottom)
          row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
  });
  let peerView = $state<'list' | 'diagram'>('list');
  $effect(() => {
    if (tab && peerView && scrollPane) scrollPane.scrollTop = 0;
  });
  let rename = $state<FileNode | null>(null);
  let fileContext = $state<{ node: FileNode; x: number; y: number } | null>(null);
  let fileMenuTrigger: HTMLElement | null = null;
  function openFileMenu(e: MouseEvent | KeyboardEvent, n: FileNode) {
    e.preventDefault();
    e.stopPropagation();
    fileMenuTrigger = e.currentTarget as HTMLElement;
    const rect = fileMenuTrigger.getBoundingClientRect();
    const event = e as MouseEvent;
    fileContext = { node: n, x: event.clientX || rect.left, y: event.clientY || rect.bottom };
    void tick().then(() => {
      const menu = document.querySelector<HTMLElement>('.file-context-menu');
      if (!menu || fileContext?.node.path !== n.path) return;
      if (!mobile) {
        const bounds = menu.getBoundingClientRect();
        let x = fileContext.x,
          y = fileContext.y;
        if (fileMenuTrigger?.classList.contains('file-actions')) {
          x = rect.right - bounds.width;
          const below = innerHeight - rect.bottom - 18;
          const above = rect.top - 18;
          if (bounds.height > Math.max(below, above)) {
            x = rect.left - bounds.width - 6;
            y = rect.top;
          } else y = bounds.height <= below ? rect.bottom + 6 : rect.top - bounds.height - 6;
        }
        fileContext = {
          ...fileContext,
          x: Math.max(12, Math.min(x, innerWidth - bounds.width - 12)),
          y: Math.max(12, Math.min(y, innerHeight - bounds.height - 12)),
        };
      }
      menu.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    });
  }
  function closeFileMenu() {
    fileContext = null;
    if (fileMenuTrigger?.isConnected) fileMenuTrigger.focus({ preventScroll: true });
  }
  let renameValue = $state('');
  let trackerText = $state<string | null>(null);
  let trackerEditing = $state(false);
  let expandedTrackers = $state(new Set<number>());
  let saving = $state(false);
  let options = $state<Record<string, any>>({});
  let optionsId = $state(-1);
  let editingOption = $state('');
  let optionsReady = $derived(typeof t.honorsSessionLimits === 'boolean');
  let optionsPending = $derived(
    Object.keys(client.optionDrafts).some((key) => key.startsWith(`${t.id}:`)),
  );
  const optionKeys = [
    'downloadLimit',
    'downloadLimited',
    'uploadLimit',
    'uploadLimited',
    'honorsSessionLimits',
    'bandwidthPriority',
    'peer-limit',
    'seedRatioMode',
    'seedRatioLimit',
    'seedIdleMode',
    'seedIdleLimit',
    'sequential_download',
  ];
  function changeOption(event: Event) {
    const input = event.target as HTMLInputElement | HTMLSelectElement;
    if (
      !optionKeys.includes(input.name) ||
      !input.validity.valid ||
      !client.online ||
      !optionsReady
    )
      return;
    const value =
      input instanceof HTMLInputElement && input.type === 'checkbox'
        ? input.checked
        : Number(input.value);
    if (input.value === '' || (typeof value === 'number' && !Number.isFinite(value))) return;
    if (value === (client.optionDrafts[`${t.id}:${input.name}`] ?? t[input.name])) return;
    client.queueOption(t.id, input.name, value, input.type === 'number' ? 400 : 0);
  }
  let labelsText = $state('');
  let labelEditing = $state(false);
  const tabs = ['Overview', 'Files', 'Peers', 'Trackers', 'Options'];
  let s = $derived(stage(t));
  let control = $derived(transferControl(t));
  let tree = $derived(fileTree(t.files || []));
  let hasFolders = $derived(tree.some((n) => n.children.length));
  let nodes = $derived(
    flatten(tree, fileQuery ? new Set() : collapsed).filter((n) =>
      n.path.toLowerCase().includes(fileQuery.toLowerCase()),
    ),
  );
  let label = $derived(client.capabilities?.fullSpeed.label || 'router:full-speed');
  const trackerVpnLabel = 'router:tracker-vpn-retry';
  onMount(() => {
    const origin = document.querySelector<HTMLElement>('.torrent-row[aria-selected="true"]');
    if (mobile)
      panel.querySelector<HTMLElement>('.inspector-title h2')?.focus({ preventScroll: true });
    return () => {
      if (mobile && origin?.isConnected) origin.focus({ preventScroll: true });
    };
  });
  $effect(() => {
    if (!nodes.some((n) => n.path === fileFocus)) fileFocus = nodes[0]?.path || '';
  });
  async function focusFile(path: string) {
    fileFocus = path;
    await tick();
    panel.querySelectorAll<HTMLElement>('.file-node').forEach((node) => {
      if (node.dataset.path === path) node.focus({ preventScroll: false });
    });
  }
  function fileKeys(e: KeyboardEvent, n: FileNode) {
    if (e.target !== e.currentTarget) return;
    const index = nodes.findIndex((x) => x.path === n.path);
    if (
      ['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowLeft', 'ArrowRight', 'Enter', ' '].includes(
        e.key,
      )
    ) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (e.key === 'ArrowDown') void focusFile(nodes[Math.min(nodes.length - 1, index + 1)].path);
    if (e.key === 'ArrowUp') void focusFile(nodes[Math.max(0, index - 1)].path);
    if (e.key === 'Home') void focusFile(nodes[0].path);
    if (e.key === 'End') void focusFile(nodes.at(-1)!.path);
    if (e.key === 'ArrowRight' && n.children.length) {
      if (collapsed.has(n.path)) toggleFolder(n.path);
      else void focusFile(n.children[0].path);
    }
    if (e.key === 'ArrowLeft') {
      if (n.children.length && !collapsed.has(n.path)) toggleFolder(n.path);
      else {
        const parent = n.path.slice(0, n.path.lastIndexOf('/'));
        if (nodes.some((x) => x.path === parent)) void focusFile(parent);
      }
    }
    if (e.key === 'Enter') {
      if (n.children.length) toggleFolder(n.path);
      else fileOptions(n);
    }
    if (e.key === ' ')
      void client.safeAction('torrent-set', [t.id], {
        [checked(n) ? 'files-unwanted' : 'files-wanted']: n.ids,
      });
  }
  const priority = (n: FileNode) =>
    n.ids.every((i) => t.fileStats?.[i]?.priority === 1)
      ? 1
      : n.ids.every((i) => t.fileStats?.[i]?.priority === -1)
        ? -1
        : 0;
  const setPriority = (n: FileNode, value: number) =>
    client.safeAction('torrent-set', [t.id], {
      [value === 1 ? 'priority-high' : value === -1 ? 'priority-low' : 'priority-normal']: n.ids,
    });
  function fileOptions(n: FileNode) {
    rename = n;
    renameValue = n.name;
  }
  $effect(() => {
    if (optionsId !== t.id) {
      options = {};
      editingOption = '';
      optionsId = t.id;
      trackerEditing = false;
      labelEditing = false;
      collapsed = new Set();
      chosenPeer = null;
      if (scrollPane) scrollPane.scrollTop = 0;
    }
  });
  $effect(() => {
    const id = t.id;
    const values = Object.fromEntries(
      optionKeys.filter((key) => t[key] !== undefined).map((key) => [key, t[key]]),
    );
    const drafts = client.optionDrafts;
    const editing = editingOption;
    untrack(() => {
      for (const [key, value] of Object.entries(values)) {
        if (`${id}:${key}` in drafts) options[key] = drafts[`${id}:${key}`];
        else if (key !== editing) options[key] = value;
      }
    });
  });
  const toggleFolder = (path: string) => {
    collapsed = new Set(collapsed);
    if (collapsed.has(path)) collapsed.delete(path);
    else collapsed.add(path);
  };
  function checked(n: FileNode) {
    return n.ids.every((i) => t.fileStats?.[i]?.wanted ?? true);
  }
  function mixed(n: FileNode) {
    return !checked(n) && n.ids.some((i) => t.fileStats?.[i]?.wanted ?? true);
  }
  async function copy(text: string) {
    await client.copy(text);
  }
  async function saveTrackers() {
    saving = true;
    try {
      const text = trackerText || '';
      const urls = text.split(/\s+/).filter(Boolean);
      if (urls.some((u) => !/^(https?|udp):\/\//.test(u)))
        throw new Error('Use http, https, or udp tracker URLs');
      await client.action(
        'torrent-set',
        [t.id],
        Number(client.session['rpc-version']) >= 17
          ? { trackerList: text }
          : { trackerRemove: t.trackerStats.map((x) => x.id), trackerAdd: urls },
      );
      trackerEditing = false;
    } catch (e) {
      client.toast(String(e));
    } finally {
      saving = false;
    }
  }
</script>

<aside
  bind:this={panel!}
  class="inspector"
  class:mobile
  aria-label="Torrent inspector"
  in:panelIn|global
  out:panelOut|global
>
  <header class="inspector-header">
    {#if mobile}<button class="inspector-back" aria-label="Close inspector" onclick={close}
        ><ChevronLeft size={22} />Transfers</button
      >{:else}<span class="eyebrow">INSPECTOR</span>{/if}
    <div class="flex items-center gap-1">
      {#if tab === 'Options' && optionsPending}<span class="option-save-state" role="status"
          >Saving…</span
        >{/if}
      {#if !mobile}<button class="icon-button" aria-label="Close inspector" onclick={close}
          ><X size={17} /></button
        >{/if}
    </div>
  </header>
  <div class="inspector-title">
    <div class="file-tile"><File size={23} /></div>
    <h2 tabindex="-1">{t.name}</h2>
    <span class="muted"
      >{t.metadataPercentComplete < 1
        ? 'File list not received yet'
        : `${bytes(t.sizeWhenDone)} · ${t.files?.length || t.fileCount || 'Loading'} ${t.files || t.fileCount ? ((t.files?.length || t.fileCount) === 1 ? 'file' : 'files') : 'details…'}`}</span
    >
  </div>
  <div class="inspector-tabs" role="tablist" aria-label="Torrent details">
    {#each tabs as name}<button
        role="tab"
        id={`${tabsId}-${name}`}
        aria-controls={`${tabsId}-panel`}
        tabindex={tab === name ? 0 : -1}
        aria-selected={tab === name}
        class:active={tab === name}
        onclick={() => (tab = name)}
        onkeydown={(e) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
          e.preventDefault();
          const i = tabs.indexOf(name);
          tab =
            e.key === 'Home'
              ? tabs[0]
              : e.key === 'End'
                ? tabs.at(-1)!
                : tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
          panel.querySelector<HTMLElement>(`[id="${tabsId}-${tab}"]`)?.focus();
        }}
        >{name}{#if name === 'Peers' && t.peersConnected > 0}<small>{t.peersConnected}</small
          >{/if}</button
      >{/each}
  </div>
  <div
    class="inspector-scroll"
    bind:this={scrollPane!}
    role="tabpanel"
    id={`${tabsId}-panel`}
    aria-labelledby={`${tabsId}-${tab}`}
  >
    {#if tab === 'Overview'}
      <section
        class="torrent-stage"
        class:warning={s.tone === 'amber' || s.tone === 'red'}
        class:complete={t.percentDone === 1}
      >
        <div class="stage-heading">
          <span class="status-dot" class:pulse={s.active && !t.rateDownload && !t.rateUpload}
          ></span>
          <h3>{s.label}</h3>
          {#if s.progress !== undefined && t.percentDone < 1}<b>{percent(s.progress)}</b>{/if}
          <div class="stage-actions">
            <button
              class="button primary compact stage-control"
              title={control.label}
              aria-label={control.label}
              onclick={() => client.safeAction(control.method, [t.id])}
              >{#if control.icon === 'play'}<Play
                  size={16}
                />{:else if control.icon === 'stop'}<Square
                  size={16}
                  fill="currentColor"
                />{:else}<Pause size={16} />{/if}{#if t.percentDone >= 1}<span>{control.label}</span
                >{/if}</button
            >
            {#if client.fullSpeedAvailable && t.percentDone < 1}<button
                class="button secondary compact full-speed-button"
                class:enabled={client.isFullSpeed(t)}
                aria-pressed={client.isFullSpeed(t)}
                title="Bypass automatic bandwidth limits"
                onclick={() => client.fullSpeed(t)}
                ><Zap size={17} />{client.isFullSpeed(t)
                  ? client.fullSpeedApplied(t)
                    ? 'Full speed on'
                    : 'Applying…'
                  : 'Full speed'}</button
              >{/if}
          </div>
        </div>
        <p>{t.errorString || s.detail}</p>
        {#if t.percentDone < 1}<div
            class="detail-progress"
            class:indeterminate={s.active && s.progress === undefined}
          >
            <span style={`width:${(s.progress || 0) * 100}%`}></span>
          </div>{/if}
      </section>
      <section class="detail-section">
        <div class="section-heading">
          <h3>Activity</h3>
          <button class="button compact secondary" onclick={() => (tab = 'Peers')}
            >Peers <span class="button-count">{t.peersConnected}</span><ChevronRight
              size={15}
            /></button
          >
        </div>
        {#if t.rateDownload || t.rateUpload}<div class="speed-pair">
            <span class="download"
              ><ArrowDown size={18} /><b>{speed(t.rateDownload)}</b><small>Download</small></span
            ><span class="upload"
              ><ArrowUp size={18} /><b>{speed(t.rateUpload)}</b><small>Upload</small></span
            >
          </div>{:else}<p class="quiet-activity">
            {t.status === 0
              ? 'Transfer paused.'
              : t.percentDone === 1
                ? 'Waiting for other peers to request data.'
                : s.detail}
          </p>{/if}
        <dl class="transfer-totals">
          <div>
            <dt>Downloaded</dt>
            <dd>{bytes(t.downloadedEver)}</dd>
          </div>
          <div>
            <dt>Uploaded</dt>
            <dd>{bytes(t.uploadedEver)}</dd>
          </div>
          {#if t.eta >= 0 && t.percentDone < 1}<div>
              <dt>Time remaining</dt>
              <dd>{duration(t.eta)}</dd>
            </div>{/if}
        </dl>
      </section>
      {#if (t.labels || []).some((x) => x !== label)}<div class="label-chips">
          {#each (t.labels || []).filter((x) => x !== label && x !== trackerVpnLabel) as tag}<button
              class="label-chip"
              onclick={() => {
                client.labelFilter = tag;
                close();
              }}><Tag size={14} />{tag}</button
            >{/each}
        </div>{/if}
      <details class="detail-disclosure">
        <summary><ChevronRight size={15} />Torrent details</summary>
        <dl class="properties">
          <div>
            <dt>Added</dt>
            <dd>{date(t.addedDate)}</dd>
          </div>
          {#if t.doneDate}<div>
              <dt>Completed</dt>
              <dd>{date(t.doneDate)}</dd>
            </div>{/if}
          <div>
            <dt>Share ratio</dt>
            <dd>{t.uploadRatio >= 0 ? t.uploadRatio.toFixed(2) : 'No uploads yet'}</dd>
          </div>
          <div>
            <dt>Privacy</dt>
            <dd>{t.isPrivate ? 'Private torrent' : 'Public torrent'}</dd>
          </div>
          {#if t.creator}<div>
              <dt>Created by</dt>
              <dd>{t.creator}</dd>
            </div>{/if}
          <div>
            <dt>Pieces</dt>
            <dd>{t.pieceCount || 0} × {bytes(t.pieceSize)}</dd>
          </div>
        </dl>
        {#if t.comment}<p class="comment">{t.comment}</p>{/if}
        <div class="hash-line">
          <code>{t.hashString}</code><button
            class="icon-button"
            aria-label="Copy torrent hash"
            onclick={() => copy(t.hashString)}><Copy size={17} /></button
          >
        </div>
      </details>
      <details class="detail-disclosure">
        <summary><ChevronRight size={15} />Storage & labels</summary>
        <dl class="storage-location">
          <dt>Download folder</dt>
          <dd class="mono">{t.downloadDir}</dd>
        </dl>
        <button
          class="text-button labels-action"
          onclick={() => {
            labelsText = (t.labels || [])
              .filter((x) => x !== label && x !== trackerVpnLabel)
              .join(', ');
            labelEditing = true;
          }}><Tag size={16} />Edit labels</button
        >
      </details>
    {:else if tab === 'Files'}
      {#if t.metadataPercentComplete < 1}<div class="panel-empty">
          <Folder size={25} /><b>Waiting for the file list</b><span>{s.detail}</span>
        </div>{:else}
        <div class="file-toolbar">
          <input
            class="input"
            aria-label="Filter files"
            placeholder="Filter files…"
            bind:value={fileQuery}
          />{#if !fileQuery && hasFolders}
            <button
              class="icon-button tree-fold-action"
              aria-label={collapsed.size ? 'Expand all folders' : 'Collapse all folders'}
              onclick={() =>
                (collapsed = collapsed.size
                  ? new Set()
                  : new Set(
                      flatten(tree, new Set())
                        .filter((n) => n.children.length)
                        .map((n) => n.path),
                    ))}
              >{#if collapsed.size}<FolderOpen size={19} />{:else}<Folder size={19} />{/if}</button
            >{/if}
        </div>
        <div class="file-tree" class:flat={!hasFolders} role="tree" aria-label="Torrent files">
          {#each nodes as n (n.path)}<div
              role="treeitem"
              data-path={n.path}
              tabindex={fileFocus === n.path ? 0 : -1}
              onfocus={() => (fileFocus = n.path)}
              onkeydown={(e) => {
                fileKeys(e, n);
                if (e.key === 'F2') {
                  e.preventDefault();
                  e.stopPropagation();
                  fileOptions(n);
                }
                if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) openFileMenu(e, n);
              }}
              oncontextmenu={(e) => openFileMenu(e, n)}
              aria-selected={checked(n)}
              aria-expanded={n.children.length ? !collapsed.has(n.path) : undefined}
              aria-level={n.depth + 1}
              class="file-node"
              class:menu-open={fileContext?.node.path === n.path}
              style={`--depth:${fileQuery ? 0 : n.depth}`}
              class:folder={n.children.length > 0}
            >
              <input
                type="checkbox"
                tabindex={fileFocus === n.path ? 0 : -1}
                aria-label={`Download ${n.path}`}
                checked={checked(n)}
                indeterminate={mixed(n)}
                onchange={(e) =>
                  client.safeAction('torrent-set', [t.id], {
                    [e.currentTarget.checked ? 'files-wanted' : 'files-unwanted']: n.ids,
                  })}
              />
              <div class="file-copy">
                <button
                  class="file-name"
                  tabindex={fileFocus === n.path ? 0 : -1}
                  title={n.path}
                  aria-label={n.children.length ? `Toggle ${n.name}` : `File options for ${n.path}`}
                  onclick={() => {
                    if (n.children.length) toggleFolder(n.path);
                    else fileOptions(n);
                  }}
                  >{#if hasFolders}<span class="tree-disclosure"
                      >{#if n.children.length}{#if collapsed.has(n.path)}<ChevronRight
                            size={12}
                          />{:else}<ChevronDown size={12} />{/if}{/if}</span
                    >{/if}{#if n.children.length}<Folder size={16} />{:else}<File
                      size={16}
                    />{/if}<span>{n.name}</span></button
                >
                {#if fileQuery && n.path.includes('/')}<small class="file-path"
                    >{#each n.path
                      .slice(0, n.path.lastIndexOf('/'))
                      .split('/') as part, i}{#if i > 0}<span> / </span><wbr
                        />{/if}{part}{/each}</small
                  >{/if}
              </div>
              <span class="file-meta"
                >{#if priority(n) !== 0}<span
                    class="file-priority-mark"
                    title={priority(n) === 1 ? 'High priority' : 'Low priority'}
                    >{#if priority(n) === 1}<ArrowUp size={13} />{:else}<ArrowDown
                        size={13}
                      />{/if}</span
                  >{/if}{n.children.length
                  ? `${n.ids.length} ${n.ids.length === 1 ? 'file' : 'files'}`
                  : bytes(n.length)}{#if !n.children.length && n.completed < n.length}<span
                    class="file-completion"
                  >
                    · {percent(n.length ? n.completed / n.length : 1)}</span
                  >{/if}</span
              >
              <button
                class="icon-button file-actions"
                aria-haspopup="menu"
                aria-expanded={fileContext?.node.path === n.path}
                tabindex={fileFocus === n.path ? 0 : -1}
                aria-label={`Actions for ${n.path}`}
                onclick={(e) => openFileMenu(e, n)}><MoreHorizontal size={17} /></button
              >
            </div>{/each}
          {#if !nodes.length}<div class="panel-empty">
              <File size={24} /><b>No matching files</b><button
                class="button secondary"
                onclick={() => (fileQuery = '')}>Clear filter</button
              >
            </div>{/if}
        </div>{/if}
    {:else if tab === 'Peers'}
      {#if mobile}<div class="peer-view-control" role="group" aria-label="Peer view">
          <button aria-pressed={peerView === 'list'} onclick={() => (peerView = 'list')}
            ><List size={17} />List</button
          ><button aria-pressed={peerView === 'diagram'} onclick={() => (peerView = 'diagram')}
            ><Network size={17} />Diagram</button
          >
        </div>{/if}
      {#if !mobile || peerView === 'diagram'}<PeerGraph
          peers={t.peers || []}
          compact={mobile}
          bind:chosen={chosenPeer}
        />{/if}
      {#if true}
        <div class="section-heading">
          <h3>{t.peersConnected} connected peers</h3>
          <span class="muted">{t.peersSendingToUs} sending data</span>
        </div>
        <div class="table-scroll">
          <div class="peer-list">
            {#if t.peers?.length}<div class="peer-columns" role="row">
                {#each peerColumns as column}
                  <div
                    role="columnheader"
                    aria-sort={peerSort === column.key
                      ? peerDescending
                        ? 'descending'
                        : 'ascending'
                      : 'none'}
                  >
                    <button title={column.hint} onclick={() => sortPeers(column.key)}>
                      {column.label}
                      {#if peerSort === column.key}
                        {#if peerDescending}<ArrowDown size={12} />{:else}<ArrowUp size={12} />{/if}
                      {/if}
                    </button>
                  </div>
                {/each}
              </div>{/if}
            {#each sortedPeers as p (p.address + ':' + p.port)}<button
                class="peer-row"
                data-peer={`${p.address}:${p.port}`}
                class:selected={chosenPeer === `${p.address}:${p.port}`}
                aria-label={`Select peer ${p.address} port ${p.port}`}
                aria-pressed={chosenPeer === `${p.address}:${p.port}`}
                onclick={() =>
                  (chosenPeer =
                    chosenPeer === `${p.address}:${p.port}` ? null : `${p.address}:${p.port}`)}
                ><span
                  ><span class="peer-address">
                    {p.address}{#if p.isEncrypted}<ShieldCheck size={11} />{/if}
                  </span>
                  <small
                    class="peer-client-line"
                    title={`${p.clientName || 'Unknown client'} · Port ${p.port} · ${p.isUTP ? 'µTP' : 'TCP'}${p.isIncoming ? ' · Incoming' : ''}`}
                  >
                    <span class="peer-client-badge" aria-label={p.clientName || 'Unknown client'}
                      >{peerClient(p.clientName || '')}</span
                    >
                    <span>{p.port}</span><span>{p.isUTP ? 'µTP' : 'TCP'}</span>
                  </small></span
                ><span class="peer-progress" title="Percentage of the torrent this peer has"
                  >{percent(p.progress)}</span
                ><span class="download"
                  >{speed(p.rateToClient)}<small
                    >{p.bytes_to_client === undefined ? '—' : bytes(p.bytes_to_client)} received</small
                  ></span
                ><span class="upload"
                  >{speed(p.rateToPeer)}<small
                    >{p.bytes_to_peer === undefined ? '—' : bytes(p.bytes_to_peer)} sent</small
                  ></span
                ></button
              >{:else}<p class="hint">{s.detail}</p>{/each}
          </div>
        </div>
      {/if}
    {:else if tab === 'Trackers'}
      <div class="section-heading tracker-toolbar">
        <h3>Peer discovery</h3>
        <div class="section-actions">
          {#if client.trackerVpnAvailable && t.trackerStats?.some((tracker) => tracker.announce.startsWith('udp://') && tracker.lastAnnounceTime > 0 && !tracker.lastAnnounceSucceeded)}
            <button
              class="icon-button"
              aria-label="Retry failed with VPN"
              title="Retry failed UDP trackers with VPN"
              disabled={!client.online ||
                !client.capabilities?.trackerVpn?.available ||
                client.busy.has(t.id) ||
                client.capabilities?.trackerVpn?.retrying?.includes(t.hashString) ||
                t.labels.includes(trackerVpnLabel)}
              onclick={() => client.trackerVpn(t)}><ShieldCheck size={16} /></button
            >
          {/if}
          <button
            class="icon-button"
            aria-label="Reannounce torrent"
            title="Ask trackers for peers"
            onclick={() => client.safeAction('torrent-reannounce', [t.id])}
            ><RefreshCw size={14} /></button
          ><button
            class="icon-button"
            onclick={() => {
              trackerText = t.trackerList || t.trackerStats.map((x) => x.announce).join('\n');
              trackerEditing = true;
            }}
            title="Edit trackers"
            aria-label="Edit trackers"><Pencil size={18} /></button
          >
        </div>
      </div>
      {#each t.trackerStats || [] as tracker (tracker.id)}
        {@const failed = tracker.lastAnnounceTime > 0 && !tracker.lastAnnounceSucceeded}
        {@const expanded = expandedTrackers.has(tracker.id)}
        <article class="tracker">
          <button
            class="tracker-heading"
            aria-label={`Details for ${tracker.host || tracker.announce}`}
            aria-expanded={expanded}
            onclick={() => {
              const next = new Set(expandedTrackers);
              if (expanded) next.delete(tracker.id);
              else next.add(tracker.id);
              expandedTrackers = next;
            }}
          >
            <span class="status-dot" class:success={tracker.lastAnnounceSucceeded} class:failed
            ></span>
            <span class="tracker-copy">
              <strong title={tracker.announce}
                >{tracker.host || tracker.announce}
                {#if client.capabilities?.trackerVpn?.routes?.[t.hashString]?.includes(tracker.announce)}<span
                    class="tracker-route"
                    title="This tracker succeeded through VPN"><ShieldCheck size={11} />VPN</span
                  >{/if}
              </strong>
              <span class="tracker-summary">
                <span class:danger={failed} title={failed ? tracker.lastAnnounceResult : undefined}
                  >{tracker.announceState === 3
                    ? 'Announcing…'
                    : failed
                      ? tracker.lastAnnounceResult
                      : tracker.lastAnnounceTime === 0
                        ? 'Waiting to announce'
                        : `${tracker.seederCount >= 0 ? `${tracker.seederCount} seeds` : 'Seeds unknown'} · ${tracker.lastAnnouncePeerCount || 0} peers`}</span
                >
                {#if tracker.nextAnnounceTime > 0}<span class="next-announce"
                    >{failed ? 'Retry in' : 'Next in'}
                    {duration(tracker.nextAnnounceTime - Date.now() / 1000)}</span
                  >{/if}
              </span></span
            >
            <ChevronDown
              size={15}
              class="muted"
              style={`transform:rotate(${expanded ? 180 : 0}deg)`}
            />
          </button>
          {#if expanded}<div class="tracker-extra">
              {#if failed}<p class="danger">{tracker.lastAnnounceResult}</p>{/if}
              <code>{tracker.announce}</code>
              <div>
                <span>Tier {tracker.tier + 1}</span><span
                  >{tracker.leecherCount >= 0
                    ? `${tracker.leecherCount} leechers`
                    : 'Leechers unknown'}</span
                >
              </div>
              <div><span>Last announce</span><span>{date(tracker.lastAnnounceTime)}</span></div>
              <div><span>Next announce</span><span>{date(tracker.nextAnnounceTime)}</span></div>
            </div>{/if}
        </article>
      {:else}<div class="panel-empty">
          <ExternalLink size={24} /><b>No trackers</b><span
            >{t.isPrivate
              ? 'Add a tracker for this private torrent.'
              : 'Peer discovery uses DHT and peer exchange.'}</span
          >
        </div>{/each}
    {:else if tab === 'Options'}
      <fieldset
        class="options-form"
        disabled={!client.online || !optionsReady}
        oninput={changeOption}
        onchange={changeOption}
        onfocusin={(e) => {
          const input = e.target as HTMLInputElement;
          editingOption = input.type === 'number' ? input.name : '';
        }}
        onfocusout={() => {
          editingOption = '';
          client.flushOptions(t.id);
        }}
      >
        {#if typeof t.sequential_download === 'boolean'}<section class="settings-group">
            <h3>Downloading</h3>
            <div class="settings-card">
              <label class="setting-row"
                ><span class="setting-copy"
                  ><b>Sequential download</b><small
                    >Download pieces in order for video playback.</small
                  ></span
                ><input
                  type="checkbox"
                  role="switch"
                  name="sequential_download"
                  bind:checked={options.sequential_download}
                /></label
              >
            </div>
          </section>{/if}
        <section class="settings-group">
          <h3>Bandwidth</h3>
          <div class="settings-card">
            <label class="setting-row"
              ><span class="setting-copy"
                ><b>Use global speed limits</b><small>Follow the server's bandwidth settings.</small
                ></span
              ><input
                type="checkbox"
                role="switch"
                name="honorsSessionLimits"
                bind:checked={options.honorsSessionLimits}
              /></label
            >
            {#each [{ key: 'downloadLimited', value: 'downloadLimit', title: 'Download limit', aria: 'Download limit in KB/s' }, { key: 'uploadLimited', value: 'uploadLimit', title: 'Upload limit', aria: 'Upload limit in KB/s' }] as f}<label
                class="setting-row"
                ><span class="setting-copy"><b>{f.title}</b></span><input
                  role="switch"
                  type="checkbox"
                  name={f.key}
                  bind:checked={options[f.key]}
                /></label
              >{#if options[f.key]}<label class="setting-row"
                  ><span>Maximum speed</span><span class="number-unit"
                    ><input
                      type="number"
                      min="0"
                      required
                      name={f.value}
                      aria-label={f.aria}
                      bind:value={options[f.value]}
                    />KB/s</span
                  ></label
                >{/if}{/each}
            <div class="setting-row priority-setting">
              <span class="setting-copy"
                ><b>Bandwidth priority</b><small>Priority relative to other torrents.</small></span
              >
              <PriorityControl
                label="Bandwidth priority"
                value={options.bandwidthPriority}
                disabled={!client.online || !optionsReady}
                onchange={(value) => {
                  options.bandwidthPriority = value;
                  client.queueOption(t.id, 'bandwidthPriority', value, 0);
                }}
              />
            </div>
          </div>
        </section>
        <section class="settings-group">
          <h3>Seeding</h3>
          <div class="settings-card">
            <label class="setting-row"
              ><span>Share ratio</span><select
                name="seedRatioMode"
                bind:value={options.seedRatioMode}
                ><option value={0}>Global setting</option><option value={1}>Custom limit</option
                ><option value={2}>Unlimited</option></select
              ></label
            >
            {#if options.seedRatioMode === 1}<label class="setting-row"
                ><span>Target ratio</span><input
                  type="number"
                  min="0"
                  step="0.1"
                  name="seedRatioLimit"
                  required
                  aria-label="Ratio limit"
                  bind:value={options.seedRatioLimit}
                /></label
              >{/if}
            <label class="setting-row"
              ><span>Inactive seeds</span><select
                name="seedIdleMode"
                bind:value={options.seedIdleMode}
                ><option value={0}>Global setting</option><option value={1}>Custom timeout</option
                ><option value={2}>Unlimited</option></select
              ></label
            >
            {#if options.seedIdleMode === 1}<label class="setting-row"
                ><span>Idle time</span><span class="number-unit"
                  ><input
                    type="number"
                    min="1"
                    required
                    name="seedIdleLimit"
                    aria-label="Idle minutes"
                    bind:value={options.seedIdleLimit}
                  />min</span
                ></label
              >{/if}
          </div>
        </section>
        <section class="settings-group">
          <h3>Connections</h3>
          <div class="settings-card">
            <label class="setting-row"
              ><span>Peer limit</span><input
                type="number"
                min="1"
                required
                name="peer-limit"
                aria-label="Peer limit"
                bind:value={options['peer-limit']}
              /></label
            >
          </div>
        </section>
      </fieldset>
    {/if}
  </div>
</aside>
{#if fileContext}<button
    class="context-scrim"
    aria-label="Dismiss file menu"
    onclick={closeFileMenu}
  ></button>
  <div
    class="context-menu file-context-menu"
    role="menu"
    aria-label="File actions"
    tabindex="-1"
    style={`left:${fileContext.x}px;top:${fileContext.y}px`}
    onkeydown={(e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeFileMenu();
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(i + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
      }
    }}
  >
    <PriorityControl
      value={priority(fileContext.node)}
      onchange={(value) => {
        void setPriority(fileContext!.node, value);
      }}
    />
    <button
      role="menuitem"
      onclick={() => {
        const node = fileContext!.node;
        closeFileMenu();
        fileOptions(node);
      }}><Pencil size={15} />Rename…</button
    >
  </div>{/if}
{#if rename}<Modal
    title={rename.children.length ? 'Folder options' : 'File options'}
    close={() => (rename = null)}
    ><form
      class="modal-form"
      onsubmit={async (e) => {
        e.preventDefault();
        if (!renameValue.trim() || renameValue.includes('/')) return;
        await client.safeAction('torrent-rename-path', [t.id], {
          path: rename!.path,
          name: renameValue,
        });
        rename = null;
      }}
    >
      <p class="file-option-path">{rename.path}</p>
      <p class="file-option-meta">
        {bytes(rename.length)} · {percent(rename.length ? rename.completed / rename.length : 1)} downloaded
      </p>
      <div class="priority-field">
        <span>Download priority</span><PriorityControl
          label="Download priority"
          value={priority(rename)}
          onchange={(value) => {
            void setPriority(rename!, value);
          }}
        />
      </div>
      <div class="rename-field">
        <label for={`${optionsFormId}-filename`}>Name</label>
        <div class="rename-field-row">
          <input
            id={`${optionsFormId}-filename`}
            class="input"
            required
            bind:value={renameValue}
          /><button class="button primary" disabled={renameValue === rename.name}>Rename</button>
        </div>
      </div>
    </form></Modal
  >{/if}
{#if trackerEditing}<Modal title="Edit trackers" close={() => (trackerEditing = false)}
    ><form
      class="modal-form"
      onsubmit={(e) => {
        e.preventDefault();
        void saveTrackers();
      }}
    >
      <label
        >One URL per line. Separate tiers with an empty line.<textarea
          class="input mono"
          rows="9"
          bind:value={trackerText}></textarea></label
      ><button class="button primary" disabled={saving}>Save trackers</button>
    </form></Modal
  >{/if}
{#if labelEditing}<Modal title="Edit labels" close={() => (labelEditing = false)}
    ><form
      class="modal-form"
      onsubmit={async (e) => {
        e.preventDefault();
        const labels = [
          ...new Set(
            labelsText
              .split(',')
              .map((x) => x.trim())
              .filter((x) => x && x !== label && x !== trackerVpnLabel),
          ),
        ];
        if (label && t.labels.includes(label)) labels.push(label);
        if (t.labels.includes(trackerVpnLabel)) labels.push(trackerVpnLabel);
        await client.safeAction('torrent-set', [t.id], { labels });
        labelEditing = false;
      }}
    >
      <label>Labels, separated by commas<input class="input" bind:value={labelsText} /></label
      ><button class="button primary">Save labels</button>
    </form></Modal
  >{/if}
