<script lang="ts">
  import { motion } from '../lib/motion';
  import { onMount, type Snippet } from 'svelte';
  import { cubicOut } from 'svelte/easing';
  import { X } from '@lucide/svelte';
  import { isolateDialog, nativeInert } from '../lib/browser';
  let {
    title,
    titleIcon,
    titleDetails,
    headerActions,
    close,
    children,
    wide = false,
    player,
  }: {
    title: string;
    titleIcon?: Snippet;
    titleDetails?: Snippet;
    headerActions?: Snippet;
    close: () => void;
    children: Snippet;
    wide?: boolean;
    player?: 'playback' | 'chooser';
  } = $props();
  let dialog: HTMLDialogElement;
  let prior: HTMLElement | null = null;
  let releaseBackground = () => {};
  const titleId = $props.id();
  onMount(() => {
    prior = document.activeElement as HTMLElement;
    dialog.showModal();
    releaseBackground = isolateDialog(dialog);
    return () => releaseBackground();
  });
  function enter(node: HTMLDialogElement) {
    delete node.dataset.closing;
    return animation();
  }
  function exit(node: HTMLDialogElement) {
    node.dataset.closing = 'true';
    return animation();
  }
  function animation() {
    // Keep Safari 15.4 off its buggy native-dialog Web Animations path.
    // Modern browsers retain the existing motion and native background handling.
    if (!nativeInert) return { duration: 0 };
    return {
      duration: motion(160),
      easing: cubicOut,
      css: (t: number) => `opacity:${t};transform:translateY(${(1 - t) * 8}px);`,
    };
  }
  function finished() {
    releaseBackground();
    dialog.close();
    if (prior?.isConnected) prior.focus({ preventScroll: true });
  }
</script>

<dialog
  bind:this={dialog!}
  class:wide
  class:player-dialog={!!player}
  class:player-chooser-dialog={player === 'chooser'}
  aria-labelledby={titleId}
  in:enter|global
  out:exit|global
  onoutroend={finished}
  oncancel={(e) => {
    e.preventDefault();
    close();
  }}
  onclick={(e) => {
    if (e.target === dialog) close();
  }}
  onkeydown={(e) => {
    if (e.key === 'Escape') e.stopPropagation();
  }}
>
  <div class="modal-body">
    <header class="modal-header">
      {#if player}
        <div class="watch-heading">
          {@render titleIcon?.()}
          <div class="watch-title">
            <h2 id={titleId} {title}>{title}</h2>
            {@render titleDetails?.()}
          </div>
        </div>
        {@render headerActions?.()}
      {:else}
        <h2 id={titleId}>{title}</h2>
      {/if}
      <button class="icon-button" aria-label="Close dialog" onclick={close}><X size={18} /></button>
    </header>
    {@render children()}
  </div>
</dialog>
