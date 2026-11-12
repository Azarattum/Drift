<script lang="ts">
  import { ArrowDown, ArrowUp, ShieldCheck, X, Network } from '@lucide/svelte';
  import type { Peer } from '../lib/types';
  import { percent, speed } from '../lib/format';
  let { peers }: { peers: Peer[] } = $props();
  let chosen = $state<string | null>(null);
  let visible = $derived(peers.slice(0, 48));
  let selected = $derived(peers.find((p) => p.address === chosen));
  $effect(() => {
    if (chosen && !peers.some((p) => p.address === chosen)) chosen = null;
  });
  function point(i: number) {
    const angle = (i / Math.max(1, visible.length)) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? 105 : 85;
    return { x: 160 + Math.cos(angle) * r, y: 132 + Math.sin(angle) * r };
  }
</script>

<div class="peer-map">
  {#if !peers.length}<div class="panel-empty">
      <Network size={26} /><b>No peer connections yet</b><span
        >Connections appear here as peers join.</span
      >
    </div>{:else}<svg
      viewBox="0 0 320 264"
      role="img"
      aria-label={`${peers.length} connected peers. Blue connections are downloading, teal are uploading.`}
    >
      <circle cx="160" cy="132" r="105" class="orbit" /><circle
        cx="160"
        cy="132"
        r="63"
        class="orbit"
      />
      {#each visible as p, i (p.address + ':' + p.port)}
        {@const pos = point(i)}
        <line
          x1="160"
          y1="132"
          x2={pos.x}
          y2={pos.y}
          stroke={p.rateToClient ? 'var(--blue)' : p.rateToPeer ? 'var(--teal)' : 'var(--border)'}
          stroke-width={p.rateToClient || p.rateToPeer ? 1.3 : 0.6}
          opacity={chosen && chosen !== p.address?.toString()?.trim() ? 0.2 : 0.7}
        />
        {#if p.rateToClient || p.rateToPeer}<circle
            r="2"
            fill={p.rateToClient ? 'var(--blue)' : 'var(--teal)'}
            class="peer-packet"
            ><animateMotion
              dur={`${Math.max(1, 4 - (p.rateToClient + p.rateToPeer) / 500000)}s`}
              repeatCount="indefinite"
              path={`M ${p.rateToClient ? pos.x : 160} ${p.rateToClient ? pos.y : 132} L ${p.rateToClient ? 160 : pos.x} ${p.rateToClient ? 132 : pos.y}`}
            /></circle
          >{/if}
        <g
          role="button"
          tabindex="0"
          aria-label={`Inspect peer ${p.address}`}
          onkeydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') e.preventDefault();
            if (e.key === 'Enter' || e.key === ' ')
              chosen = chosen === p.address ? null : p.address;
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              chosen = null;
            }
          }}
          onclick={() => (chosen = chosen === p.address ? null : p.address)}
        >
          <title>{p.address} · {p.clientName} · {percent(p.progress)}</title><circle
            cx={pos.x}
            cy={pos.y}
            r="26"
            fill="transparent"
          /><circle
            cx={pos.x}
            cy={pos.y}
            r={p.address === chosen ? 6 : 4}
            fill={p.rateToClient ? 'var(--blue)' : p.rateToPeer ? 'var(--teal)' : 'var(--muted)'}
            stroke="var(--surface)"
            stroke-width="2"
          />
        </g>
      {/each}
      <circle cx="160" cy="132" r="22" fill="var(--surface)" stroke="var(--border)" /><path
        d="M154 130v-5h12v5m-12 5v4h12v-4m-6-9v9m-3-3 3 3 3-3"
        stroke="var(--text)"
        fill="none"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>{/if}
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
      ><b>{selected.address}</b><span
        >{selected.clientName || 'Unknown client'} · {percent(selected.progress)} complete</span
      >
      <div>
        <span class="download"><ArrowDown size={12} />{speed(selected.rateToClient)}</span><span
          class="upload"><ArrowUp size={12} />{speed(selected.rateToPeer)}</span
        >{#if selected.isEncrypted}<ShieldCheck size={13} />{/if}
      </div>
    </div>{/if}
</div>
