<script lang="ts">
  import { ArrowUp, Minus, ArrowDown } from '@lucide/svelte';
  let {
    value,
    onchange,
    label = 'Priority',
    disabled = false,
  }: {
    value: number | undefined;
    onchange: (value: number) => void;
    label?: string;
    disabled?: boolean;
  } = $props();
</script>

<div class="priority-control" role="group" aria-label={label}>
  {#each [{ value: 1, label: 'High', icon: ArrowUp }, { value: 0, label: 'Normal', icon: Minus }, { value: -1, label: 'Low', icon: ArrowDown }] as item}
    <button
      type="button"
      aria-pressed={value === item.value}
      {disabled}
      onclick={() => onchange(item.value)}><item.icon size={13} />{item.label}</button
    >
  {/each}
</div>
