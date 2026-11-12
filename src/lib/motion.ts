export function motion(milliseconds: number): number {
  return matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : milliseconds;
}
