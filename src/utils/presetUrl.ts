import type { PackConfig, PresetConfig } from '../types/config';
import { createEmptyPack } from '../constants/defaultPresets';
import { parseConfigJson } from './parser';
import { serializeToConfigJson } from './serializer';

export const DEFAULT_PUBLIC_APP_URL = 'https://maksimverzakov.github.io/EP-2350-FX-Tool';

export function encodeBase64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeBase64Url(b64url: string): string {
  const normalized = b64url.trim().replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(padLen);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

function clampSlot(slot: unknown, fallback = 0): number {
  const num = typeof slot === 'number' ? slot : Number(slot);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(3, Math.trunc(num)));
}

export function encodePresetToHash(
  preset: PresetConfig | Record<string, any>,
  slot?: number
): string {
  const targetSlot = clampSlot(slot ?? preset?.pos, 0);
  const rawCandidate = {
    ...preset,
    pos: targetSlot
  };

  // Normalize via parseConfigJson -> serializeToConfigJson so both UI-scale (0..100)
  // and hardware-scale (0.0..1.0) parameters produce a compact hardware JSON preset.
  const parsed = parseConfigJson(
    JSON.stringify({
      name: 'SHARED PRESET',
      presets: [rawCandidate]
    })
  );

  let compactPresetObj: Record<string, any> = rawCandidate;
  if (parsed.pack) {
    const tempPack = createEmptyPack();
    tempPack.presets[targetSlot] =
      parsed.pack.presets.find((p) => p.pos === targetSlot) || parsed.pack.presets[0];
    const serialized = JSON.parse(serializeToConfigJson(tempPack));
    const found = Array.isArray(serialized.presets)
      ? serialized.presets.find((p: any) => p.pos === targetSlot)
      : undefined;
    if (found) {
      compactPresetObj = found;
    }
  }

  const encoded = encodeBase64Url(JSON.stringify(compactPresetObj));
  return targetSlot === 0 ? `#preset=${encoded}` : `#preset=${encoded}&slot=${targetSlot}`;
}

export function encodePackToHash(
  pack: PackConfig | Record<string, any>,
  slot?: number
): string {
  const parsed = parseConfigJson(JSON.stringify(pack));
  const compactJson = parsed.pack
    ? JSON.stringify(JSON.parse(serializeToConfigJson(parsed.pack)))
    : JSON.stringify(pack);
  const encoded = encodeBase64Url(compactJson);
  if (typeof slot === 'number') {
    const targetSlot = clampSlot(slot, 0);
    return `#pack=${encoded}&slot=${targetSlot}`;
  }
  return `#pack=${encoded}`;
}

export function buildPresetShareUrl(
  baseUrl: string,
  preset: PresetConfig | Record<string, any>,
  slot?: number
): string {
  const cleanBase = (baseUrl || DEFAULT_PUBLIC_APP_URL).trim().replace(/\/+$/, '');
  return `${cleanBase}/${encodePresetToHash(preset, slot)}`;
}

export function buildPackShareUrl(
  baseUrl: string,
  pack: PackConfig | Record<string, any>,
  slot?: number
): string {
  const cleanBase = (baseUrl || DEFAULT_PUBLIC_APP_URL).trim().replace(/\/+$/, '');
  return `${cleanBase}/${encodePackToHash(pack, slot)}`;
}

export type DecodedHashPayload =
  | {
      type: 'preset';
      preset: PresetConfig;
      hardwarePresetJson: Record<string, any>;
      slot: number;
    }
  | {
      type: 'pack';
      pack: PackConfig;
      slot: number;
    };

export function decodeHashPayload(hashOrUrl: string): DecodedHashPayload | null {
  try {
    if (!hashOrUrl || typeof hashOrUrl !== 'string') return null;
    const hashIdx = hashOrUrl.indexOf('#');
    const rawHash = hashIdx >= 0 ? hashOrUrl.slice(hashIdx + 1) : hashOrUrl;
    const cleaned = rawHash.replace(/^[/?]+/, '').trim();
    if (!cleaned) return null;

    const params = new URLSearchParams(cleaned);
    const presetParam = params.get('preset');
    const packParam = params.get('pack');
    const slotParam = params.has('slot') ? clampSlot(params.get('slot'), 0) : undefined;

    if (presetParam) {
      const jsonStr = decodeBase64Url(presetParam);
      const rawPreset = JSON.parse(jsonStr);
      if (!rawPreset || typeof rawPreset !== 'object' || Array.isArray(rawPreset)) {
        return null;
      }

      const targetSlot = slotParam ?? clampSlot(rawPreset.pos, 0);
      const parsed = parseConfigJson(
        JSON.stringify({
          name: 'SHARED PRESET',
          presets: [{ ...rawPreset, pos: targetSlot }]
        })
      );
      if (!parsed.pack) return null;

      const preset =
        parsed.pack.presets.find((p) => p.pos === targetSlot) || parsed.pack.presets[0];
      const tempPack = createEmptyPack();
      tempPack.presets[targetSlot] = preset;
      const serialized = JSON.parse(serializeToConfigJson(tempPack));
      const hardwarePresetJson =
        serialized.presets.find((p: any) => p.pos === targetSlot) || serialized.presets[0];

      return {
        type: 'preset',
        preset,
        hardwarePresetJson,
        slot: targetSlot
      };
    }

    if (packParam) {
      const jsonStr = decodeBase64Url(packParam);
      const parsed = parseConfigJson(jsonStr);
      if (!parsed.pack) return null;

      return {
        type: 'pack',
        pack: parsed.pack,
        slot: slotParam ?? 0
      };
    }

    return null;
  } catch {
    return null;
  }
}
