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
    for (const key of ['position', 'width', 'height', 'top', 'right', 'bottom'])
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
      right: '0',
      bottom: 'auto',
      zIndex: '30',
    });
    return fly(node, { x: mobile ? 36 : 16, duration: motion(180) });
  }
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
  let label = $derived(client.capabilities?.fullSpeed.label);
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
        : `${bytes(t.sizeWhenDone)} · ${t.files?.length || 0} file${t.files?.length === 1 ? '' : 's'}`}</span
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
      <section class="stage-card" class:warning={s.tone === 'amber' || s.tone === 'red'}>
        <div class="stage-title">
          <span class="status-dot" class:pulse={s.active}></span><b>{s.label}</b
          >{#if s.progress !== undefined}<span>{percent(s.progress)}</span>{/if}
        </div>
        <p>{t.errorString || s.detail}</p>
        <div class="detail-progress" class:indeterminate={s.active && s.progress === undefined}>
          <span style={`width:${(s.progress || 0) * 100}%`}></span>
        </div>
      </section>
      {#if client.fullSpeedAvailable && t.percentDone < 1}<button
          class="boost-card"
          class:active={client.isFullSpeed(t)}
          onclick={() => client.fullSpeed(t)}
          ><Zap size={18} /><span
            ><b
              >{client.isFullSpeed(t)
                ? client.fullSpeedApplied(t)
                  ? 'Full speed active'
                  : 'Requesting full speed…'
                : 'Full speed'}</b
            ><small
              >{client.isFullSpeed(t)
                ? 'Click to restore automatic limits'
                : 'Bypass automatic backoff for this download'}</small
            ></span
          ><span class="toggle" class:on={client.isFullSpeed(t)}></span></button
        >{/if}
      <div class="metric-grid">
        <div><span>Downloaded</span><b>{bytes(t.downloadedEver)}</b></div>
        <div><span>Uploaded</span><b>{bytes(t.uploadedEver)}</b></div>
        <div><span>Download</span><b class="download">{speed(t.rateDownload)}</b></div>
        <div><span>Upload</span><b class="upload">{speed(t.rateUpload)}</b></div>
        <div><span>Time remaining</span><b>{duration(t.eta)}</b></div>
        <div>
          <span>Share ratio</span><b>{t.uploadRatio < 0 ? '—' : t.uploadRatio.toFixed(2)}</b>
        </div>
      </div>
      <div class="section-heading">
        <h3>Connections</h3>
        <button class="text-button" onclick={() => (tab = 'Peers')}
          >View peers <ChevronRight size={12} /></button
        >
      </div>
      <div class="connection-summary">
        <span><i class="status-dot"></i>{t.peersConnected} connected</span><span
          >{t.peersSendingToUs} sending to you</span
        >
      </div>
      <div class="section-heading"><h3>Location</h3></div>
      <p class="mono break-path">{t.downloadDir}</p>
      <div class="section-heading">
        <h3>Labels</h3>
        <button
          class="text-button"
          onclick={() => {
            labelsText = (t.labels || []).filter((x) => x !== label).join(', ');
            labelEditing = true;
          }}>Edit</button
        >
      </div>
      <div class="labels">
        {#each (t.labels || []).filter((x) => x !== label) as item}<span>{item}</span>{:else}<span
            class="muted">No labels</span
          >{/each}
      </div>
      <div class="section-heading"><h3>Information</h3></div>
      <dl class="properties">
        <div>
          <dt>Added</dt>
          <dd>{date(t.addedDate)}</dd>
        </div>
        <div>
          <dt>Completed</dt>
          <dd>{date(t.doneDate)}</dd>
        </div>
        <div>
          <dt>Created by</dt>
          <dd>{t.creator || '—'}</dd>
        </div>
        <div>
          <dt>Pieces</dt>
          <dd>{t.pieceCount || 0} × {bytes(t.pieceSize)}</dd>
        </div>
        <div>
          <dt>Privacy</dt>
          <dd>{t.isPrivate ? 'Private torrent' : 'Public torrent'}</dd>
        </div>
      </dl>
      {#if t.comment}<p class="muted comment">{t.comment}</p>{/if}
      <div class="hash-line">
        <code>{t.hashString}</code><button
          class="icon-button"
          aria-label="Copy torrent hash"
          onclick={() => copy(t.hashString)}><Copy size={13} /></button
        >
      </div>
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
        <p class="hint">Choose files to download. Folder selections include all children.</p>
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
              {#if n.children.length}<Folder size={14} class="muted" />{:else}<File
                  size={13}
                  class="muted"
                />{/if}<button
                class="file-name"
                title={n.path}
                onclick={() => {
                  if (n.children.length) toggleFolder(n.path);
                  else {
                    rename = n;
                    renameValue = n.name;
                  }
                }}
                >{n.name}<small class="mobile-file-info"
                  >{bytes(n.length)} · {percent(n.length ? n.completed / n.length : 1)}</small
                ></button
              ><span class="file-size muted">{bytes(n.length)}</span><select
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
              ><span class="file-percent muted"
                >{percent(n.length ? n.completed / n.length : 1)}</span
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
          <thead><tr><th>Peer / Client</th><th>Progress</th><th>↓</th><th>↑</th></tr></thead><tbody
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
                ><td>{percent(p.progress)}</td><td class="download"
                  >{p.rateToClient ? speed(p.rateToClient) : '—'}</td
                ><td class="upload">{p.rateToPeer ? speed(p.rateToPeer) : '—'}</td></tr
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
        <h3>Bandwidth</h3>
        <label class="check-row"
          ><input type="checkbox" bind:checked={options.honorsSessionLimits} />Follow global speed
          limits</label
        ><label class="check-row"
          ><input type="checkbox" bind:checked={options.downloadLimited} />Limit download
          <span class="number-unit"
            ><input
              aria-label="Download limit in KB/s"
              type="number"
              min="0"
              bind:value={options.downloadLimit}
            /> KB/s</span
          ></label
        ><label class="check-row"
          ><input type="checkbox" bind:checked={options.uploadLimited} />Limit upload
          <span class="number-unit"
            ><input
              aria-label="Upload limit in KB/s"
              type="number"
              min="0"
              bind:value={options.uploadLimit}
            /> KB/s</span
          ></label
        >
        <label class="field-row"
          >Bandwidth priority<select bind:value={options.bandwidthPriority}
            ><option value={-1}>Low</option><option value={0}>Normal</option><option value={1}
              >High</option
            ></select
          ></label
        ><label class="field-row"
          >Peer limit<input
            type="number"
            min="1"
            max="5000"
            bind:value={options['peer-limit']}
          /></label
        >
        <h3>Seeding</h3>
        <label class="field-row"
          >Ratio limit<select bind:value={options.seedRatioMode}
            ><option value={0}>Use global setting</option><option value={1}>Stop at ratio</option
            ><option value={2}>Unlimited</option></select
          ></label
        >{#if Number(options.seedRatioMode) === 1}<label class="field-row"
            >Target ratio<input
              type="number"
              min="0"
              step=".1"
              bind:value={options.seedRatioLimit}
            /></label
          >{/if}<label class="field-row"
          >Idle seeding<select bind:value={options.seedIdleMode}
            ><option value={0}>Use global setting</option><option value={1}>Stop when idle</option
            ><option value={2}>Unlimited</option></select
          ></label
        >{#if Number(options.seedIdleMode) === 1}<label class="field-row"
            >Idle minutes<input type="number" min="1" bind:value={options.seedIdleLimit} /></label
          >{/if}
        {#if client.isFullSpeed(t)}<p class="hint">
            Full speed owns bandwidth and peer limits until you turn it off.
          </p>{/if}<button class="button primary" disabled={saving || client.isFullSpeed(t)}
          >{saving ? 'Saving…' : 'Save changes'}</button
        >
      </form>
    {/if}
  </div>
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
