/** Keep the native path; Safari 15.4 needs an AbortController and a disposable timer. */
export function requestDeadline(milliseconds: number, external?: AbortSignal) {
  if (external) return { signal: external, dispose() {} };
  if (typeof AbortSignal.timeout === 'function')
    return { signal: AbortSignal.timeout(milliseconds), dispose() {} };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), milliseconds);
  return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}
