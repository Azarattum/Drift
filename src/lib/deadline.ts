/** Keep the native path; Safari 15.4 needs an AbortController and a disposable timer. */
export function requestDeadline(milliseconds: number, ...signals: (AbortSignal | undefined)[]) {
  if (!signals.some(Boolean) && typeof AbortSignal.timeout === 'function')
    return { signal: AbortSignal.timeout(milliseconds), dispose() {} };
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of signals) {
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  }
  const timer = setTimeout(() => controller.abort(), milliseconds);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      for (const signal of signals) signal?.removeEventListener('abort', abort);
    },
  };
}
