<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import { fly } from 'svelte/transition';
  import { X } from '@lucide/svelte';
  let {
    title,
    close,
    children,
    wide = false,
  }: { title: string; close: () => void; children: Snippet; wide?: boolean } = $props();
  let dialog: HTMLDialogElement;
  onMount(() => {
    const prior = document.activeElement as HTMLElement;
    dialog.showModal();
    return () => prior?.focus();
  });
</script>

<dialog
  bind:this={dialog!}
  class:wide
  oncancel={(e) => {
    e.preventDefault();
    close();
  }}
  onclick={(e) => {
    if (e.target === dialog) close();
  }}
  onkeydown={(e) => {
    if (e.key === 'Escape') close();
  }}
>
  <div class="modal-body" transition:fly={{ y: 8, duration: 160 }}>
    <header class="modal-header">
      <h2>{title}</h2>
      <button class="icon-button" aria-label="Close dialog" onclick={close}><X size={17} /></button>
    </header>
    {@render children()}
  </div>
</dialog>
