import { copyText } from './clipboard';
import { requestDeadline } from './deadline';
import { historySamples, mergeSamples } from './history';
import { preference, savePreference } from './preferences';
import { Transmission } from './rpc';
import { stage } from './stage';
import type { Capabilities, Filter, Sample, Torrent } from './types';

type OptionQueue = {
  values: Record<string, number | boolean | string>;
  at: number;
  running?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
};

const overviewFields = [
  'id',
  'hashString',
  'name',
  'status',
  'percentDone',
  'metadataPercentComplete',
  'recheckProgress',
  'rateDownload',
  'rateUpload',
  'totalSize',
  'sizeWhenDone',
  'leftUntilDone',
  'downloadedEver',
  'uploadedEver',
  'uploadRatio',
  'peersConnected',
  'peersSendingToUs',
  'webseedsSendingToUs',
  'peersGettingFromUs',
  'desiredAvailable',
  'addedDate',
  'startDate',
  'activityDate',
  'doneDate',
  'eta',
  'error',
  'errorString',
  'isStalled',
  'downloadDir',
  'labels',
  'queuePosition',
  'trackerStats',
  'fileCount',
];
const detailsFields = [
  'files',
  'fileStats',
  'peers',
  'magnetLink',
  'comment',
  'creator',
  'dateCreated',
  'pieceCount',
  'pieceSize',
  'downloadLimit',
  'downloadLimited',
  'uploadLimit',
  'uploadLimited',
  'honorsSessionLimits',
  'bandwidthPriority',
  'peer-limit',
  'seedRatioMode',
  'seedRatioLimit',
  'seedIdleMode',
  'seedIdleLimit',
  'trackerList',
  'isPrivate',
];

export class Client {
  rpc = new Transmission(preference('drift.endpoint') || undefined);
  torrents = $state<Torrent[]>([]);
  session = $state<Record<string, any>>({});
  stats = $state<Record<string, any>>({});
  details = $state<Torrent | null>(null);
  selected = $state<number[]>([]);
  samples = $state<Sample[]>([]);
  capabilities = $state<Capabilities | null>(null);
  historyOnServer = $state(false);
  private historyProbe = 0;
  private historySaved = 0;
  private historyEndpoint = '';
  online = $state(false);
  ready = $state(false);
  error = $state('');
  startupFailed = $state(false);
  private consecutiveFailures = 0;
  private startupAt = Date.now();
  notice = $state('');
  copyValue = $state<string | null>(null);
  busy = $state(new Set<number>());
  filter = $state<Filter>('all');
  query = $state('');
  labelFilter = $state<string | null>(null);
  sort = $state('addedDate');
  ascending = $state(false);
  private polling = false;
  private lastSample = 0;
  private lastDetail = 0;
  private detailRequest = 0;
  private sessionRequest = 0;
  private optionQueues = new Map<number | 'session', OptionQueue>();
  optionDrafts = $state<Record<string, number | boolean | string>>({});
  private lastSession = 0;
  private lastCapabilityProbe = 0;
  private noticeTimer?: ReturnType<typeof setTimeout>;
  fullSpeedAvailable = $derived(
    !!this.capabilities?.fullSpeed?.enabled &&
      Date.now() / 1000 - this.capabilities.fullSpeed.heartbeat < 12 &&
      this.online,
  );
  focused = $derived(this.torrents.find((t) => t.id === this.selected.at(-1)) || null);
  visible = $derived.by(() =>
    this.torrents
      .filter(
        (t) =>
          this.matches(t, this.filter) &&
          (!this.labelFilter || (t.labels || []).includes(this.labelFilter)) &&
          `${t.name} ${t.downloadDir} ${(t.labels || []).join(' ')}`
            .toLowerCase()
            .includes(this.query.toLowerCase()),
      )
      .sort((a, b) => {
        const x = a[this.sort],
          y = b[this.sort];
        return (
          (typeof x === 'string'
            ? x.localeCompare(y, undefined, { numeric: true })
            : (x || 0) - (y || 0)) * (this.ascending ? 1 : -1)
        );
      }),
  );

  matches(t: Torrent, f: Filter) {
    return (
      f === 'all' ||
      (f === 'downloading' && t.status > 0 && t.status < 5) ||
      (f === 'seeding' && [5, 6].includes(t.status)) ||
      (f === 'paused' && t.status === 0) ||
      (f === 'complete' && t.percentDone === 1) ||
      (f === 'attention' && (t.error > 0 || ['amber', 'red'].includes(stage(t).tone)))
    );
  }
  count(f: Filter) {
    return this.torrents.filter((t) => this.matches(t, f)).length;
  }
  toast(text: string) {
    this.notice = text;
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => (this.notice = ''), 4500);
  }
  async copy(text: string) {
    try {
      await copyText(text);
      this.toast('Copied');
    } catch {
      this.copyValue = text;
    }
  }
  async poll(force = false) {
    if (this.polling) return;
    this.polling = true;
    try {
      const now = Date.now();
      const [result, stats] = await Promise.all([
        this.rpc.call('torrent-get', { fields: overviewFields }),
        this.rpc.call('session-stats'),
      ]);
      this.torrents = result.torrents;
      this.stats = stats;
      this.selected = this.selected.filter((id) => this.torrents.some((t) => t.id === id));
      this.online = true;
      this.ready = true;
      this.error = '';
      this.consecutiveFailures = 0;
      this.startupFailed = false;
      if (now - this.lastSample >= 1500) {
        this.samples = mergeSamples(
          this.samples,
          [{ at: now, down: stats.downloadSpeed, up: stats.uploadSpeed }],
          now,
        );
        this.lastSample = now;
      }
      if (force || now - this.lastSession > 15000) {
        await this.loadSession();
      }
      if (
        this.focused &&
        (force || this.details?.id !== this.focused.id || now - this.lastDetail > 3500)
      )
        await this.loadDetails(this.focused.id);
      if (!this.focused) this.details = null;
      await this.loadCapabilities();
      await this.loadHistory();
    } catch (e) {
      this.online = false;
      this.consecutiveFailures++;
      this.startupFailed = this.consecutiveFailures >= 3 || Date.now() - this.startupAt > 5000;
      this.error = e instanceof Error ? e.message : 'Connection interrupted';
    } finally {
      this.polling = false;
    }
  }
  queueOption(id: number | 'session', key: string, value: number | boolean | string, delay = 0) {
    let queue = this.optionQueues.get(id);
    if (!queue) {
      queue = { values: {}, at: 0 };
      this.optionQueues.set(id, queue);
    }
    queue.values[key] = value;
    queue.at = Date.now() + delay;
    this.optionDrafts = { ...this.optionDrafts, [`${id}:${key}`]: value };
    clearTimeout(queue.timer);
    queue.timer = setTimeout(() => void this.sendOptions(id), delay);
  }
  flushOptions(id: number | 'session') {
    const queue = this.optionQueues.get(id);
    if (!queue) return;
    queue.at = 0;
    void this.sendOptions(id);
  }
  async settleOptions() {
    while (this.optionQueues.size) {
      for (const queue of this.optionQueues.values()) queue.at = 0;
      await Promise.all([...this.optionQueues.keys()].map((id) => this.sendOptions(id)));
    }
  }
  private sendOptions(id: number | 'session'): Promise<void> {
    const queue = this.optionQueues.get(id);
    if (!queue) return Promise.resolve();
    if (queue.running) return queue.running;
    clearTimeout(queue.timer);
    const values = queue.values;
    if (!Object.keys(values).length) return Promise.resolve();
    queue.values = {};
    queue.running = (async () => {
      try {
        if (id === 'session') {
          await this.rpc.call('session-set', values);
          this.sessionRequest++;
          this.session = { ...this.session, ...values };
          await this.loadSession().catch(() => {});
        } else {
          await this.rpc.call('torrent-set', { ids: [id], ...values });
          // Invalidate reads that began before the acknowledgement.
          if (this.details?.id === id) this.details = { ...this.details, ...values };
          if (this.focused?.id === id) {
            this.detailRequest++;
            await this.loadDetails(id);
          }
        }
      } catch (e) {
        this.toast(
          `Could not save ${id === 'session' ? 'setting' : 'transfer option'}: ${e instanceof Error ? e.message : String(e)}`,
        );
      } finally {
        const drafts = { ...this.optionDrafts };
        for (const key of Object.keys(values))
          if (!(key in queue.values)) delete drafts[`${id}:${key}`];
        this.optionDrafts = drafts;
        queue.running = undefined;
        clearTimeout(queue.timer);
        if (Object.keys(queue.values).length)
          queue.timer = setTimeout(
            () => void this.sendOptions(id),
            Math.max(0, queue.at - Date.now()),
          );
        else this.optionQueues.delete(id);
      }
    })();
    return queue.running;
  }
  private async loadSession() {
    const request = ++this.sessionRequest;
    const session = await this.rpc.call('session-get');
    if (request === this.sessionRequest) this.session = session;
    this.lastSession = Date.now();
  }
  async loadDetails(id: number) {
    const request = ++this.detailRequest;
    try {
      const r = await this.rpc.call('torrent-get', {
        ids: [id],
        fields: [
          ...overviewFields,
          ...detailsFields,
          ...(Number(this.session['rpc-version']) >= 18 ? ['sequential_download'] : []),
        ],
      });
      if (this.selected.at(-1) === id && request === this.detailRequest)
        this.details = r.torrents[0] || null;
      this.lastDetail = Date.now();
    } catch (e) {
      this.toast(String(e));
    }
  }
  async loadCapabilities() {
    const now = Date.now();
    if (now - this.lastCapabilityProbe < (this.capabilities ? 1500 : 30000)) return;
    this.lastCapabilityProbe = now;
    const deadline = requestDeadline(2000);
    try {
      const url = new URL('web/full-speed.json', new URL('.', this.rpc.endpoint));
      url.searchParams.set('t', String(Date.now()));
      const r = await fetch(url, { cache: 'no-store', signal: deadline.signal });
      const value = r.ok ? await r.json() : null;
      this.capabilities =
        value?.version === 1 &&
        typeof value.fullSpeed?.enabled === 'boolean' &&
        typeof value.fullSpeed?.label === 'string' &&
        typeof value.fullSpeed?.heartbeat === 'number' &&
        Array.isArray(value.fullSpeed?.active)
          ? value
          : null;
    } catch {
      this.capabilities = null;
    } finally {
      deadline.dispose();
    }
  }
  saveHistory() {
    if (!this.samples.length) return;
    savePreference(
      `drift.history.${this.rpc.endpoint}`,
      JSON.stringify({ version: 1, samples: this.samples.map((s) => [s.at, s.down, s.up]) }),
    );
    this.historySaved = Date.now();
  }
  resetHistory() {
    this.samples = [];
    this.historyEndpoint = '';
    this.historyProbe = 0;
    this.historySaved = 0;
    this.historyOnServer = false;
    this.lastSample = 0;
  }
  async loadHistory() {
    const now = Date.now();
    const key = `drift.history.${this.rpc.endpoint}`;
    if (this.historyEndpoint !== this.rpc.endpoint) {
      this.historyEndpoint = this.rpc.endpoint;
      this.historyProbe = 0;
      this.historyOnServer = false;
      try {
        this.samples = mergeSamples(
          this.samples,
          historySamples(JSON.parse(preference(key) || 'null'), now) || [],
          now,
        );
      } catch {}
    }
    if (now - this.historyProbe < 30000) return;
    this.historyProbe = now;
    const deadline = requestDeadline(2000);
    try {
      const url = new URL('web/activity.json', new URL('.', this.rpc.endpoint));
      const response = await fetch(url, { cache: 'no-store', signal: deadline.signal });
      const value = response.ok ? await response.json() : null;
      const samples = historySamples(value, now);
      this.historyOnServer =
        !!samples && typeof value.updated === 'number' && Math.abs(now / 1000 - value.updated) < 90;
      if (samples) this.samples = mergeSamples(this.samples, samples, now);
    } catch {
      this.historyOnServer = false;
    } finally {
      deadline.dispose();
    }
    if (now - this.historySaved >= 30000) this.saveHistory();
  }
  select(t: Torrent, event?: MouseEvent) {
    if (event?.shiftKey && this.selected.length) {
      const start = this.visible.findIndex((x) => x.id === this.selected[0]);
      const end = this.visible.findIndex((x) => x.id === t.id);
      this.selected = this.visible
        .slice(Math.min(start, end), Math.max(start, end) + 1)
        .map((x) => x.id);
    } else if (event?.metaKey || event?.ctrlKey)
      this.selected = this.selected.includes(t.id)
        ? this.selected.filter((id) => id !== t.id)
        : [...this.selected, t.id];
    else this.selected = [t.id];
    if (this.focused) void this.loadDetails(this.focused.id);
  }
  async action(method: string, ids = this.selected, args: Record<string, unknown> = {}) {
    if (!ids.length || !this.online) return;
    this.busy = new Set([...this.busy, ...ids]);
    try {
      await this.rpc.call(method, { ids, ...args });
      await this.poll(true);
    } catch (e) {
      this.toast(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      this.busy = new Set([...this.busy].filter((id) => !ids.includes(id)));
    }
  }
  async safeAction(method: string, ids = this.selected, args: Record<string, unknown> = {}) {
    try {
      await this.action(method, ids, args);
    } catch {
      /* Error is shown in the toast. */
    }
  }
  async fullSpeed(t: Torrent) {
    if (!this.fullSpeedAvailable) {
      this.toast('Full speed controller is unavailable');
      return;
    }
    const label = this.capabilities!.fullSpeed.label;
    try {
      const r = await this.rpc.call('torrent-get', { fields: ['id', 'labels'] });
      const current = r.torrents.find((x: Torrent) => x.id === t.id);
      if (!current) return;
      const enabled = (current.labels || []).includes(label);
      if (!enabled)
        for (const other of r.torrents)
          if (other.id !== t.id && (other.labels || []).includes(label))
            await this.rpc.call('torrent-set', {
              ids: [other.id],
              labels: other.labels.filter((x: string) => x !== label),
            });
      await this.action('torrent-set', [t.id], {
        labels: enabled
          ? current.labels.filter((x: string) => x !== label)
          : [...(current.labels || []), label],
      });
      this.toast(enabled ? 'Restoring automatic limits' : 'Full speed requested');
    } catch (e) {
      this.toast(e instanceof Error ? e.message : 'Could not change Full speed');
    }
  }
  isFullSpeed(t: Torrent) {
    return (
      !!this.capabilities?.fullSpeed && (t.labels || []).includes(this.capabilities.fullSpeed.label)
    );
  }
  fullSpeedApplied(t: Torrent) {
    return this.fullSpeedAvailable && this.capabilities?.fullSpeed.active.includes(t.hashString);
  }
}
export const client = new Client();
