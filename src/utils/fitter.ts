/**
 * The fitter: gets the pack's WAVs (plus config.json) into the mic's ~1 MB disk.
 *
 * Every file starts from its original. Concessions go cheapest in sound first, always on the
 * largest file: trim silence, then 16-bit, then mono, then the sample rate one step at a time,
 * then 8-bit as a last resort. Planning is pure arithmetic on frame counts; rendering the audio
 * happens elsewhere (an OfflineAudioContext in the browser).
 */

export interface FitSource {
  file: string;
  frames: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  isFloat: boolean;
  /** Frames that hold sound; outside them is silence that can go. */
  sound: { start: number; end: number };
}

export interface FitEncoding {
  /** Original frames to keep; absent keeps them all. */
  trim?: { start: number; end: number };
  channels: number;
  sampleRate: number;
  bits: number;
  isFloat: boolean;
}

export interface FitPlan {
  encodings: Record<string, FitEncoding>;
  /** What each file gave up, in order, e.g. `['stereo → mono', '44.1 → 22.05 kHz']`. */
  notes: Record<string, string[]>;
  totalBytes: number;
  fits: boolean;
}

/** Sample rates the fitter steps down through. */
export const FIT_RATES = [48000, 44100, 32000, 22050, 16000, 11025, 8000];

const WAV_HEADER_BYTES = 44;
const khz = (hz: number) => `${Number((hz / 1000).toFixed(2))} kHz`;

export function nativeEncoding(src: FitSource): FitEncoding {
  return { channels: src.channels, sampleRate: src.sampleRate, bits: src.bitsPerSample, isFloat: src.isFloat };
}

export const isNative = (src: FitSource, enc: FitEncoding) =>
  !enc.trim &&
  enc.channels === src.channels &&
  enc.sampleRate === src.sampleRate &&
  enc.bits === src.bitsPerSample &&
  enc.isFloat === src.isFloat;

/** Size of `src` written with `enc`. */
export function encodedBytes(src: FitSource, enc: FitEncoding): number {
  const kept = enc.trim ? enc.trim.end - enc.trim.start : src.frames;
  const frames = Math.max(1, Math.round((kept * enc.sampleRate) / src.sampleRate));
  return WAV_HEADER_BYTES + frames * enc.channels * (enc.bits / 8);
}

interface Step {
  apply: (e: FitEncoding) => FitEncoding;
  note: (e: FitEncoding) => string;
}

/** Any re-encoded file is written as 16-bit (or 8-bit) PCM, so steps also bring 24-bit/float down. */
const atMost16 = (e: FitEncoding): FitEncoding => (e.bits > 16 || e.isFloat ? { ...e, bits: 16, isFloat: false } : e);

function ladder(src: FitSource): Step[] {
  const steps: Step[] = [];
  if (src.sound.start > 0 || src.sound.end < src.frames) {
    steps.push({
      apply: (e) => atMost16({ ...e, trim: { ...src.sound } }),
      note: () => `trimmed ${((src.frames - (src.sound.end - src.sound.start)) / src.sampleRate).toFixed(2)} s of silence`
    });
  }
  steps.push({
    apply: (e) => ({ ...e, bits: 16, isFloat: false }),
    note: (e) => `${e.isFloat ? '32-bit float' : `${e.bits}-bit`} → 16-bit`
  });
  steps.push({ apply: (e) => atMost16({ ...e, channels: 1 }), note: () => 'stereo → mono' });
  for (const rate of FIT_RATES) {
    steps.push({
      apply: (e) => atMost16({ ...e, sampleRate: Math.min(e.sampleRate, rate) }),
      note: (e) => `${khz(e.sampleRate)} → ${khz(rate)}`
    });
  }
  steps.push({ apply: (e) => ({ ...e, bits: 8, isFloat: false }), note: () => '16-bit → 8-bit' });
  return steps;
}

/**
 * Plan encodings so the files take at most `availableBytes`, changing as little as needed. With
 * `clusterBytes`, each file counts as whole clusters, as on the mic's FAT disk.
 */
export function planFit(sources: FitSource[], availableBytes: number, clusterBytes = 1): FitPlan {
  const state = sources.map((src) => ({ src, enc: nativeEncoding(src), steps: ladder(src), at: 0, notes: [] as string[] }));
  const onDisk = (bytes: number) => Math.ceil(bytes / clusterBytes) * clusterBytes;
  const total = () => state.reduce((n, s) => n + onDisk(encodedBytes(s.src, s.enc)), 0);
  let guard = state.length * 32;
  while (total() > availableBytes && guard-- > 0) {
    const open = state.filter((s) => s.at < s.steps.length);
    if (open.length === 0) break;
    const target = open.reduce((a, b) => (encodedBytes(b.src, b.enc) > encodedBytes(a.src, a.enc) ? b : a));
    const step = target.steps[target.at++];
    const next = step.apply(target.enc);
    // Skip steps that change nothing (a mono file going mono, 44.1 kHz "down" to 48 kHz)
    if (encodedBytes(target.src, next) >= encodedBytes(target.src, target.enc)) continue;
    target.notes.push(step.note(target.enc));
    target.enc = next;
  }
  const totalBytes = total();
  return {
    encodings: Object.fromEntries(state.map((s) => [s.src.file, s.enc])),
    notes: Object.fromEntries(state.map((s) => [s.src.file, s.notes])),
    totalBytes,
    fits: totalBytes <= availableBytes
  };
}

/**
 * Frames that hold sound: from the first to the last sample above `thresholdDb`, with a little
 * padding so attacks and tails are not clipped.
 */
export function findSound(
  channels: Float32Array[],
  sampleRate: number,
  thresholdDb = -50,
  padSec = 0.01
): { start: number; end: number } {
  const frames = Math.min(...channels.map((c) => c.length));
  const limit = Math.pow(10, thresholdDb / 20);
  const loud = (i: number) => channels.some((c) => Math.abs(c[i]) > limit);
  let first = 0;
  while (first < frames && !loud(first)) first++;
  if (first === frames) return { start: 0, end: frames }; // all silence: keep it as it is
  let last = frames - 1;
  while (last > first && !loud(last)) last--;
  const pad = Math.round(padSec * sampleRate);
  return { start: Math.max(0, first - pad), end: Math.min(frames, last + 1 + pad) };
}

/** Encode channels as 8-bit (unsigned) or 16-bit PCM WAV. */
export function encodeWavPcm(channels: Float32Array[], sampleRate: number, bits: 8 | 16): Uint8Array {
  const ch = channels.length;
  const frames = Math.min(...channels.map((c) => c.length));
  const bps = bits / 8;
  const dataLen = frames * ch * bps;
  const out = new Uint8Array(WAV_HEADER_BYTES + dataLen);
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
  v.setUint32(28, sampleRate * ch * bps, true);
  v.setUint16(32, ch * bps, true);
  v.setUint16(34, bits, true);
  str(36, 'data');
  v.setUint32(40, dataLen, true);
  let o = WAV_HEADER_BYTES;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++) {
      const x = Math.max(-1, Math.min(1, channels[c][i] || 0));
      // 8-bit WAV is unsigned (128 = silence); 16-bit is signed
      if (bits === 8) v.setUint8(o, Math.round((x + 1) * 127.5));
      else v.setInt16(o, x < 0 ? Math.round(x * 32768) : Math.round(x * 32767), true);
      o += bps;
    }
  }
  return out;
}

/** Same encoding? Used to skip re-rendering a file whose plan did not change. */
export const sameEncoding = (a: FitEncoding | undefined, b: FitEncoding | undefined) =>
  !!a &&
  !!b &&
  a.channels === b.channels &&
  a.sampleRate === b.sampleRate &&
  a.bits === b.bits &&
  a.isFloat === b.isFloat &&
  (a.trim?.start ?? -1) === (b.trim?.start ?? -1) &&
  (a.trim?.end ?? -1) === (b.trim?.end ?? -1);
