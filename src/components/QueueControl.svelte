<script lang="ts">
  import { ArrowUp, ArrowDown, ArrowUpToLine, ArrowDownToLine } from '@lucide/svelte';
  import type { Torrent } from '../lib/types';
  let { torrents, move }: { torrents: Torrent[]; move: (method: string) => void } = $props();
  let positions = $derived(torrents.map((t) => t.queuePosition + 1).sort((a, b) => a - b));
</script>

<div class="queue-control" role="group" aria-label="Download queue">
  <div class="queue-position">
    <span>Download queue</span><b
      >{positions.length === 1
        ? `#${positions[0]}`
        : `#${positions[0]}–#${positions[positions.length - 1]} (${positions.length})`}</b
    >
  </div>
  <div class="queue-moves">
    {#each [{ method: 'queue-move-top', label: 'First', title: 'Move to top', icon: ArrowUpToLine }, { method: 'queue-move-up', label: 'Up', title: 'Move up', icon: ArrowUp }, { method: 'queue-move-down', label: 'Down', title: 'Move down', icon: ArrowDown }, { method: 'queue-move-bottom', label: 'Last', title: 'Move to bottom', icon: ArrowDownToLine }] as action}
      <button
        type="button"
        aria-label={action.title}
        title={action.title}
        onclick={() => move(action.method)}><action.icon size={13} />{action.label}</button
      >
    {/each}
  </div>
</div>
