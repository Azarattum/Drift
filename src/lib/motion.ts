export function motion(milliseconds: number): number {
  return typeof Element.prototype.animate !== 'function' ||
    matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 0
    : milliseconds;
}
