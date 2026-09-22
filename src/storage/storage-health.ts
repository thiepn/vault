export interface StorageHealth {
  persisted: boolean | null;
  usage: number | null;
  quota: number | null;
  usageRatio: number | null;
}

export async function storageHealth(): Promise<StorageHealth> {
  if (typeof navigator === 'undefined' || !navigator.storage) {
    return { persisted: null, usage: null, quota: null, usageRatio: null };
  }

  let persisted: boolean | null = null;
  let estimate: StorageEstimate = {};
  try {
    if (typeof navigator.storage.persisted === 'function') persisted = await navigator.storage.persisted();
  } catch {
    persisted = false;
  }
  try {
    if (typeof navigator.storage.estimate === 'function') estimate = await navigator.storage.estimate();
  } catch {
    estimate = {};
  }

  const usage = typeof estimate.usage === 'number' ? estimate.usage : null;
  const quota = typeof estimate.quota === 'number' ? estimate.quota : null;
  return {
    persisted,
    usage,
    quota,
    usageRatio: usage !== null && quota !== null && quota > 0 ? usage / quota : null,
  };
}

export async function requestPersistentStorage(): Promise<boolean | null> {
  if (typeof navigator === 'undefined' || !navigator.storage || typeof navigator.storage.persist !== 'function') return null;
  try {
    if (typeof navigator.storage.persisted === 'function' && await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
