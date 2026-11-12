<script lang="ts">
  import {
    Cable,
    Download,
    Gauge,
    Network,
    Palette,
    LoaderCircle,
    CheckCircle2,
    CircleAlert,
    RefreshCw,
    ChevronRight,
  } from '@lucide/svelte';
  import { client } from '../lib/client.svelte';
  let {
    section = $bindable('Connection'),
    draft = $bindable<Record<string, any>>({}),
    endpoint = $bindable(''),
    username = $bindable(''),
    password = $bindable(''),
    theme = $bindable('system'),
    saving = false,
    mobile = false,
    showDetail = $bindable(false),
    connect,
    save,
  }: {
    section?: string;
    draft?: Record<string, any>;
    endpoint?: string;
    username?: string;
    password?: string;
    theme?: string;
    saving?: boolean;
    mobile?: boolean;
    showDetail?: boolean;
    connect: () => void;
    save: () => void;
  } = $props();
  const formId = $props.id();
  let portState = $state<'idle' | 'testing' | 'open' | 'closed' | 'error'>('idle');
  let portMessage = $state('');
  let testedPort = 0;
  let blocklistBusy = $state(false);
  let blocklistMessage = $state('');
  const unsavedPort = $derived(Number(draft['peer-port']) !== Number(client.session['peer-port']));
  const sections = [
    { name: 'Connection', icon: Cable },
    { name: 'Limits', label: 'Bandwidth', icon: Gauge },
    { name: 'Transfers', label: 'Downloads', icon: Download },
    { name: 'Network', icon: Network },
    { name: 'Appearance', icon: Palette },
  ];
  type Field = {
    key: string;
    title: string;
    description?: string;
    kind?: 'toggle' | 'number' | 'text' | 'select';
    unit?: string;
    enable?: string;
    choices?: [string | number, string][];
  };
  type Group = { title: string; description?: string; fields: Field[] };
  const groups: Record<string, Group[]> = {
    Limits: [
      {
        title: 'Transfer speed',
        description: 'Use available bandwidth, or set a ceiling.',
        fields: [
          {
            key: 'speed-limit-down-enabled',
            title: 'Download limit',
            kind: 'toggle',
            description: 'Cap total download speed.',
          },
          {
            key: 'speed-limit-down',
            title: 'Maximum download',
            kind: 'number',
            unit: 'KB/s',
            enable: 'speed-limit-down-enabled',
          },
          {
            key: 'speed-limit-up-enabled',
            title: 'Upload limit',
            kind: 'toggle',
            description: 'Cap total upload speed.',
          },
          {
            key: 'speed-limit-up',
            title: 'Maximum upload',
            kind: 'number',
            unit: 'KB/s',
            enable: 'speed-limit-up-enabled',
          },
        ],
      },
      {
        title: 'Queue',
        fields: [
          { key: 'download-queue-enabled', title: 'Limit active downloads', kind: 'toggle' },
          {
            key: 'download-queue-size',
            title: 'Downloads at once',
            kind: 'number',
            enable: 'download-queue-enabled',
          },
          { key: 'seed-queue-enabled', title: 'Limit active seeds', kind: 'toggle' },
          {
            key: 'seed-queue-size',
            title: 'Seeds at once',
            kind: 'number',
            enable: 'seed-queue-enabled',
          },
        ],
      },
      {
        title: 'Seeding',
        fields: [
          { key: 'seedRatioLimited', title: 'Stop at a share ratio', kind: 'toggle' },
          {
            key: 'seedRatioLimit',
            title: 'Target ratio',
            kind: 'number',
            unit: '×',
            enable: 'seedRatioLimited',
          },
          { key: 'idle-seeding-limit-enabled', title: 'Stop inactive seeds', kind: 'toggle' },
          {
            key: 'idle-seeding-limit',
            title: 'Idle time',
            kind: 'number',
            unit: 'min',
            enable: 'idle-seeding-limit-enabled',
          },
        ],
      },
      {
        title: 'Slow mode',
        fields: [
          {
            key: 'alt-speed-enabled',
            title: 'Enable slow mode',
            description: 'Use a lower set of speed limits.',
            kind: 'toggle',
          },
          {
            key: 'alt-speed-down',
            title: 'Download',
            unit: 'KB/s',
            kind: 'number',
            enable: 'alt-speed-enabled',
          },
          {
            key: 'alt-speed-up',
            title: 'Upload',
            unit: 'KB/s',
            kind: 'number',
            enable: 'alt-speed-enabled',
          },
        ],
      },
    ],
    Transfers: [
      {
        title: 'Storage',
        fields: [
          { key: 'download-dir', title: 'Download folder', kind: 'text' },
          {
            key: 'incomplete-dir-enabled',
            title: 'Use a temporary folder',
            description: 'Keep unfinished downloads separate.',
            kind: 'toggle',
          },
          {
            key: 'incomplete-dir',
            title: 'Temporary folder',
            kind: 'text',
            enable: 'incomplete-dir-enabled',
          },
        ],
      },
      {
        title: 'New downloads',
        fields: [
          {
            key: 'start-added-torrents',
            title: 'Start automatically',
            description: 'Begin a torrent as soon as it is added.',
            kind: 'toggle',
          },
          {
            key: 'rename-partial-files',
            title: 'Mark unfinished files',
            description: 'Append .part until the file is complete.',
            kind: 'toggle',
          },
        ],
      },
    ],
    Network: [
      {
        title: 'Connections',
        fields: [
          { key: 'peer-port', title: 'Incoming port', kind: 'number' },
          {
            key: 'port-forwarding-enabled',
            title: 'Automatic port forwarding',
            description: 'Ask your router to open the incoming port.',
            kind: 'toggle',
          },
          {
            key: 'encryption',
            title: 'Encryption',
            kind: 'select',
            choices: [
              ['tolerated', 'Allow unencrypted'],
              ['preferred', 'Prefer encrypted'],
              ['required', 'Require encrypted'],
            ],
          },
        ],
      },
      {
        title: 'Peer discovery',
        description: 'Ways to find other people sharing a torrent.',
        fields: [
          {
            key: 'dht-enabled',
            title: 'Distributed discovery',
            description: 'Find peers through the DHT network.',
            kind: 'toggle',
          },
          {
            key: 'pex-enabled',
            title: 'Peer exchange',
            description: 'Learn about peers from existing connections.',
            kind: 'toggle',
          },
          {
            key: 'lpd-enabled',
            title: 'Local discovery',
            description: 'Find peers on your local network.',
            kind: 'toggle',
          },
        ],
      },
      {
        title: 'Advanced connections',
        fields: [
          { key: 'peer-limit-global', title: 'Total peer limit', kind: 'number' },
          { key: 'peer-limit-per-torrent', title: 'Peers per torrent', kind: 'number' },
          {
            key: 'utp-enabled',
            title: 'µTP transport',
            description: 'Allow congestion-aware UDP connections.',
            kind: 'toggle',
          },
        ],
      },
      {
        title: 'Blocklist',
        fields: [
          { key: 'blocklist-enabled', title: 'Block listed peers', kind: 'toggle' },
          {
            key: 'blocklist-url',
            title: 'Blocklist URL',
            kind: 'text',
            enable: 'blocklist-enabled',
          },
        ],
      },
    ],
  };
  async function portTest() {
    if (portState === 'testing' || unsavedPort) return;
    testedPort = Number(client.session['peer-port']);
    portState = 'testing';
    portMessage = `Checking port ${testedPort}…`;
    try {
      const r = await client.rpc.call('port-test');
      if (typeof r['port-is-open'] !== 'boolean')
        throw new Error('The server did not return a port test result.');
      portState = r['port-is-open'] ? 'open' : 'closed';
      portMessage = `Port ${testedPort} ${r['port-is-open'] ? 'is reachable' : 'is closed'}`;
    } catch (e) {
      portState = 'error';
      portMessage = e instanceof Error ? e.message : String(e);
    }
  }
  async function updateBlocklist() {
    if (blocklistBusy) return;
    blocklistBusy = true;
    blocklistMessage = 'Updating…';
    try {
      const r = await client.rpc.call('blocklist-update');
      blocklistMessage = `Updated · ${Number(r['blocklist-size']).toLocaleString()} entries`;
    } catch (e) {
      blocklistMessage = e instanceof Error ? e.message : String(e);
    } finally {
      blocklistBusy = false;
    }
  }
</script>

<div class="settings-layout" class:settings-mobile={mobile}>
  {#if mobile && !showDetail}
    <nav class="settings-index" aria-label="Settings sections">
      {#each sections as item}<button
          type="button"
          onclick={() => {
            section = item.name;
            showDetail = true;
          }}
          ><item.icon size={21} /><span>{item.label || item.name}</span><ChevronRight
            size={17}
          /></button
        >{/each}
    </nav>
  {:else}
    <nav class="settings-tabs" aria-label="Settings sections">
      {#each sections as item}<button
          type="button"
          class:active={section === item.name}
          aria-current={section === item.name ? 'page' : undefined}
          onclick={() => (section = item.name)}
          ><item.icon size={18} /><span>{item.label || item.name}</span></button
        >{/each}
    </nav>
    <div class="settings-main">
      <div class="settings-page-title">
        <h2>{sections.find((x) => x.name === section)?.label || section}</h2>
      </div>
      {#if section === 'Connection'}
        <form
          id={formId}
          onsubmit={(e) => {
            e.preventDefault();
            connect();
          }}
        >
          <section class="settings-group">
            <h3>Transmission server</h3>
            <div class="settings-card">
              <label class="setting-row stack"
                ><span class="setting-copy"
                  ><b>Server address</b><small>The RPC address of your Transmission daemon.</small
                  ></span
                ><textarea
                  class="input endpoint-input"
                  rows="2"
                  aria-label="Transmission RPC URL"
                  required
                  bind:value={endpoint}
                  spellcheck="false"
                  autocapitalize="none"
                  inputmode="url"></textarea></label
              >
              <details class="setting-disclosure">
                <summary>Authentication <ChevronRight size={16} /></summary>
                <div class="setting-disclosure-body credential-fields">
                  <label
                    >Username<input
                      class="input"
                      autocomplete="username"
                      bind:value={username}
                    /></label
                  ><label
                    >Password<input
                      class="input"
                      type="password"
                      autocomplete="current-password"
                      bind:value={password}
                    /></label
                  >
                  <p class="hint">Credentials are kept for this session.</p>
                </div>
              </details>
            </div>
          </section>
        </form>
      {:else if section === 'Appearance'}
        <section class="settings-group">
          <h3>Theme</h3>
          <div class="settings-card">
            <label class="setting-row"
              ><span class="setting-copy"
                ><b>Color theme</b><small>Choose how Drift looks on this device.</small></span
              ><select aria-label="Color theme" bind:value={theme}
                ><option value="system">System</option><option value="light">Light</option><option
                  value="dark">Dark</option
                ></select
              ></label
            >
          </div>
        </section>
        {#if !mobile}<details class="settings-group keyboard-details">
            <summary>Keyboard shortcuts <ChevronRight size={16} /></summary>
            <dl class="info-list">
              <div>
                <dt>Search</dt>
                <dd>⌘ / Ctrl F</dd>
              </div>
              <div>
                <dt>Add torrent</dt>
                <dd>⌘ / Ctrl O</dd>
              </div>
              <div>
                <dt>Select all</dt>
                <dd>⌘ / Ctrl A</dd>
              </div>
              <div>
                <dt>Close details / clear selection</dt>
                <dd>Escape</dd>
              </div>
            </dl>
          </details>{/if}
      {:else}
        <form
          id={formId}
          onsubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          {#if section === 'Limits' && client.fullSpeedAvailable}<p class="settings-notice">
              <Gauge size={18} />Automatic bandwidth control is active. Full speed can override it
              for a download.
            </p>{/if}
          {#each groups[section] || [] as group}<section class="settings-group">
              <h3>{group.title}</h3>
              {#if group.description}<p>{group.description}</p>{/if}
              <div class="settings-card">
                {#each group.fields as field}{#if !field.enable || draft[field.enable]}
                    <label class="setting-row" class:stack={field.kind === 'text'}>
                      <span class="setting-copy"
                        ><b>{field.title}</b>{#if field.description}<small
                            >{field.description}</small
                          >{/if}</span
                      >
                      {#if field.kind === 'toggle'}<input
                          type="checkbox"
                          role="switch"
                          aria-label={field.title}
                          bind:checked={draft[field.key]}
                        />
                      {:else if field.kind === 'select'}<select
                          aria-label={field.title}
                          bind:value={draft[field.key]}
                          >{#each field.choices || [] as [value, label]}<option {value}
                              >{label}</option
                            >{/each}</select
                        >
                      {:else if field.kind === 'number'}<span class="number-unit"
                          ><input
                            aria-label={field.title}
                            type="number"
                            min={field.key === 'peer-port' || field.key.includes('peer-limit')
                              ? 1
                              : 0}
                            max={field.key === 'peer-port' ? 65535 : undefined}
                            step={field.key === 'seedRatioLimit' ? 0.1 : 1}
                            bind:value={draft[field.key]}
                          />{#if field.unit}<span>{field.unit}</span>{/if}</span
                        >
                      {:else}<input
                          class="input"
                          aria-label={field.title}
                          bind:value={draft[field.key]}
                          spellcheck="false"
                        />{/if}
                    </label>
                  {/if}{/each}
                {#if group.title === 'Connections'}<div class="setting-row port-test-row">
                    <span class="setting-copy"
                      ><b>Port reachability</b><small
                        class="inline-result"
                        role="status"
                        title={portMessage}
                        class:success={portState === 'open'}
                        class:warning={unsavedPort ||
                          portState === 'closed' ||
                          portState === 'error'}
                        >{unsavedPort
                          ? 'Save before testing.'
                          : portState === 'idle'
                            ? 'Test incoming connections.'
                            : portState === 'error'
                              ? 'Test failed. Try again.'
                              : portMessage}</small
                      ></span
                    ><button
                      type="button"
                      class="button secondary"
                      aria-busy={portState === 'testing'}
                      disabled={portState === 'testing' || !client.online || unsavedPort}
                      onclick={portTest}
                      >{#if portState === 'testing'}<LoaderCircle
                          size={15}
                          class="slow-spin"
                        />Testing…{:else}{portState === 'idle'
                          ? 'Test port'
                          : 'Test again'}{/if}</button
                    >
                  </div>{/if}
                {#if group.title === 'Blocklist' && draft['blocklist-enabled']}<div
                    class="setting-row blocklist-update-row"
                  >
                    <span class="setting-copy"><b>Refresh blocklist</b></span><button
                      type="button"
                      class="button secondary"
                      disabled={blocklistBusy || !client.online}
                      aria-busy={blocklistBusy}
                      onclick={updateBlocklist}
                      ><RefreshCw
                        size={15}
                        class={blocklistBusy ? 'slow-spin' : ''}
                      />{blocklistBusy ? 'Updating…' : 'Update'}</button
                    >
                    {#if blocklistMessage}<p class="inline-result" role="status">
                        {blocklistMessage}
                      </p>{/if}
                  </div>{/if}
              </div>
            </section>{/each}
        </form>
      {/if}
    </div>
    {#if mobile && section !== 'Appearance'}<button
        class="settings-submit"
        hidden
        type="submit"
        form={formId}>Save</button
      >{/if}
    {#if !mobile && section !== 'Appearance'}<footer class="settings-commit">
        {#if section === 'Connection'}<span class="connection-badge"
            ><i class="status-dot" class:success={client.online}></i>Transmission {String(
              client.session.version || '—',
            ).split(' ')[0]}</span
          >{:else}<span class="hint">Changes apply to the server.</span>{/if}
        <button
          class="button primary"
          type="submit"
          form={formId}
          disabled={saving || (section !== 'Connection' && !client.online)}
          >{saving
            ? section === 'Connection'
              ? 'Connecting…'
              : 'Saving…'
            : section === 'Connection'
              ? 'Connect'
              : 'Save changes'}</button
        >
      </footer>{/if}
  {/if}
</div>
