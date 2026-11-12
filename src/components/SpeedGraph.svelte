<script lang="ts">
  import { ArrowDown, ArrowUp, Activity, Clock3 } from '@lucide/svelte';
  import { LineChart } from 'layerchart/svg';
  import { scaleTime } from 'd3-scale';
  import { curveMonotoneX } from 'd3-shape';
  import { speed } from '../lib/format';
  import { motion } from '../lib/motion';
  import type { Sample } from '../lib/types';
  let {
    samples,
    expanded = false,
    serverHistory = false,
  }: {
    samples: Sample[];
    compact?: boolean;
    expanded?: boolean;
    serverHistory?: boolean;
  } = $props();
  let windowMinutes = $state(2);
  let width = $state(700);
  let keyboardIndex = $state<number | null>(null);
  const timeScale = scaleTime();
  const series = [
    { key: 'down', label: 'Download', color: 'var(--blue)' },
    { key: 'up', label: 'Upload', color: 'var(--teal)' },
  ];
  let last = $derived(samples.at(-1));
  let end = $derived(last?.at ?? Date.now());
  let peak = $derived(
    Math.max(
      1024,
      ...samples.filter((s) => s.at >= end - windowMinutes * 60000).flatMap((s) => [s.down, s.up]),
    ),
  );
  let unit = $derived(peak >= 1024 * 1024 ? 1024 * 1024 : peak >= 1024 ? 1024 : 1);
  let unitLabel = $derived(unit === 1024 * 1024 ? 'MB/s' : unit === 1024 ? 'KB/s' : 'B/s');
  let data = $derived.by(() => {
    const points: { at: Date; down: number; up: number; gap?: boolean }[] = [];
    let previous: Sample | undefined;
    for (const sample of samples.filter((s) => s.at >= end - windowMinutes * 60000)) {
      if (previous && sample.at - previous.at > 30000)
        points.push({ at: new Date(previous.at + 1), down: NaN, up: NaN, gap: true });
      points.push({ at: new Date(sample.at), down: sample.down / unit, up: sample.up / unit });
      previous = sample;
    }
    return points;
  });
  let domain = $derived([new Date(end - windowMinutes * 60000), new Date(end)]);

  let hasActivity = $derived(data.some((s) => s.down > 0 || s.up > 0));
  let current = $derived(samples[keyboardIndex ?? samples.length - 1]);
  const time = (value: Date | number) =>
    new Date(value).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
  const tick = time;
</script>

<section class="speed-chart" aria-label="Transfer speed history" bind:clientWidth={width}>
  <div class="chart-heading">
    <h2>Transfer activity</h2>
    <div class="chart-legend">
      <span class="download"><ArrowDown size={15} /><b>{speed(current?.down)}</b></span><span
        class="upload"><ArrowUp size={15} /><b>{speed(current?.up)}</b></span
      >
      <select aria-label="Chart time range" bind:value={windowMinutes}
        ><option value={2}>2 min</option><option value={15}>15 min</option><option value={60}
          >1 hour</option
        ></select
      >
    </div>
  </div>
  {#if hasActivity}<div
      class="chart-plot"
      role="slider"
      tabindex="0"
      aria-label="Inspect transfer speed history"
      aria-valuemin={0}
      aria-valuemax={Math.max(0, samples.length - 1)}
      aria-valuenow={Math.max(0, keyboardIndex ?? samples.length - 1)}
      aria-valuetext={`${current ? time(current.at) : 'No samples'}. Download ${speed(current?.down)}, upload ${speed(current?.up)}`}
      onkeydown={(e) => {
        if (['ArrowLeft', 'ArrowRight'].includes(e.key)) {
          e.preventDefault();
          e.stopPropagation();
          keyboardIndex = Math.max(
            0,
            Math.min(
              samples.length - 1,
              (keyboardIndex ?? samples.length - 1) + (e.key === 'ArrowLeft' ? -1 : 1),
            ),
          );
        } else if (e.key === 'Escape') keyboardIndex = null;
      }}
      onblur={() => (keyboardIndex = null)}
    >
      <LineChart
        {data}
        x="at"
        xScale={timeScale}
        xDomain={domain}
        {series}
        seriesLayout="overlap"
        yDomain={[0, Math.max(1, Math.ceil(peak / unit))]}
        yNice={true}
        height={expanded ? 270 : width < 500 ? 160 : 190}
        padding={{ top: 14, right: 12, bottom: 28, left: width < 500 ? 66 : 76 }}
        motion={motion(160) && data.length < 500 ? { type: 'tween', duration: 160 } : 'none'}
        props={{
          spline: {
            curve: curveMonotoneX,
            strokeWidth: 2,
            defined: (d: { gap?: boolean }) => !d.gap,
          },
          xAxis: {
            ticks: width < 500 ? 3 : 5,
            format: tick,
            tickOcclusion: { padding: width < 500 ? 24 : 12, priority: 'start-end' },
            rule: false,
            tickMarks: false,
          },
          yAxis: {
            ticks: 3,
            format: (v: number) =>
              `${v.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${unitLabel}`,
            rule: false,
            tickMarks: false,
          },
          grid: { stroke: 'var(--border)' },
          tooltip: {
            header: { format: time },
            item: { format: (v: number) => (Number.isFinite(v) ? speed(v * unit) : 'No sample') },
            hideTotal: true,
            root: { motion: 'none', fadeDuration: motion(100) },
          },
        }}
      />
      {#if samples.length < 2}<div class="chart-collecting">Collecting live history</div>{/if}
    </div>{:else}<div class="idle-history">
      <Activity size={20} /><span
        >{samples.length < 2
          ? 'Collecting activity…'
          : 'No recorded activity in this period.'}</span
      >
    </div>{/if}
  <div class="history-status">
    <Clock3 size={13} /><span
      >{serverHistory ? 'Recording on the server' : 'History from this browser'}</span
    >
  </div>
</section>
