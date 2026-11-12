<script lang="ts">
  import { motion } from '../lib/motion';
  import {
    ChevronDown,
    ChevronRight,
    Copy,
    ExternalLink,
    File,
    Folder,
    Pause,
    Play,
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
  import { fileTree, flatten, type FileNode } from '../lib/files';
  import type { Torrent } from '../lib/types';
  import PeerGraph from './PeerGraph.svelte';
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
  let tab = $state('Overview');
  let collapsed = $state(new Set<string>());
  let fileQuery = $state('');
  let rename = $state<FileNode | null>(null);
  let renameValue = $state('');
  let trackerText = $state<string | null>(null);
  let trackerEditing = $state(false);
  let expandedTrackers = $state(new Set<number>());
  let saving = $state(false);
  let options = $state<Record<string, any>>({});
  let optionsId = $state(-1);
  let labelsText = $state('');
  let labelEditing = $state(false);
  const tabs = ['Overview', 'Files', 'Peers', 'Trackers', 'Options'];
  let s = $derived(stage(t));
  let tree = $derived(fileTree(t.files || []));
  let nodes = $derived(
    flatten(tree, fileQuery ? new Set() : collapsed).filter((n) =>
      n.path.toLowerCase().includes(fileQuery.toLowerCase()),
    ),
  );
  let label = $derived(client.capabilities?.fullSpeed.label || 'router:full-speed');
  $effect(() => {
    if (optionsId !== t.id) {
      options = {
        downloadLimit: t.downloadLimit || 0,
        downloadLimited: t.downloadLimited || false,
        uploadLimit: t.uploadLimit || 0,
        uploadLimited: t.uploadLimited || false,
        honorsSessionLimits: t.honorsSessionLimits ?? true,
        bandwidthPriority: t.bandwidthPriority || 0,
        'peer-limit': t['peer-limit'] || 50,
        seedRatioMode: t.seedRatioMode || 0,
        seedRatioLimit: t.seedRatioLimit || 2,
        seedIdleMode: t.seedIdleMode || 0,
        seedIdleLimit: t.seedIdleLimit || 30,
      };
      optionsId = t.id;
      trackerEditing = false;
      labelEditing = false;
      collapsed = new Set();
    }
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
  class="inspector"
  class:mobile
  aria-label="Torrent inspector"
  in:panelIn|global
  out:panelOut|global
>
  <header class="inspector-header">
    <span class="eyebrow">INSPECTOR</span>
    <div class="flex items-center gap-1">
      <button
        class="icon-button"
        aria-label={t.status === 0 ? 'Resume selected torrent' : 'Pause selected torrent'}
        onclick={() => client.safeAction(t.status === 0 ? 'torrent-start' : 'torrent-stop', [t.id])}
        >{#if t.status === 0}<Play size={15} />{:else}<Pause size={15} />{/if}</button
      ><button class="icon-button" aria-label="Close inspector" onclick={close}
        ><X size={17} /></button
      >
    </div>
  </header>
  <div class="inspector-title">
    <div class="file-tile"><File size={23} /></div>
    <h2>{t.name}</h2>
    <span class="muted"
      >{t.metadataPercentComplete < 1
        ? 'File list not received yet'
        : `${bytes(t.sizeWhenDone)} · ${t.files?.length || t.fileCount || 'Loading'} ${t.files || t.fileCount ? ((t.files?.length || t.fileCount) === 1 ? 'file' : 'files') : 'details…'}`}</span
    >
  </div>
  <div class="inspector-tabs" role="tablist" aria-label="Torrent details">
    {#each tabs as name}<button
        role="tab"
        aria-selected={tab === name}
        class:active={tab === name}
        onclick={() => (tab = name)}
        >{name}{#if name === 'Peers' && t.peersConnected > 0}<small>{t.peersConnected}</small
          >{/if}</button
      >{/each}
  </div>
  <div class="inspector-scroll" role="tabpanel" aria-label={tab}>
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
        </div>
        <p>{t.errorString || s.detail}</p>
        {#if t.percentDone < 1}<div
            class="detail-progress"
            class:indeterminate={s.active && s.progress === undefined}
          >
            <span style={`width:${(s.progress || 0) * 100}%`}></span>
          </div>{/if}
      </section>
      <div class="torrent-primary-actions">
        <button
          class="button secondary"
          onclick={() =>
            client.safeAction(t.status === 0 ? 'torrent-start' : 'torrent-stop', [t.id])}
          >{#if t.status === 0}<Play size={17} />Resume{:else}<Pause size={17} />Pause{/if}</button
        >
        {#if client.fullSpeedAvailable}<button
            class="button full-speed-button"
            class:enabled={client.isFullSpeed(t)}
            disabled={t.percentDone === 1}
            aria-pressed={client.isFullSpeed(t)}
            onclick={() => client.fullSpeed(t)}
            ><Zap size={17} />{client.isFullSpeed(t)
              ? client.fullSpeedApplied(t)
                ? 'Full speed on'
                : 'Applying…'
              : 'Full speed'}</button
          >{/if}
      </div>
      {#if client.fullSpeedAvailable}<p class="action-caption">
          {t.percentDone === 1
            ? 'Full speed is available while downloading.'
            : client.isFullSpeed(t)
              ? 'Automatic bandwidth control is bypassed. Turn off Full speed to restore it.'
              : 'Full speed bypasses automatic bandwidth control for this download.'}
        </p>{/if}
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
          {#each (t.labels || []).filter((x) => x !== label) as tag}<button
              class="label-chip"
              onclick={() => {
                client.labelFilter = tag;
                close();
              }}><Tag size={14} />{tag}</button
            >{/each}
        </div>{/if}
      <details class="detail-disclosure">
        <summary>Torrent details <ChevronRight size={16} /></summary>
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
        <summary>Storage & labels <ChevronRight size={16} /></summary>
        <p class="break-path mono">{t.downloadDir}</p>
        <button
          class="button secondary"
          onclick={() => {
            labelsText = (t.labels || []).filter((x) => x !== label).join(', ');
            labelEditing = true;
          }}><Tag size={16} />Manage labels</button
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
          /><button class="text-button" onclick={() => (collapsed = new Set())}>Expand</button
          ><button
            class="text-button"
            onclick={() =>
              (collapsed = new Set(
                flatten(tree, new Set())
                  .filter((n) => n.children.length)
                  .map((n) => n.path),
              ))}>Collapse</button
          >
        </div>
        <p class="file-hint">Choose files to download.</p>
        <div class="file-tree" role="tree" aria-label="Torrent files">
          {#each nodes as n (n.path)}<div
              role="treeitem"
              tabindex="0"
              onkeydown={(e) => {
                if (e.key === 'F2' || e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
                  e.preventDefault();
                  e.stopPropagation();
                  rename = n;
                  renameValue = n.name;
                }
              }}
              oncontextmenu={(e) => {
                e.preventDefault();
                rename = n;
                renameValue = n.name;
              }}
              aria-selected={checked(n)}
              aria-expanded={n.children.length ? !collapsed.has(n.path) : undefined}
              aria-level={n.depth + 1}
              class="file-node"
              style={`padding-left:${n.depth * 14 + 3}px;--depth:${n.depth}`}
            >
              {#if n.children.length}<button
                  class="tiny-button"
                  aria-label={`Toggle ${n.name}`}
                  onclick={() => toggleFolder(n.path)}
                  >{#if collapsed.has(n.path)}<ChevronRight size={12} />{:else}<ChevronDown
                      size={12}
                    />{/if}</button
                >{:else}<span class="tree-spacer"></span>{/if}
              <input
                type="checkbox"
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
                  title={n.path}
                  onclick={() => {
                    if (n.children.length) toggleFolder(n.path);
                    else {
                      rename = n;
                      renameValue = n.name;
                    }
                  }}>{n.name}</button
                ><small class="file-meta"
                  >{bytes(n.length)} · {percent(n.length ? n.completed / n.length : 1)}</small
                >
              </div>
              <select
                class="file-priority"
                aria-label={`Priority for ${n.path}`}
                value={n.ids.every((i) => t.fileStats?.[i]?.priority === 1)
                  ? 1
                  : n.ids.every((i) => t.fileStats?.[i]?.priority === -1)
                    ? -1
                    : 0}
                onchange={(e) =>
                  client.safeAction('torrent-set', [t.id], {
                    [Number(e.currentTarget.value) === 1
                      ? 'priority-high'
                      : Number(e.currentTarget.value) === -1
                        ? 'priority-low'
                        : 'priority-normal']: n.ids,
                  })}
                ><option value={-1}>Low</option><option value={0}>Normal</option><option value={1}
                  >High</option
                ></select
              >
            </div>{/each}
        </div>{/if}
    {:else if tab === 'Peers'}
      <PeerGraph peers={t.peers || []} />
      <div class="section-heading">
        <h3>{t.peersConnected} connected peers</h3>
        <span class="muted">{t.peersSendingToUs} sending data</span>
      </div>
      <div class="table-scroll">
        <table class="peer-table">
          <thead
            ><tr><th>Peer / Client</th><th>Progress</th><th>Download</th><th>Upload</th></tr></thead
          ><tbody
            >{#each t.peers || [] as p (p.address + ':' + p.port)}<tr
                ><td
                  ><div class="peer-address">
                    {p.address}{#if p.isEncrypted}<ShieldCheck size={11} />{/if}
                  </div>
                  <small
                    >{p.clientName || 'Unknown'} · {p.isUTP ? 'µTP' : 'TCP'}{p.isIncoming
                      ? ' · Incoming'
                      : ''}</small
                  ></td
                ><td>{percent(p.progress)}</td><td class="download">{speed(p.rateToClient)}</td><td
                  class="upload">{speed(p.rateToPeer)}</td
                ></tr
              >{:else}<tr><td colspan="4" class="empty-cell">{s.detail}</td></tr>{/each}</tbody
          >
        </table>
      </div>
    {:else if tab === 'Trackers'}
      <div class="section-heading">
        <h3>Peer discovery</h3>
        <button
          class="icon-button"
          aria-label="Reannounce torrent"
          title="Ask trackers for peers"
          onclick={() => client.safeAction('torrent-reannounce', [t.id])}
          ><RefreshCw size={14} /></button
        ><button
          class="text-button"
          onclick={() => {
            trackerText = t.trackerList || t.trackerStats.map((x) => x.announce).join('\n');
            trackerEditing = true;
          }}>Edit trackers</button
        >
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
            <strong title={tracker.announce}>{tracker.host || tracker.announce}</strong>
            <ChevronDown
              size={15}
              class="muted"
              style={`transform:rotate(${expanded ? 180 : 0}deg)`}
            />
          </button>
          <div class="tracker-summary">
            <span class:danger={failed}
              >{tracker.announceState === 3
                ? 'Announcing…'
                : failed
                  ? tracker.lastAnnounceResult
                  : tracker.lastAnnounceTime === 0
                    ? 'Waiting to announce'
                    : `${tracker.seederCount >= 0 ? `${tracker.seederCount} seeds` : 'Seeds unknown'} · ${tracker.lastAnnouncePeerCount || 0} peers`}</span
            >
            {#if tracker.nextAnnounceTime > 0}<span class="next-announce"
                >{duration(tracker.nextAnnounceTime - Date.now() / 1000)}</span
              >{/if}
          </div>
          {#if expanded}<div class="tracker-extra">
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
      <form
        id={optionsFormId}
        class="options-form"
        onsubmit={async (e) => {
          e.preventDefault();
          saving = true;
          try {
            await client.action('torrent-set', [t.id], options);
            client.toast('Transfer options saved');
          } finally {
            saving = false;
          }
        }}
      >
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
                bind:checked={options.honorsSessionLimits}
              /></label
            >
            {#each [{ key: 'downloadLimited', value: 'downloadLimit', title: 'Download limit', aria: 'Download limit in KB/s' }, { key: 'uploadLimited', value: 'uploadLimit', title: 'Upload limit', aria: 'Upload limit in KB/s' }] as f}<label
                class="setting-row"
                ><span class="setting-copy"><b>{f.title}</b></span><input
                  role="switch"
                  type="checkbox"
                  bind:checked={options[f.key]}
                /></label
              >{#if options[f.key]}<label class="setting-row"
                  ><span>Maximum speed</span><span class="number-unit"
                    ><input
                      type="number"
                      min="0"
                      aria-label={f.aria}
                      bind:value={options[f.value]}
                    />KB/s</span
                  ></label
                >{/if}{/each}
            <label class="setting-row"
              ><span class="setting-copy"
                ><b>Bandwidth priority</b><small>Priority relative to other torrents.</small></span
              ><select bind:value={options.bandwidthPriority}
                ><option value={-1}>Low</option><option value={0}>Normal</option><option value={1}
                  >High</option
                ></select
              ></label
            >
          </div>
        </section>
        <section class="settings-group">
          <h3>Seeding</h3>
          <div class="settings-card">
            <label class="setting-row"
              ><span>Share ratio</span><select bind:value={options.seedRatioMode}
                ><option value={0}>Global setting</option><option value={1}>Custom limit</option
                ><option value={2}>Unlimited</option></select
              ></label
            >
            {#if options.seedRatioMode === 1}<label class="setting-row"
                ><span>Target ratio</span><input
                  type="number"
                  min="0"
                  step="0.1"
                  aria-label="Ratio limit"
                  bind:value={options.seedRatioLimit}
                /></label
              >{/if}
            <label class="setting-row"
              ><span>Inactive seeds</span><select bind:value={options.seedIdleMode}
                ><option value={0}>Global setting</option><option value={1}>Custom timeout</option
                ><option value={2}>Unlimited</option></select
              ></label
            >
            {#if options.seedIdleMode === 1}<label class="setting-row"
                ><span>Idle time</span><span class="number-unit"
                  ><input
                    type="number"
                    min="1"
                    aria-label="Idle minutes"
                    bind:value={options.seedIdleLimit}
                  />min</span
                ></label
              >{/if}
          </div>
        </section>
        <details class="detail-disclosure">
          <summary>Advanced <ChevronRight size={16} /></summary><label class="setting-row"
            ><span>Peer limit</span><input
              type="number"
              min="1"
              aria-label="Peer limit"
              bind:value={options['peer-limit']}
            /></label
          >
        </details>
      </form>
    {/if}
  </div>
  {#if tab === 'Options'}<footer class="inspector-commit">
      <button
        class="button primary"
        type="submit"
        form={optionsFormId}
        disabled={saving || !client.online}>{saving ? 'Saving…' : 'Save changes'}</button
      >
    </footer>{/if}
</aside>
{#if rename}<Modal title="Rename file" close={() => (rename = null)}
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
      <label>File name<input class="input" required bind:value={renameValue} /></label><button
        class="button primary">Rename</button
      >
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
              .filter((x) => x && x !== label),
          ),
        ];
        if (label && t.labels.includes(label)) labels.push(label);
        await client.safeAction('torrent-set', [t.id], { labels });
        labelEditing = false;
      }}
    >
      <label>Labels, separated by commas<input class="input" bind:value={labelsText} /></label
      ><button class="button primary">Save labels</button>
    </form></Modal
  >{/if}
