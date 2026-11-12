<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { client } from '../lib/client.svelte';
  import type { Torrent } from '../lib/types';
  import Modal from './Modal.svelte';

  let { torrent, close }: { torrent: Torrent; close: () => void } = $props();
  let input: HTMLInputElement;
  let root = $state('');
  let name = $state('');
  let folder = $state(false);
  let loading = $state(true);
  let saving = $state(false);
  let error = $state('');
  const hintId = $props.id();
  let invalid = $derived(
    !name.trim() || name === '.' || name === '..' || /[/\\]/.test(name) || name.includes('\0'),
  );

  onMount(() => {
    let active = true;
    void (async () => {
      try {
        const result = await client.rpc.call<{ torrents: Torrent[] }>('torrent-get', {
          ids: [torrent.id],
          fields: ['id', 'files'],
        });
        if (!active) return;
        const files = result.torrents[0]?.files || [];
        const path = files[0]?.name.split('/')[0];
        if (!path || files.some((f) => f.name !== path && !f.name.startsWith(`${path}/`)))
          throw new Error('The torrent’s top-level file or folder is unavailable.');
        root = path;
        name = path;
        folder = files.some((f) => f.name.includes('/'));
      } catch (e) {
        if (active) error = e instanceof Error ? e.message : 'Could not load the torrent name.';
      } finally {
        if (active) {
          loading = false;
          await tick();
          if (active && root) {
            input.focus();
            input.select();
          }
        }
      }
    })();
    return () => {
      active = false;
    };
  });
</script>

<Modal title="Rename torrent" {close}>
  <form
    class="modal-form"
    onsubmit={async (e) => {
      e.preventDefault();
      if (invalid || !root || name === root || saving || !client.online) return;
      saving = true;
      error = '';
      try {
        await client.action('torrent-rename-path', [torrent.id], { path: root, name });
        client.toast('Torrent renamed');
        close();
      } catch (e) {
        error = e instanceof Error ? e.message : 'Could not rename the torrent.';
      } finally {
        saving = false;
      }
    }}
  >
    <label
      >Name<input
        bind:this={input!}
        class="input"
        required
        bind:value={name}
        disabled={loading || !root || saving}
        placeholder={loading ? 'Loading…' : ''}
        aria-describedby={hintId}
      /></label
    >
    <p class="hint" id={hintId}>
      Also renames the {folder ? 'folder' : 'file'} on disk. Use a single name without slashes.
    </p>
    {#if error}<p class="hint danger" role="alert">{error}</p>{/if}
    <div class="modal-footer">
      <button type="button" class="button" onclick={close}>Cancel</button><button
        class="button primary"
        disabled={loading || saving || !root || invalid || name === root || !client.online}
        >{saving ? 'Renaming…' : 'Rename'}</button
      >
    </div>
  </form>
</Modal>
