import type { PackConfig } from '../types/config';
import { parseConfigJson } from './parser';
import { serializeToConfigJson } from './serializer';

/** A pack the user owns ("YOUR PACKS"), persisted in the browser's localStorage. */
export interface UserPack {
  id: string;
  pack: PackConfig;
  updatedAt: number;
}

/** Which pack the editor is showing. */
export type PackSelection =
  | { kind: 'user'; id: string }
  | { kind: 'official'; id: string }
  | { kind: 'device' };

export const USER_PACKS_KEY = 'ep2350_user_packs';
export const ACTIVE_PACK_KEY = 'ep2350_active_pack';
/** Legacy single-pack slot, written by versions before "YOUR PACKS". */
export const LEGACY_PACK_KEY = 'ep2350_pack_config';

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface StoredUserPack {
  id: string;
  config: string;
  updatedAt: number;
}

export function createUserPackId(): string {
  return `up-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function packFingerprint(pack: PackConfig): string {
  return serializeToConfigJson(pack);
}

export function loadUserPacks(store: KeyValueStore): UserPack[] {
  let raw: string | null = null;
  try {
    raw = store.getItem(USER_PACKS_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    const out: UserPack[] = [];
    for (const item of list as StoredUserPack[]) {
      if (!item || typeof item.id !== 'string' || typeof item.config !== 'string') continue;
      const parsed = parseConfigJson(item.config);
      if (!parsed.pack) continue;
      out.push({
        id: item.id,
        pack: parsed.pack,
        updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function saveUserPacks(store: KeyValueStore, packs: UserPack[]): void {
  const stored: StoredUserPack[] = packs.map((p) => ({
    id: p.id,
    config: serializeToConfigJson(p.pack),
    updatedAt: p.updatedAt
  }));
  try {
    store.setItem(USER_PACKS_KEY, JSON.stringify(stored));
  } catch {
    // Storage full or blocked: keep working in memory.
  }
}

export function loadSelection(store: KeyValueStore): PackSelection | null {
  try {
    const raw = store.getItem(ACTIVE_PACK_KEY);
    if (!raw) return null;
    const sel = JSON.parse(raw);
    if (sel?.kind === 'user' && typeof sel.id === 'string') return { kind: 'user', id: sel.id };
    if (sel?.kind === 'official' && typeof sel.id === 'string') return { kind: 'official', id: sel.id };
    if (sel?.kind === 'device') return { kind: 'device' };
    return null;
  } catch {
    return null;
  }
}

export function saveSelection(store: KeyValueStore, selection: PackSelection | null): void {
  try {
    store.setItem(ACTIVE_PACK_KEY, JSON.stringify(selection));
  } catch {
    // ignore
  }
}

/**
 * Adds `pack` to the list unless an identical pack is already there.
 * Returns the new list and the id of the (new or existing) entry.
 */
export function addUserPack(
  packs: UserPack[],
  pack: PackConfig,
  opts: { dedupe?: boolean; now?: number } = {}
): { packs: UserPack[]; id: string } {
  if (opts.dedupe) {
    const fp = packFingerprint(pack);
    const existing = packs.find((p) => packFingerprint(p.pack) === fp);
    if (existing) return { packs, id: existing.id };
  }
  const entry: UserPack = { id: createUserPackId(), pack, updatedAt: opts.now ?? Date.now() };
  return { packs: [...packs, entry], id: entry.id };
}

export function updateUserPack(packs: UserPack[], id: string, pack: PackConfig, now = Date.now()): UserPack[] {
  return packs.map((p) => (p.id === id ? { ...p, pack, updatedAt: now } : p));
}

export function removeUserPack(packs: UserPack[], id: string): UserPack[] {
  return packs.filter((p) => p.id !== id);
}

/**
 * First run after the "YOUR PACKS" update: the old single saved pack becomes the first
 * user pack, unless it is just an untouched official pack.
 */
export function migrateLegacyPack(
  store: KeyValueStore,
  officialPacks: PackConfig[]
): { packs: UserPack[]; migratedId: string | null } {
  let hasKey = false;
  try {
    hasKey = store.getItem(USER_PACKS_KEY) !== null;
  } catch {
    return { packs: [], migratedId: null };
  }
  if (hasKey) return { packs: loadUserPacks(store), migratedId: null };

  let legacy: string | null = null;
  try {
    legacy = store.getItem(LEGACY_PACK_KEY);
  } catch {
    legacy = null;
  }
  const parsed = legacy ? parseConfigJson(legacy) : null;
  if (!parsed?.pack) {
    saveUserPacks(store, []);
    return { packs: [], migratedId: null };
  }
  const fp = packFingerprint(parsed.pack);
  if (officialPacks.some((p) => packFingerprint(p) === fp)) {
    saveUserPacks(store, []);
    return { packs: [], migratedId: null };
  }
  const { packs, id } = addUserPack([], parsed.pack);
  saveUserPacks(store, packs);
  return { packs, migratedId: id };
}

const normalizeName = (name: string) => name.trim().toUpperCase();

/** The YOUR PACKS entry with this pack name (case-insensitive), if any. */
export function findUserPackByName(packs: UserPack[], name: string): UserPack | undefined {
  const target = normalizeName(name);
  return packs.find((p) => normalizeName(p.pack.name) === target);
}

/** A pack name not used in YOUR PACKS yet: "NAME 2", "NAME 3", ... within the 24-character limit. */
export function uniqueCopyName(packs: UserPack[], name: string, maxLength = 24): string {
  const base = normalizeName(name) || 'UNTITLED PACK';
  for (let n = 2; n < 1000; n++) {
    const suffix = ` ${n}`;
    const candidate = `${base.slice(0, maxLength - suffix.length).trimEnd()}${suffix}`;
    if (!findUserPackByName(packs, candidate)) return candidate;
  }
  return base.slice(0, maxLength);
}

export type IncomingPackPlan =
  | { action: 'open'; id: string }
  | { action: 'add' }
  | { action: 'ask'; existingId: string; copyName: string };

/**
 * What to do with a pack arriving from a link: identical to a stored pack → just open it;
 * same name but different contents → ask (replace / save as copy); otherwise add it.
 */
export function planIncomingPack(packs: UserPack[], pack: PackConfig): IncomingPackPlan {
  const fp = packFingerprint(pack);
  const identical = packs.find((p) => packFingerprint(p.pack) === fp);
  if (identical) return { action: 'open', id: identical.id };
  const sameName = findUserPackByName(packs, pack.name);
  if (sameName) return { action: 'ask', existingId: sameName.id, copyName: uniqueCopyName(packs, pack.name) };
  return { action: 'add' };
}
