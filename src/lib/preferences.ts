/** Storage may be blocked or full. The client must remain usable in memory. */
export function preference(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function savePreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Preferences are optional; connection and appearance still work for this session.
  }
}
