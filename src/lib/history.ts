import type { Sample } from './types';
export const HISTORY_AGE = 60 * 60 * 1000;
export function mergeSamples(existing: Sample[], incoming: Sample[], now = Date.now()): Sample[] {
  const samples = new Map<number, Sample>();
  for (const item of [...existing, ...incoming]) {
    if (
      !Number.isFinite(item.at) ||
      item.at < now - HISTORY_AGE ||
      item.at > now + 30000 ||
      !Number.isFinite(item.down) ||
      item.down < 0 ||
      !Number.isFinite(item.up) ||
      item.up < 0
    )
      continue;
    samples.set(item.at, item);
  }
  return [...samples.values()].sort((a, b) => a.at - b.at).slice(-2400);
}
export function historySamples(value: unknown, now = Date.now()): Sample[] | null {
  const data = value as { version?: number; samples?: unknown[] } | null;
  if (data?.version !== 1 || !Array.isArray(data.samples) || data.samples.length > 5000)
    return null;
  return mergeSamples(
    [],
    data.samples
      .filter(
        (x): x is [number, number, number] =>
          Array.isArray(x) && x.length === 3 && x.every((n) => typeof n === 'number'),
      )
      .map(([at, down, up]) => ({ at, down, up })),
    now,
  );
}
