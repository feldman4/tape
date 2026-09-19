// Remembers the last-selected device by *name* (not deviceId/MIDI id, which
// are not stable across browser sessions or reconnects) so audio/MIDI
// selectors can automatically reconnect a matching device on later visits.

const STORAGE_PREFIX = 'loop-pad:last-device:';

export function rememberDeviceName(key: string, name: string | null | undefined): void {
  if (!name) return;
  localStorage.setItem(STORAGE_PREFIX + key, name);
}

export function getRememberedDeviceName(key: string): string | null {
  return localStorage.getItem(STORAGE_PREFIX + key);
}

export function rememberDeviceNumber(key: string, value: number): void {
  localStorage.setItem(STORAGE_PREFIX + key, String(value));
}

export function getRememberedDeviceNumber(key: string): number | null {
  const value = localStorage.getItem(STORAGE_PREFIX + key);
  if (value === null) return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

/** Finds the first device in `list` whose name/label matches the remembered name, if any. */
export function findRememberedDevice<T extends { name?: string | null; label?: string }>(
  list: T[],
  key: string,
): T | undefined {
  const remembered = getRememberedDeviceName(key);
  if (!remembered) return undefined;
  return list.find((device) => (device.name ?? device.label) === remembered);
}
