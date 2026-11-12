import { expect, test } from 'bun:test';
import { requestDeadline } from '../../src/lib/deadline';
import { preference, savePreference } from '../../src/lib/preferences';

test('request deadlines abort without AbortSignal.timeout and can release their timers', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout')!;
  Object.defineProperty(AbortSignal, 'timeout', { value: undefined, configurable: true });
  try {
    const expired = requestDeadline(5);
    const completed = requestDeadline(5);
    completed.dispose();
    await Bun.sleep(20);
    expect(expired.signal.aborted).toBe(true);
    expect(completed.signal.aborted).toBe(false);
    expired.dispose();
    const controller = new AbortController();
    const external = requestDeadline(5, controller.signal);
    external.dispose();
    controller.abort();
    expect(external.signal.aborted).toBe(true);
  } finally {
    Object.defineProperty(AbortSignal, 'timeout', descriptor);
  }
});

test('blocked preference storage is optional for connection and appearance', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('Storage blocked');
    },
  });
  try {
    expect(preference('drift.endpoint')).toBeNull();
    expect(() => savePreference('drift.theme', 'dark')).not.toThrow();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
