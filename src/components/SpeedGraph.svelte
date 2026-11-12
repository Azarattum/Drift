<script lang="ts">
  import { ArrowDown, ArrowUp } from '@lucide/svelte';
  import { speed } from '../lib/format';
  import type { Sample } from '../lib/types';
  let { samples, compact = false }: { samples: Sample[]; compact?: boolean } = $props();
  let hover = $state<number | null>(null);
  let width = $state(800);
  const H = 130,
    TOP = 12,
    BOTTOM = 112;
  let max = $derived(Math.max(1024, ...samples.flatMap((s) => [s.down, s.up])) * 1.15);
  let current = $derived(samples[hover ?? samples.length - 1]);
  const x = (i: number) =>
    1 + ((samples[i].at - samples[0].at) / Math.max(1, samples.at(-1)!.at - samples[0].at)) * 798;
  const y = (n: number) => BOTTOM - (n / max) * (BOTTOM - TOP);
  function path(key: 'down' | 'up') {
    if (!samples.length) return '';
    let p = `M ${x(0)} ${y(samples[0][key])}`;
    for (let i = 1; i < samples.length; i++) {
      const mid = (x(i - 1) + x(i)) / 2;
      p += ` C ${mid} ${y(samples[i - 1][key])} ${mid} ${y(samples[i][key])} ${x(i)} ${y(samples[i][key])}`;
    }
    return p;
  }
  function scrub(e: PointerEvent) {
    const box = e.currentTarget as HTMLElement;
    hover = Math.max(
      0,
      Math.min(
        samples.length - 1,
        Math.round(
          ((e.clientX - box.getBoundingClientRect().left) / box.getBoundingClientRect().width) *
            (samples.length - 1),
        ),
      ),
    );
  }
</script>

<section class:compact class="speed-chart" aria-label="Transfer speed history">
  <div class="chart-heading">
    <span class="eyebrow">TRANSFER ACTIVITY</span>
    <div class="chart-legend">
      <span class="download"><ArrowDown size={13} /><b>{speed(current?.down)}</b></span><span
        class="upload"><ArrowUp size={13} /><b>{speed(current?.up)}</b></span
      ><span class="muted chart-time"
        >{hover !== null && current
          ? new Date(current.at).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            })
          : 'Live'}</span
      >
    </div>
  </div>
  <div
    class="chart-surface"
    bind:clientWidth={width}
    onpointermove={scrub}
    onpointerleave={() => (hover = null)}
    role="slider"
    aria-label="Inspect transfer speed history"
    aria-valuemin={0}
    aria-valuemax={Math.max(0, samples.length - 1)}
    aria-valuenow={Math.max(0, hover ?? samples.length - 1)}
    aria-valuetext={`Download ${speed(current?.down)}, upload ${speed(current?.up)}`}
    tabindex="0"
    onkeydown={(e) => {
      if (['ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
        hover = Math.max(
          0,
          Math.min(
            samples.length - 1,
            (hover ?? samples.length - 1) + (e.key === 'ArrowLeft' ? -1 : 1),
          ),
        );
      } else if (e.key === 'Escape') hover = null;
    }}
  >
    <svg viewBox={`0 0 800 ${H}`} preserveAspectRatio="none" aria-hidden="true">
      {#each [0, 0.5, 1] as ratio}<line
          x1="0"
          x2="800"
          y1={y(max * ratio)}
          y2={y(max * ratio)}
          class="chart-grid"
        />{/each}
      {#if samples.length > 1}
        <path
          d={`${path('down')} L 799 ${BOTTOM} L 1 ${BOTTOM} Z`}
          fill="var(--blue)"
          opacity=".055"
        />
        <path d={path('down')} class="chart-line" stroke="var(--blue)" />
        <path d={path('up')} class="chart-line" stroke="var(--teal)" />
      {/if}
      {#if hover !== null && current}<line
          x1={x(hover)}
          x2={x(hover)}
          y1="0"
          y2={BOTTOM}
          stroke="var(--muted)"
          stroke-dasharray="3 4"
        /><circle
          cx={x(hover)}
          cy={y(current.down)}
          r={(3 * 800) / width}
          fill="var(--blue)"
        /><circle cx={x(hover)} cy={y(current.up)} r={(3 * 800) / width} fill="var(--teal)" />{/if}
    </svg>
    <span class="chart-max">{speed(max / 1.15)}</span>
    {#if samples.length < 2}<span class="chart-empty">Waiting for live samples</span>{/if}
  </div>
  <div class="chart-axis">
    <span
      >{samples[0]
        ? new Date(samples[0].at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '—'}</span
    ><span
      >{samples.length > 1
        ? `${Math.round((samples.at(-1)!.at - samples[0].at) / 1000)}s of activity`
        : 'Updates every 2 seconds'}</span
    ><span>Now</span>
  </div>
</section>
