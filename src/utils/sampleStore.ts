import type { WavInfo } from './samples';
import type { FitEncoding } from './fitter';

/**
 * Keeps loaded WAVs across reloads in IndexedDB (localStorage is too small for audio), by file
 * name. Without IndexedDB (some private windows) every call quietly does nothing and WAVs last
 * for the session only.
 */

export interface StoredSample {
  /** The file as it goes on the disk (fitted when the pack needed room). */
  bytes: Uint8Array;
  info: WavInfo;
  /** The file as loaded, when `bytes` is a fitted copy; the fitter always starts from it. */
  original?: { bytes: Uint8Array; info: WavInfo };
  /** Frames of the original that hold sound. */
  sound?: { start: number; end: number };
  encoding?: FitEncoding;
  notes?: string[];
}

const DB_NAME = 'ep2350_samples';
const STORE = 'files';

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise<T | undefined>((resolve) => {
        if (!db) return resolve(undefined);
        try {
          const tx = db.transaction(STORE, mode);
          const req = fn(tx.objectStore(STORE));
          tx.oncomplete = () => resolve(req ? req.result : undefined);
          tx.onerror = () => resolve(undefined);
          tx.onabort = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      })
  );
}

/** Every stored WAV, by file name. */
export async function loadStoredSamples(): Promise<Record<string, StoredSample>> {
  const out: Record<string, StoredSample> = {};
  const db = await openDb();
  if (!db) return out;
  await new Promise<void>((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve();
        const v = cursor.value as {
          bytes?: ArrayBuffer;
          info?: WavInfo;
          original?: { bytes?: ArrayBuffer; info?: WavInfo };
          sound?: StoredSample['sound'];
          encoding?: FitEncoding;
          notes?: string[];
        };
        if (v?.bytes instanceof ArrayBuffer && v.info) {
          const entry: StoredSample = { bytes: new Uint8Array(v.bytes), info: v.info };
          if (v.original?.bytes instanceof ArrayBuffer && v.original.info) {
            entry.original = { bytes: new Uint8Array(v.original.bytes), info: v.original.info };
          }
          if (v.sound) entry.sound = v.sound;
          if (v.encoding) entry.encoding = v.encoding;
          if (Array.isArray(v.notes)) entry.notes = v.notes;
          out[String(cursor.key)] = entry;
        }
        cursor.continue();
      };
      req.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
  return out;
}

export async function storeSample(name: string, sample: StoredSample): Promise<void> {
  // Store a plain ArrayBuffer copy: structured clone of a view would keep its whole backing buffer
  const bytes = sample.bytes.slice().buffer;
  const original = sample.original ? { bytes: sample.original.bytes.slice().buffer, info: sample.original.info } : undefined;
  const { sound, encoding, notes } = sample;
  await run('readwrite', (s) => s.put({ bytes, info: sample.info, original, sound, encoding, notes, savedAt: Date.now() }, name));
}

/** Delete stored WAVs whose names are not in `keep`. */
export async function pruneStoredSamples(keep: Set<string>): Promise<void> {
  const stored = await loadStoredSampleNames();
  const stale = stored.filter((n) => !keep.has(n));
  if (stale.length === 0) return;
  await run('readwrite', (s) => {
    for (const n of stale) s.delete(n);
  });
}

async function loadStoredSampleNames(): Promise<string[]> {
  const keys = await run<IDBValidKey[]>('readonly', (s) => s.getAllKeys());
  return (keys ?? []).map(String);
}
