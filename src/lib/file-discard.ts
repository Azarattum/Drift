import { streamBase } from './playback';

function headers(username: string, password: string) {
  return username
    ? { Authorization: `Basic ${btoa(unescape(encodeURIComponent(`${username}:${password}`)))}` }
    : undefined;
}

export async function canDiscardFileData(
  endpoint: string,
  username: string,
  password: string,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const response = await fetch(new URL('v1/status', streamBase(endpoint)), {
      headers: headers(username, password),
      signal,
    });
    if (response.ok) return (await response.json())?.discardFileData === true;
  } catch {
    // Older companions and unreachable hosts leave the action unavailable.
  }
  return false;
}

export async function discardFileData(
  endpoint: string,
  username: string,
  password: string,
  hash: string,
  index: number,
) {
  if (!/^[a-f0-9]{40}$/i.test(hash) || !Number.isSafeInteger(index) || index < 0)
    throw new Error('Invalid file selection.');
  const response = await fetch(new URL(`v1/discard/${hash}/${index}`, streamBase(endpoint)), {
    method: 'POST',
    headers: { ...headers(username, password), 'X-Drift-Stream': '1' },
  });
  if (!response.ok)
    throw new Error(
      (await response.text()).trim().slice(0, 240) || 'Could not delete the file data.',
    );
}
