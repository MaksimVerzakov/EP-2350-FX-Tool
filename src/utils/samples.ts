import type { PackConfig, PlayMode, SampleSlotConfig } from '../types/config';
import { serializeToConfigJson } from './serializer';

/**
 * Custom samples: WAV checks against the mic's limits, slot editing and the disk budget.
 *
 * How the mic loads samples (TE firmware `main.py`): with a config.json, all four slots start as
 * factory sounds, then each `samples[i]` loads its `file` into slot `pos`. A missing or unreadable
 * file leaves that slot on its factory sound. So a slot is custom only when `samples` lists it.
 */

/** The fx-mic disk holds about 1 MB for config.json and every WAV. */
export const DISK_BUDGET_BYTES = 1024 * 1024;
export const SAMPLE_SLOTS = 4;
export const MAX_SAMPLE_RATE = 96000;

export interface WavInfo {
  /** WAVE format tag: 1 = PCM, 3 = IEEE float, 0xfffe = extensible (its sub-format decides). */
  formatTag: number;
  isFloat: boolean;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataBytes: number;
  frames: number;
  durationSec: number;
}

const fourCC = (v: DataView, o: number) =>
  String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));

/** Read a WAV file's format from its header. Throws when the bytes are not a WAV file. */
export function inspectWav(bytes: Uint8Array): WavInfo {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12 || fourCC(v, 0) !== 'RIFF' || fourCC(v, 8) !== 'WAVE') {
    throw new Error('Not a WAV file (no RIFF/WAVE header).');
  }
  let fmt: Omit<WavInfo, 'dataBytes' | 'frames' | 'durationSec'> | null = null;
  let dataBytes = -1;
  let off = 12;
  while (off + 8 <= bytes.byteLength) {
    const id = fourCC(v, off);
    const size = v.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ' && size >= 16 && body + 16 <= bytes.byteLength) {
      let formatTag = v.getUint16(body, true);
      const channels = v.getUint16(body + 2, true);
      const sampleRate = v.getUint32(body + 4, true);
      const bitsPerSample = v.getUint16(body + 14, true);
      if (formatTag === 0xfffe && size >= 40 && body + 26 <= bytes.byteLength) {
        formatTag = v.getUint16(body + 24, true); // first two bytes of the sub-format GUID
      }
      fmt = { formatTag, isFloat: formatTag === 3, channels, sampleRate, bitsPerSample };
    } else if (id === 'data') {
      dataBytes = Math.min(size, bytes.byteLength - body);
    }
    off = body + size + (size % 2);
  }
  if (!fmt) throw new Error('WAV file has no "fmt " chunk.');
  if (dataBytes < 0) throw new Error('WAV file has no audio data.');
  const frameBytes = fmt.channels * (fmt.bitsPerSample / 8);
  const frames = frameBytes > 0 ? Math.floor(dataBytes / frameBytes) : 0;
  return { ...fmt, dataBytes, frames, durationSec: fmt.sampleRate > 0 ? frames / fmt.sampleRate : 0 };
}

/** Why the mic would refuse this WAV (guide: mono or stereo, 8/16/24-bit or 32-bit float, up to 96 kHz). */
export function wavDeviceIssues(info: WavInfo): string[] {
  const issues: string[] = [];
  if (info.formatTag !== 1 && info.formatTag !== 3) {
    issues.push('Compressed WAV: the mic only plays plain PCM or 32-bit float WAV.');
  } else if (info.isFloat ? info.bitsPerSample !== 32 : ![8, 16, 24].includes(info.bitsPerSample)) {
    issues.push(
      info.isFloat
        ? `${info.bitsPerSample}-bit float: the mic takes 32-bit float only.`
        : `${info.bitsPerSample}-bit: the mic takes 8, 16 or 24-bit (or 32-bit float).`
    );
  }
  if (info.channels < 1 || info.channels > 2) {
    issues.push(`${info.channels} channels: the mic takes mono or stereo.`);
  }
  if (info.sampleRate > MAX_SAMPLE_RATE) {
    issues.push(`${formatRate(info.sampleRate)}: the mic plays up to 96 kHz.`);
  }
  if (info.frames === 0) issues.push('The file has no audio.');
  return issues;
}

export const formatRate = (hz: number) => `${Number((hz / 1000).toFixed(2))} kHz`;
export const formatBytes = (n: number) =>
  n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(2)} MB` : `${Math.max(0, Math.round(n / 1024))} KB`;

/** One line describing a WAV: `44.1 kHz · 16-bit · mono · 1.42 s`. */
export function describeWav(info: WavInfo): string {
  const depth = info.isFloat ? `${info.bitsPerSample}-bit float` : `${info.bitsPerSample}-bit`;
  const ch = info.channels === 1 ? 'mono' : info.channels === 2 ? 'stereo' : `${info.channels} ch`;
  return `${formatRate(info.sampleRate)} · ${depth} · ${ch} · ${info.durationSec.toFixed(2)} s`;
}

/**
 * A disk-safe file name: lowercase letters, digits, `-` and `_`, ending in `.wav`, unique among `taken`
 * (case-insensitive, as FAT is). `My Shout!.WAV` becomes `my-shout.wav`.
 */
export function sanitizeSampleFileName(original: string, taken: string[] = []): string {
  const stem =
    original
      .replace(/\.[^.]*$/, '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'sample';
  const used = new Set(taken.map((t) => t.toLowerCase()));
  let name = `${stem}.wav`;
  for (let n = 2; used.has(name); n++) name = `${stem}-${n}.wav`;
  return name;
}

/** The slots `samples` lists (none while the pack uses the factory sounds). */
export function customSampleSlots(pack: PackConfig): SampleSlotConfig[] {
  return pack.useBuiltInSamples ? [] : pack.samples.filter((s) => s.pos >= 0 && s.pos < SAMPLE_SLOTS);
}

export function customSampleAt(pack: PackConfig, pos: number): SampleSlotConfig | undefined {
  return customSampleSlots(pack).find((s) => s.pos === pos);
}

const sortSlots = (slots: SampleSlotConfig[]) => [...slots].sort((a, b) => a.pos - b.pos);

/** Put `file` in slot `pos`, keeping that slot's playmode and duck if it already had a file. */
export function assignSampleFile(pack: PackConfig, pos: number, file: string): PackConfig {
  const current = customSampleSlots(pack);
  const prev = current.find((s) => s.pos === pos);
  const slot: SampleSlotConfig = prev
    ? { ...prev, file }
    : { id: `s-${pos}-${Date.now().toString(36)}`, pos, file, playmode: 'oneshot' };
  return {
    ...pack,
    useBuiltInSamples: false,
    samples: sortSlots([...current.filter((s) => s.pos !== pos), slot])
  };
}

/** Change a custom slot's playmode or duck. `duck: undefined` removes it (no ducking). */
export function updateSampleSlot(
  pack: PackConfig,
  pos: number,
  patch: { playmode?: PlayMode; duck?: number | undefined }
): PackConfig {
  const current = customSampleSlots(pack);
  if (!current.some((s) => s.pos === pos)) return pack;
  return {
    ...pack,
    samples: current.map((s) => {
      if (s.pos !== pos) return s;
      const next: SampleSlotConfig = { ...s, ...patch };
      if ('duck' in patch && patch.duck === undefined) delete next.duck;
      return next;
    })
  };
}

/** Give slot `pos` back its factory sound. With no custom slot left the pack uses the factory sounds. */
export function clearSampleSlot(pack: PackConfig, pos: number): PackConfig {
  const rest = customSampleSlots(pack).filter((s) => s.pos !== pos);
  return rest.length > 0 ? { ...pack, samples: rest } : { ...pack, useBuiltInSamples: true, samples: [] };
}

export interface DiskUsage {
  configBytes: number;
  sampleBytes: number;
  totalBytes: number;
  budgetBytes: number;
  fits: boolean;
  /** Files the pack names that are not loaded in this browser. */
  missingFiles: string[];
}

/** What config.json plus the loaded WAVs take on the disk. `fileSizes` maps file name to bytes. */
export function diskUsage(pack: PackConfig, fileSizes: Record<string, number>): DiskUsage {
  const configBytes = new TextEncoder().encode(serializeToConfigJson(pack)).byteLength;
  const files = [...new Set(customSampleSlots(pack).map((s) => s.file))];
  const sampleBytes = files.reduce((n, f) => n + (fileSizes[f] ?? 0), 0);
  const totalBytes = configBytes + sampleBytes;
  return {
    configBytes,
    sampleBytes,
    totalBytes,
    budgetBytes: DISK_BUDGET_BYTES,
    fits: totalBytes <= DISK_BUDGET_BYTES,
    missingFiles: files.filter((f) => !(f in fileSizes))
  };
}

/** Encode channels (1 or 2) as a 16-bit PCM WAV, a format every EP-2350 firmware plays. */
export function encodeWav16(channels: Float32Array[], sampleRate: number): Uint8Array {
  const ch = channels.length;
  const frames = Math.min(...channels.map((c) => c.length));
  const dataLen = frames * ch * 2;
  const out = new Uint8Array(44 + dataLen);
  const v = new DataView(out.buffer);
  const str = (o: number, t: string) => {
    for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + dataLen, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, ch, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * ch * 2, true);
  v.setUint16(32, ch * 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, dataLen, true);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++) {
      const x = Math.max(-1, Math.min(1, channels[c][i] || 0));
      v.setInt16(o, x < 0 ? Math.round(x * 32768) : Math.round(x * 32767), true);
      o += 2;
    }
  }
  return out;
}

/** Channels the mic can take: mono and stereo stay as they are, more channels are mixed to mono. */
export function deviceChannels(channels: Float32Array[]): Float32Array[] {
  if (channels.length <= 2) return channels;
  const frames = Math.min(...channels.map((c) => c.length));
  const mono = new Float32Array(frames);
  for (const c of channels) for (let i = 0; i < frames; i++) mono[i] += c[i] / channels.length;
  return [mono];
}
