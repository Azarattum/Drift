<script lang="ts">
  import { Trash2 } from '@lucide/svelte';
  import Modal from './Modal.svelte';
  import { client } from '../lib/client.svelte';
  import { discardFileData } from '../lib/file-discard';

  let {
    name,
    hash,
    index,
    close,
    deleted,
    closePlayback,
  }: {
    name: string;
    hash: string;
    index: number;
    close: () => void;
    deleted: () => void;
    closePlayback?: () => Promise<void>;
  } = $props();
  const endpoint = client.rpc.endpoint;
  let busy = $state(false);
  let error = $state('');

  async function confirm(event: SubmitEvent) {
    event.preventDefault();
    if (busy || client.rpc.endpoint !== endpoint) return;
    busy = true;
    error = '';
    try {
      await closePlayback?.();
      if (client.rpc.endpoint !== endpoint) throw new Error('Connection changed. Try again.');
      await discardFileData(endpoint, client.rpc.username, client.rpc.password, hash, index);
      deleted();
    } catch (reason) {
      error = reason instanceof Error ? reason.message : 'Could not delete the file data.';
    } finally {
      if (client.rpc.endpoint === endpoint) void client.poll(true);
      busy = false;
    }
  }
</script>

<Modal
  title="Delete downloaded data?"
  close={() => {
    if (!busy) close();
  }}
>
  <form class="modal-form" onsubmit={confirm}>
    <p class="remove-description">{name}</p>
    {#if error}<p class="danger" role="alert">{error}</p>{/if}
    <div class="modal-footer">
      <button type="button" class="button" disabled={busy} onclick={close}>Cancel</button>
      <button class="button destructive" disabled={busy}
        ><Trash2 size={14} />{busy ? 'Deleting…' : 'Delete data'}</button
      >
    </div>
  </form>
</Modal>
