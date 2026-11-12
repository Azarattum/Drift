<script lang="ts">
  import { ArrowDown, ArrowUp, Network } from '@lucide/svelte';
  import type { Peer } from '../lib/types';
  import { bytes, speed } from '../lib/format';
  import { peerKey as key, peerPlot } from '../lib/peer-plot';
  let {
    peers,
    chosen = $bindable<string | null>(null),
    compact = false,
  }: { peers: Peer[]; chosen?: string | null; compact?: boolean } = $props();
  let visible = $derived(peerPlot(peers, compact, chosen));
  const center = $derived(compact ? 96 : 132);
  $effect(() => {
    if (chosen && !peers.some((p) => key(p) === chosen)) chosen = null;
  });
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
        aria-label={`${peers.length} connected peers. Faster connections are closer to the center. Larger circles have downloaded more in the last minute. Blue is download, teal is upload.`}
      >
        <circle cx="160" cy={center} r={compact ? 70 : 105} class="orbit" /><circle
          cx="160"
          cy={center}
          r={compact ? 40 : 63}
          class="orbit"
        />
        {#each visible as pos (pos.key)}
          {@const p = pos.peer}
          <line
            x1="160"
            y1={center}
            x2={pos.x}
            y2={pos.y}
            stroke={p.rateToClient ? 'var(--blue)' : p.rateToPeer ? 'var(--teal)' : 'var(--border)'}
            stroke-width={p.rateToClient || p.rateToPeer ? 1.3 : 0.6}
            opacity={chosen && chosen !== key(p) ? 0.2 : 0.7}
          />
          {#each [{ rate: p.rateToClient, down: true }, { rate: p.rateToPeer, down: false }] as direction}{#if direction.rate > 0}<circle
                r="2"
                fill={direction.down ? 'var(--blue)' : 'var(--teal)'}
                class="peer-packet"
                ><animateMotion
                  dur={`${Math.max(1, 4 - direction.rate / 500000)}s`}
                  repeatCount="indefinite"
                  path={`M ${direction.down ? pos.x : 160} ${direction.down ? pos.y : center} L ${direction.down ? 160 : pos.x} ${direction.down ? center : pos.y}`}
                /></circle
              >{/if}{/each}
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
            <title
              >{p.address} · ↓ {speed(p.rateToClient)} · ↑ {speed(p.rateToPeer)} · {pos.hasVolume
                ? `${bytes(p.bytes_to_client!)} downloaded in the last minute`
                : 'Download volume unavailable'}</title
            ><circle
              class="peer-target"
              cx={pos.x}
              cy={pos.y}
              r={compact ? 26 : 18}
              fill="transparent"
            />{#if key(p) === chosen}<circle
                class="peer-selection-ring"
                cx={pos.x}
                cy={pos.y}
                r={pos.radius + 4}
                fill="none"
                stroke="var(--text)"
                stroke-width="1"
              />{/if}<circle
              class="peer-dot"
              cx={pos.x}
              cy={pos.y}
              r={pos.radius}
              fill={pos.hasVolume
                ? p.rateToClient
                  ? 'var(--blue)'
                  : p.rateToPeer
                    ? 'var(--teal)'
                    : 'var(--muted)'
                : 'var(--surface)'}
              stroke={pos.hasVolume ? 'var(--surface)' : 'var(--muted)'}
              stroke-width="2"
            />
          </g>
        {/each}
        <circle cx="160" cy={center} r="22" fill="var(--surface)" stroke="var(--border)" /><text
          x="160"
          y={center + 4}
          text-anchor="middle"
          class="peer-center-label">You</text
        >
      </svg>{/if}
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
