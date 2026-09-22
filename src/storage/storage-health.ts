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

  const [persisted, estimate] = await Promise.all([
    navigator.storage.persisted?.().catch(() => false) ?? Promise.resolve(false),
    navigator.storage.estimate?.().catch(() => ({})) ?? Promise.resolve({}),
  ]);

  const usage = typeof estimate.usage === 'number' ? estimate.usage : null;
  const quota = typeof estimate.quota === 'number' ? estimate.quota : null;
  return {
    persisted,
    usage,
    quota,
    usageRatio: usage !== null && quota && quota > 0 ? usage / quota : null,
  };
}

export async function requestPersistentStorage(): Promise<boolean | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return null;
  try {
    if (await navigator.storage.persisted()) return true;
    return navigator.storage.persist();
  } catch {
    return false;
  }
}
