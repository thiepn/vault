import { newId, type DeviceId } from '../domain/model.js';

const DEVICE_KEY = 'vault:device-id';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function ensureDeviceId(storage: KeyValueStorage): DeviceId {
  const existing = storage.getItem(DEVICE_KEY);
  if (existing && uuidPattern.test(existing)) return existing as DeviceId;
  const id = newId<'device'>();
  storage.setItem(DEVICE_KEY, id);
  return id;
}

export function defaultDeviceLabel(userAgent = '', platform = ''): string {
  const haystack = `${platform} ${userAgent}`.toLocaleLowerCase();
  if (haystack.includes('android')) return 'Android browser';
  if (haystack.includes('iphone') || haystack.includes('ipad') || haystack.includes('ios')) return 'iOS browser';
  if (haystack.includes('windows') || haystack.includes('win32') || haystack.includes('win64')) return 'Windows browser';
  if (haystack.includes('mac')) return 'Mac browser';
  if (haystack.includes('linux')) return 'Linux browser';
  return 'Web browser';
}
