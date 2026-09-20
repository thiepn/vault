/** These wrappers expose native IndexedDB rather than creating another database engine. */
export function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed.'));
  });
}

export function completed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted.', 'AbortError'));
    tx.onerror = () => { /* Request rejection or onabort reports failure; never suppress it. */ };
  });
}

export async function transact<T>(
  database: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  body: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  const tx = database.transaction(stores, mode);
  const done = completed(tx);
  void done.catch(() => undefined);
  try {
    const result = await body(tx);
    await done;
    return result;
  } catch (error) {
    try { tx.abort(); } catch { /* The transaction may already have aborted. */ }
    await done.catch(() => undefined);
    throw error;
  }
}
