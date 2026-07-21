/**
 * Offline mutation queue — IndexedDB outbox pattern.
 * Persists critical writes (custody scans, delivery updates) and replays on reconnect.
 */

export type SyncStatus = 'pending' | 'syncing' | 'synced' | 'failed';

export interface QueuedMutation {
  id: string;
  endpoint: string;
  method: string;
  body: unknown;
  timestamp: number;
  status: SyncStatus;
  error?: string;
}

const DB_NAME = 'hc-offline';
const STORE = 'outbox';
const DB_VERSION = 1;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest
): Promise<unknown> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function enqueue(mutation: Omit<QueuedMutation, 'id' | 'timestamp' | 'status'>): Promise<string> {
  const item: QueuedMutation = {
    ...mutation,
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    timestamp: Date.now(),
    status: 'pending',
  };
  await tx('readwrite', (s) => s.put(item));
  return item.id;
}

export async function getPending(): Promise<QueuedMutation[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readonly');
    const req = t.objectStore(STORE).getAll();
    req.onsuccess = () =>
      resolve((req.result as QueuedMutation[]).filter((m) => m.status === 'pending').sort((a, b) => a.timestamp - b.timestamp));
    req.onerror = () => reject(req.error);
  });
}

export async function updateStatus(id: string, status: SyncStatus, error?: string): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite');
    const store = t.objectStore(STORE);
    const req = store.get(id);
    req.onsuccess = () => {
      const item = req.result as QueuedMutation;
      if (!item) return resolve();
      store.put({ ...item, status, error });
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function removeItem(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id));
}

/**
 * Replay all pending mutations in order.
 * Server timestamp wins on conflict — failed items are marked 'failed' with error.
 */
export async function replayQueue(
  fetcher: (endpoint: string, method: string, body: unknown) => Promise<Response>
): Promise<void> {
  const pending = await getPending();
  for (const mutation of pending) {
    await updateStatus(mutation.id, 'syncing');
    try {
      const res = await fetcher(mutation.endpoint, mutation.method, mutation.body);
      if (res.ok) {
        await updateStatus(mutation.id, 'synced');
        await removeItem(mutation.id);
      } else if (res.status === 409) {
        // Conflict: server wins, mark needs-review
        await updateStatus(mutation.id, 'failed', 'Conflict: needs review');
      } else {
        await updateStatus(mutation.id, 'failed', `HTTP ${res.status}`);
      }
    } catch (err) {
      await updateStatus(mutation.id, 'pending', String(err));
    }
  }
}

/** Wire replay to the online event — call once at app startup */
export function registerReplayOnReconnect(
  fetcher: (endpoint: string, method: string, body: unknown) => Promise<Response>
): () => void {
  const handler = () => replayQueue(fetcher);
  window.addEventListener('online', handler);
  return () => window.removeEventListener('online', handler);
}
