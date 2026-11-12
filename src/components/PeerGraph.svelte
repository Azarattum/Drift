<script lang="ts">
  import { ArrowDown, ArrowUp, X, Network } from '@lucide/svelte';
  import type { Peer } from '../lib/types';
  import { percent, speed } from '../lib/format';
  let {
    peers,
    chosen = $bindable<string | null>(null),
    compact = false,
  }: { peers: Peer[]; chosen?: string | null; compact?: boolean } = $props();
  const key = (p: Peer) => `${p.address}:${p.port}`;
  let visible = $derived.by(() => {
    const list = peers.slice(0, compact ? 8 : 48);
    const chosenPeer = peers.find((p) => key(p) === chosen);
    if (chosenPeer && !list.includes(chosenPeer)) list[list.length - 1] = chosenPeer;
    return list;
  });
  const center = $derived(compact ? 96 : 132);
  let selected = $derived(peers.find((p) => key(p) === chosen));
  $effect(() => {
    if (chosen && !peers.some((p) => key(p) === chosen)) chosen = null;
  });
  function point(i: number) {
    const angle = (i / Math.max(1, visible.length)) * Math.PI * 2 - Math.PI / 2;
    const r = compact ? (i % 2 === 0 ? 70 : 50) : i % 2 === 0 ? 105 : 85;
    return { x: 160 + Math.cos(angle) * r, y: center + Math.sin(angle) * r };
  }
</script>

<div class="peer-map" class:compact class:empty={!peers.length}>
  <div class="peer-visualization">
    {#if !peers.length}<div class="panel-empty">
        <Network size={26} /><b>No peer connections yet</b><span
          >Connections appear here as peers join.</span
        >
      </div>{:else}<svg
        viewBox={`0 0 320 ${compact ? 192 : 264}`}
        role="group"
        aria-label={`${peers.length} connected peers. Blue connections are downloading, teal are uploading.`}
      >
        <circle cx="160" cy={center} r={compact ? 70 : 105} class="orbit" /><circle
          cx="160"
          cy={center}
          r={compact ? 40 : 63}
          class="orbit"
        />
        {#each visible as p, i (p.address + ':' + p.port)}
          {@const pos = point(i)}
          <line
            x1="160"
            y1={center}
            x2={pos.x}
            y2={pos.y}
            stroke={p.rateToClient ? 'var(--blue)' : p.rateToPeer ? 'var(--teal)' : 'var(--border)'}
            stroke-width={p.rateToClient || p.rateToPeer ? 1.3 : 0.6}
            opacity={chosen && chosen !== key(p) ? 0.2 : 0.7}
          />
          {#if p.rateToClient || p.rateToPeer}<circle
              r="2"
              fill={p.rateToClient ? 'var(--blue)' : 'var(--teal)'}
              class="peer-packet"
              ><animateMotion
                dur={`${Math.max(1, 4 - (p.rateToClient + p.rateToPeer) / 500000)}s`}
                repeatCount="indefinite"
                path={`M ${p.rateToClient ? pos.x : 160} ${p.rateToClient ? pos.y : center} L ${p.rateToClient ? 160 : pos.x} ${p.rateToClient ? center : pos.y}`}
              /></circle
            >{/if}
          <g
            role="button"
            tabindex="0"
            aria-label={`Inspect peer ${p.address} port ${p.port}`}
            aria-pressed={chosen === key(p)}
            onkeydown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') e.preventDefault();
              if (e.key === 'Enter' || e.key === ' ') chosen = chosen === key(p) ? null : key(p);
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                chosen = null;
              }
            }}
            onclick={() => (chosen = chosen === key(p) ? null : key(p))}
          >
            <title>{p.address} · {p.clientName} · {percent(p.progress)}</title><circle
              class="peer-target"
              cx={pos.x}
              cy={pos.y}
              r="26"
              fill="transparent"
            /><circle
              cx={pos.x}
              cy={pos.y}
              r={key(p) === chosen ? 6 : 4}
              fill={p.rateToClient ? 'var(--blue)' : p.rateToPeer ? 'var(--teal)' : 'var(--muted)'}
              stroke="var(--surface)"
              stroke-width="2"
            />
          </g>
        {/each}
        <circle cx="160" cy={center} r="22" fill="var(--surface)" stroke="var(--border)" /><path
          transform={`translate(0 ${center - 132})`}
          d="M154 130v-5h12v5m-12 5v4h12v-4m-6-9v9m-3-3 3 3 3-3"
          stroke="var(--text)"
          fill="none"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>{/if}
  </div>
  <div class="peer-detail-slot">
    {#if selected}<div class="peer-card">
        <button
          class="icon-button peer-card-close"
          aria-label="Clear peer selection"
          onkeydown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              chosen = null;
            }
          }}
          onclick={() => (chosen = null)}><X size={16} /></button
        ><b title={selected.address}>{selected.address}</b><small class="peer-port"
          >Port {selected.port}</small
        ><span
          >{selected.clientName || 'Unknown client'} · {percent(selected.progress)} complete</span
        >
        <div>
          <span class="download"><ArrowDown size={12} />{speed(selected.rateToClient)}</span><span
            class="upload"><ArrowUp size={12} />{speed(selected.rateToPeer)}</span
          >
        </div>
      </div>{/if}{#if !selected}<p class="peer-selection-hint">Select a connection</p>{/if}
  </div>
  {#if peers.length}<div class="peer-legend">
      <span class="download"><ArrowDown size={13} />Download</span><span class="upload"
        ><ArrowUp size={13} />Upload</span
      ><span><i class="status-dot"></i>Idle</span>
    </div>{/if}
  {#if visible.length < peers.length}<p class="peer-map-count">
      {visible.length} of {peers.length} shown · {compact ? 'all peers in List' : 'all peers below'}
    </p>{/if}
</div>
