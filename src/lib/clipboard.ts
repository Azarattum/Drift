import type { Torrent } from './types';

/** A cached magnet keeps copying within the user's activation, including Safari. */
export function magnetLink(torrent: Torrent): string {
  if (torrent.magnetLink) return normalizeMagnetLink(torrent.magnetLink);
  const params = new URLSearchParams({ dn: torrent.name });
  for (const tracker of torrent.trackerStats || []) params.append('tr', tracker.announce);
  return `magnet:?xt=urn:btih:${torrent.hashString}&${params.toString()}`;
}

/** Transmission expects the topic URN delimiters literally, even in query values. */
export function normalizeMagnetLink(link: string): string {
  if (!/^magnet:\?/i.test(link)) return link;
  return link.replace(/([?&]xt=)([^&]*)/gi, (original, prefix, value) => {
    try {
      const topic = decodeURIComponent(value);
      return /^urn:btih:(?:[a-f0-9]{40}|[a-z2-7]{32})$/i.test(topic) ? prefix + topic : original;
    } catch {
      return original;
    }
  });
}

/** HTTP LAN pages cannot use the secure-context Clipboard API. */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* User-initiated DOM copying is still available in some browsers. */
    }
  }
  const focused = document.activeElement as HTMLElement | null;
  const selection = document.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange())
    : [];
  const input = document.createElement('textarea');
  input.value = text;
  input.readOnly = true;
  input.style.cssText =
    'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;font-size:16px;pointer-events:none';
  // Stay inside the active modal's focus boundary when one is open.
  (document.querySelector('dialog[open]:not([data-closing])') || document.body).append(input);
  try {
    input.focus({ preventScroll: true });
    input.select();
    input.setSelectionRange(0, text.length);
    if (!document.execCommand('copy')) throw new Error('Copy was blocked by the browser');
  } finally {
    input.remove();
    focused?.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
  }
}
