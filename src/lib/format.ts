export function bytes(n = 0, decimals = 1): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(4, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toLocaleString(undefined, { maximumFractionDigits: i ? decimals : 0 })} ${units[i]}`;
}
export const speed = (n = 0) => `${bytes(n)}/s`;
export const percent = (n = 0) =>
  `${Math.min(100, Math.max(0, n * 100)).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
export function duration(s: number): string {
  if (!Number.isFinite(s) || s < 0 || s > 365 * 86400) return '—';
  if (s < 60) return '< 1 min';
  if (s < 3600) return `${Math.ceil(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}
export const date = (n?: number) => (n ? new Date(n * 1000).toLocaleString() : '—');
