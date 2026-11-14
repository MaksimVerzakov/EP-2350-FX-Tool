/**
 * Acoustic Feature Extractor, Spectral/Temporal Fingerprinter, and Multi-Resolution
 * Audio Distance Engine for EP-2350 Sound Design & Reference Matching.
 */

import type { StereoPcmBuffer } from '../utils/wavCodec';

export interface SpectralBandsDb {
  subBassDb: number; // 20 - 80 Hz
  bassDb: number; // 80 - 250 Hz
  lowMidDb: number; // 250 - 800 Hz
  highMidDb: number; // 800 - 2500 Hz
  presenceDb: number; // 2500 - 6000 Hz
  airDb: number; // 6000 - 18000 Hz
}

export interface AudioAnalysisReport {
  durationSec: number;
  sampleRate: number;
  rmsDb: number;
  peakDb: number;
  crestFactorDb: number;
  stereoBalance: number; // -1.0 (left) .. 0.0 (center) .. +1.0 (right)
  isSilent: boolean;
  isClipping: boolean;
  spectralCentroidHz: number;
  spectralRolloff85Hz: number;
  spectralFlatness: number;
  bandsDb: SpectralBandsDb;
  fundamentalHz: number;
  estimatedPitchRatio: number;
  estimatedSemitones: number;
  inharmonicityScore: number; // 0..1 (elevated by SSB / RING)
  /** Level (dB) of the output just after the dry phrase ends; very low when there is no tail. */
  tailRmsDb: number;
  /** RT60-style tail time (s) measured after the dry phrase ends; 0 when there is no tail. Capped at 10. */
  estimatedTailDecaySec: number;
  /** True when the tail barely decays within the analysed window, so the value is a lower bound. */
  tailDecayIsLowerBound: boolean;
  estimatedDelayMs: number | null;
  /** Echo-to-direct level ratio at `estimatedDelayMs` (0..1); ~0 when there is no discrete echo. */
  echoStrength: number;
  /** True when no dry reference was available, so echo/tail figures are blind estimates. */
  isBlindEstimate: boolean;
  inferredCues: string[];
}

export interface AudioDistanceResult {
  totalLoss: number;
  spectralLoss: number;
  envelopeLoss: number;
  bandLoss: number;
  stereoLoss: number;
  similarityScore: number; // 0 .. 100
}

/**
 * In-place Radix-2 Cooley-Tukey FFT. `re` and `im` must have power-of-2 length.
 */
export function fftRadix2(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  let j = 0;
  for (let i = 0; i < n; i++) {
    if (i < j) {
      const tr = re[i];
      const ti = im[i];
      re[i] = re[j];
      im[i] = im[j];
      re[j] = tr;
      im[j] = ti;
    }
    let m = n >> 1;
    while (m >= 1 && j >= m) {
      j -= m;
      m >>= 1;
    }
    j += m;
  }

  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = (-2 * Math.PI) / len;
    const wLenRe = Math.cos(ang);
    const wLenIm = Math.sin(ang);

    for (let i = 0; i < n; i += len) {
      let wRe = 1.0;
      let wIm = 0.0;
      for (let k = 0; k < half; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const v = i + k + half;
        const tRe = wRe * re[v] - wIm * im[v];
        const tIm = wRe * im[v] + wIm * re[v];
        re[v] = uRe - tRe;
        im[v] = uIm - tIm;
        re[i + k] = uRe + tRe;
        im[i + k] = uIm + tIm;
        const nextWRe = wRe * wLenRe - wIm * wLenIm;
        wIm = wRe * wLenIm + wIm * wLenRe;
        wRe = nextWRe;
      }
    }
  }
}

const linToDb = (lin: number): number => 20 * Math.log10(Math.max(1e-6, lin));
const powToDb = (pow: number): number => 10 * Math.log10(Math.max(1e-12, pow));
const round2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * Compute average power spectrum across active frames using a 2048-point Hann-windowed FFT.
 */
function computeAveragePowerSpectrum(mono: Float32Array, _sampleRate: number, fftSize = 2048): Float64Array {
  const halfBins = (fftSize >> 1) + 1;
  const avgPower = new Float64Array(halfBins);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  const window = new Float64Array(fftSize);
  for (let i = 0; i < fftSize; i++) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (fftSize - 1)));
  }

  const hop = fftSize >> 1;
  let frameCount = 0;
  for (let start = 0; start + fftSize <= mono.length; start += hop) {
    // Skip near-silent trailing frames when computing active tonal spectrum
    let frameEnergy = 0;
    for (let i = 0; i < fftSize; i++) {
      const s = mono[start + i];
      frameEnergy += s * s;
    }
    if (frameEnergy / fftSize < 1e-7) continue;

    for (let i = 0; i < fftSize; i++) {
      re[i] = mono[start + i] * window[i];
      im[i] = 0;
    }
    fftRadix2(re, im);
    const norm = 1.0 / (fftSize * fftSize);
    for (let b = 0; b < halfBins; b++) {
      avgPower[b] += (re[b] * re[b] + im[b] * im[b]) * norm;
    }
    frameCount++;
  }

  if (frameCount > 0) {
    for (let b = 0; b < halfBins; b++) {
      avgPower[b] /= frameCount;
    }
  }
  return avgPower;
}

/**
 * Estimate fundamental frequency f0 (70Hz..600Hz) via normalized autocorrelation.
 */
export function estimateFundamentalPitchHz(mono: Float32Array, sampleRate: number): number {
  const windowLen = 1024;
  const minLag = Math.max(2, Math.floor(sampleRate / 600));
  const maxLag = Math.min(mono.length >> 1, Math.floor(sampleRate / 65));
  if (maxLag <= minLag || mono.length < windowLen + maxLag) return 140;

  const acc = new Float64Array(maxLag + 1);
  let activeFrames = 0;

  for (let f = Math.floor(sampleRate * 0.05); f + windowLen + maxLag < mono.length; f += 1024) {
    let e0 = 0;
    for (let i = 0; i < windowLen; i++) e0 += mono[f + i] * mono[f + i];
    if (e0 / windowLen < 1e-4) continue;
    activeFrames++;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0;
      for (let i = 0; i < windowLen; i++) {
        s += mono[f + i] * mono[f + i + lag];
      }
      acc[lag] += s / Math.max(1e-6, e0);
    }
  }

  if (activeFrames === 0) return 140;

  let bestLag = Math.round(sampleRate / 140);
  let maxVal = -Infinity;
  let inPositivePeak = false;
  for (let lag = minLag; lag < maxLag; lag++) {
    if (!inPositivePeak && acc[lag] < 0 && acc[lag + 1] >= 0) {
      inPositivePeak = true;
    }
    if (inPositivePeak && acc[lag] > maxVal) {
      maxVal = acc[lag];
      bestLag = lag;
    }
  }

  return round2(sampleRate / bestLag);
}

/**
 * Measure inharmonicity (0..1): ratio of spectral energy between harmonic multiples of f0
 * vs. on harmonic multiples of f0. High values (>0.38) indicate SSB shift or RING modulation.
 */
function computeInharmonicity(powerSpec: Float64Array, sampleRate: number, f0: number): number {
  if (f0 < 60 || f0 > 600) return 0;
  const fftSize = (powerSpec.length - 1) * 2;
  const binHz = sampleRate / fftSize;
  let harmonicEnergy = 0;
  let interHarmonicEnergy = 0;

  const minBin = Math.ceil(100 / binHz);
  const maxBin = Math.min(powerSpec.length - 1, Math.floor(3500 / binHz));

  for (let b = minBin; b <= maxBin; b++) {
    const freq = b * binHz;
    const harmonicIndex = freq / f0;
    const distToNearestHarmonic = Math.abs(harmonicIndex - Math.round(harmonicIndex));
    if (distToNearestHarmonic <= 0.18) {
      harmonicEnergy += powerSpec[b];
    } else if (distToNearestHarmonic >= 0.28) {
      interHarmonicEnergy += powerSpec[b];
    }
  }

  const total = harmonicEnergy + interHarmonicEnergy;
  if (total <= 1e-12) return 0;
  return round2(Math.min(1, interHarmonicEnergy / total));
}

/** Short-time power envelope (mean square per frame) of a mono signal. */
function powerEnvelope(mono: Float32Array, hopSamples: number): Float64Array {
  const n = Math.floor(mono.length / hopSamples);
  const env = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    let sumSq = 0;
    const base = f * hopSamples;
    for (let i = 0; i < hopSamples; i++) {
      const v = mono[base + i] || 0;
      sumSq += v * v;
    }
    env[f] = sumSq / hopSamples;
  }
  return env;
}

const toMono = (pcm: StereoPcmBuffer): Float32Array => {
  const n = Math.min(pcm.left.length, pcm.right.length);
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = ((pcm.left[i] || 0) + (pcm.right[i] || 0)) * 0.5;
  return mono;
};

/**
 * One-pole DC blocker (≈20 Hz high-pass). Effects such as DIST leave a constant DC offset after
 * the signal stops; it is inaudible but would otherwise read as a tail that never decays.
 */
function removeDc(mono: Float32Array, sampleRate: number): Float32Array {
  const r = 1 - (2 * Math.PI * 20) / sampleRate;
  const out = new Float32Array(mono.length);
  let prevX = 0;
  let prevY = 0;
  for (let i = 0; i < mono.length; i++) {
    const y = mono[i] - prevX + r * prevY;
    prevX = mono[i];
    prevY = y;
    out[i] = y;
  }
  return out;
}

const pDb = (p: number): number => 10 * Math.log10(Math.max(1e-14, p));
const median = (values: ArrayLike<number>): number => {
  const sorted = Array.from(values).sort((x, y) => x - y);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
};

const ENV_HOP_SEC = 0.005;
const ECHO_MIN_LAG_SEC = 0.08;
const ECHO_MAX_LAG_SEC = 1.1;
const TAIL_MAX_SEC = 10;
/** Minimum echo/direct level ratio reported as a discrete echo. */
const ECHO_MIN_RATIO = 0.1;

/**
 * RT60-style decay time from Schroeder backward integration of a (floor-subtracted) power
 * envelope: the slope of the energy decay curve between −3 dB and −33 dB is extrapolated to
 * 60 dB. Backward integration copes with the silent gaps between delay repeats. Returns a
 * capped lower bound when the energy barely decays inside the window.
 */
function schroederDecay(post: ArrayLike<number>, hopSec: number): { decaySec: number; isLowerBound: boolean } {
  const n = post.length;
  if (n < 8) return { decaySec: 0, isLowerBound: false };
  const edc = new Float64Array(n);
  let acc = 0;
  for (let i = n - 1; i >= 0; i--) {
    acc += post[i];
    edc[i] = acc;
  }
  if (edc[0] <= 0) return { decaySec: 0, isLowerBound: false };
  const lim = Math.floor(n * 0.9); // the end of the curve is biased by truncation
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  let count = 0;
  for (let i = 0; i < lim; i++) {
    const y = pDb(edc[i] / edc[0]);
    if (y > -3) continue;
    if (y < -33) break;
    const t = i * hopSec;
    sx += t;
    sy += y;
    sxx += t * t;
    sxy += t * y;
    count++;
  }
  if (count < 4) {
    // Never fell 3 dB before the window ended: very long tail.
    return pDb(edc[Math.max(0, lim - 1)] / edc[0]) > -3
      ? { decaySec: TAIL_MAX_SEC, isLowerBound: true }
      : { decaySec: 0, isLowerBound: false };
  }
  const slope = (count * sxy - sx * sy) / Math.max(1e-12, count * sxx - sx * sx); // dB per second
  if (slope > -60 / TAIL_MAX_SEC) return { decaySec: TAIL_MAX_SEC, isLowerBound: true };
  const decaySec = 60 / -slope;
  return decaySec < 0.15 ? { decaySec: 0, isLowerBound: false } : { decaySec: round2(decaySec), isLowerBound: false };
}

/**
 * Tail measured after a dry phrase ends (where the dry reference falls silent; without one,
 * after the last frame within 20 dB of the output's loudest frame). A tail only counts when it
 * starts within 35 dB of the phrase level, which also rejects steady hiss such as distortion noise.
 */
function estimatePhraseTail(
  mono: Float32Array,
  sampleRate: number,
  dryMono?: Float32Array
): { tailDb: number; decaySec: number; isLowerBound: boolean } {
  const hop = Math.max(1, Math.floor(sampleRate * ENV_HOP_SEC));
  const wet = powerEnvelope(removeDc(mono, sampleRate), hop);
  const n = wet.length;
  const none = { tailDb: -120, decaySec: 0, isLowerBound: false };
  if (n < 16) return none;

  let end = -1;
  if (dryMono) {
    const dry = powerEnvelope(dryMono, hop);
    let dryPeak = 0;
    for (const v of dry) dryPeak = Math.max(dryPeak, v);
    for (let f = Math.min(n, dry.length) - 1; f >= 0; f--) {
      if (pDb(dry[f]) > pDb(dryPeak) - 45) {
        end = f;
        break;
      }
    }
  } else {
    let wetPeak = 0;
    for (const v of wet) wetPeak = Math.max(wetPeak, v);
    for (let f = n - 1; f >= 0; f--) {
      if (pDb(wet[f]) > pDb(wetPeak) - 20) {
        end = f;
        break;
      }
    }
  }
  const start = end + 4; // skip the release of the last syllable (20 ms)
  if (end < 0 || n - start < 16) return none;

  let phrase = 0;
  for (let f = 0; f <= end; f++) phrase += wet[f];
  phrase /= end + 1;
  // No floor subtraction here: in a short window a long delay tail would be mistaken for the
  // floor. Steady hiss (e.g. distortion) is rejected by the 35 dB rule below instead.
  const post = Array.from(wet.subarray(start));
  let head = 0;
  for (let i = 0; i < Math.min(10, post.length); i++) head += post[i];
  head /= Math.min(10, post.length);
  const tailDb = round2(pDb(head));
  if (head <= 0 || pDb(head) < pDb(phrase) - 35) return { tailDb, decaySec: 0, isLowerBound: false };
  return { tailDb, ...schroederDecay(post, ENV_HOP_SEC) };
}

/**
 * Echo lag (ms) and strength from envelope correlation. With a dry reference the scaled dry
 * envelope is removed first. Only meaningful when the output actually has a tail; callers gate
 * on that, because rhythm in the source (e.g. syllables every 400 ms) also correlates.
 */
function estimateEchoLag(
  mono: Float32Array,
  sampleRate: number,
  dryMono?: Float32Array
): { delayMs: number | null; strength: number } {
  const hopSamples = Math.max(1, Math.floor(sampleRate * ENV_HOP_SEC));
  const wetEnv = Array.from(powerEnvelope(mono, hopSamples), Math.sqrt);
  const numEnvFrames = wetEnv.length;
  if (numEnvFrames < 40) return { delayMs: null, strength: 0 };
  const dryEnv = new Float64Array(numEnvFrames);
  if (dryMono) {
    const d = powerEnvelope(dryMono, hopSamples);
    for (let f = 0; f < numEnvFrames && f < d.length; f++) dryEnv[f] = Math.sqrt(d[f]);
  }
  const maxWet = Math.max(...wetEnv);
  if (maxWet < 1e-5) return { delayMs: null, strength: 0 };
  const minLag = Math.round(ECHO_MIN_LAG_SEC / ENV_HOP_SEC);
  const maxLag = Math.min(numEnvFrames - 10, Math.round(ECHO_MAX_LAG_SEC / ENV_HOP_SEC));

  if (dryMono) {
    let dot0 = 0;
    let dryE = 0;
    for (let f = 0; f < numEnvFrames; f++) {
      dot0 += wetEnv[f] * dryEnv[f];
      dryE += dryEnv[f] * dryEnv[f];
    }
    if (dryE < 1e-12) return { delayMs: null, strength: 0 };
    const directGain = dot0 / dryE;
    const residual = new Float64Array(numEnvFrames);
    let resE = 0;
    for (let f = 0; f < numEnvFrames; f++) {
      residual[f] = Math.max(0, wetEnv[f] - dryEnv[f] * directGain * 0.92);
      resE += residual[f] * residual[f];
    }
    const normDenom = Math.sqrt(dryE * Math.max(1e-9, resE));
    if (normDenom < 1e-7) return { delayMs: null, strength: 0 };
    const corrByLag = new Float64Array(maxLag + 1);
    let bestLag = -1;
    let bestCorr = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let c = 0;
      for (let f = 0; f + lag < numEnvFrames; f++) c += dryEnv[f] * residual[f + lag];
      corrByLag[lag] = c / normDenom;
      if (corrByLag[lag] > bestCorr) {
        bestCorr = corrByLag[lag];
        bestLag = lag;
      }
    }
    if (bestLag >= minLag * 2) {
      const halfLag = Math.round(bestLag / 2);
      for (let l = Math.max(minLag, halfLag - 3); l <= Math.min(maxLag, halfLag + 3); l++) {
        if (corrByLag[l] >= bestCorr * 0.78) {
          bestLag = l;
          bestCorr = corrByLag[l];
          break;
        }
      }
    }
    if (bestLag < 0 || bestCorr < 0.14) return { delayMs: null, strength: round2(Math.max(0, bestCorr)) };
    return { delayMs: Math.round(bestLag * ENV_HOP_SEC * 1000), strength: round2(Math.min(1, bestCorr)) };
  }

  let mean = 0;
  for (const v of wetEnv) mean += v;
  mean /= numEnvFrames;
  let energy0 = 0;
  for (let f = 0; f < numEnvFrames; f++) {
    wetEnv[f] = Math.max(0, wetEnv[f] - mean * 0.6);
    energy0 += wetEnv[f] * wetEnv[f];
  }
  if (energy0 < 1e-8) return { delayMs: null, strength: 0 };
  let bestLag = -1;
  let bestCorr = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    for (let f = 0; f + lag < numEnvFrames; f++) corr += wetEnv[f] * wetEnv[f + lag];
    if (corr / energy0 > bestCorr) {
      bestCorr = corr / energy0;
      bestLag = lag;
    }
  }
  if (bestLag < 0 || bestCorr < 0.14) return { delayMs: null, strength: round2(Math.max(0, bestCorr)) };
  return { delayMs: Math.round(bestLag * ENV_HOP_SEC * 1000), strength: round2(Math.min(1, bestCorr)) };
}

/** Echo and decay measured from a probe render (see {@link analyzeImpulseResponse}). */
export interface ImpulseMeasurement {
  delayMs: number | null;
  echoStrength: number;
  tailDecaySec: number;
  tailDecayIsLowerBound: boolean;
}

/**
 * A 40 ms band-limited noise burst followed by silence, used as a measurement signal: rendered
 * through a preset it behaves like an impulse response, so echoes show up as isolated repeats of
 * the burst and the decay can be read directly, with no rhythm in the source to confuse them.
 */
export function generateImpulseProbePcm(sampleRate = 48000, totalSec = 2.4): StereoPcmBuffer {
  const n = Math.round(sampleRate * totalSec);
  const burst = Math.round(sampleRate * 0.04);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  let seed = 0x2350;
  let lp = 0;
  for (let i = 0; i < burst; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    lp += 0.35 * ((seed / 4294967296) * 2 - 1 - lp);
    const v = lp * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (burst - 1))) * 0.9;
    left[i] = v;
    right[i] = v;
  }
  return { sampleRate, left, right, durationSec: totalSec };
}

/**
 * Measure the first discrete echo (delay time and echo/direct level ratio) and the RT60-style
 * decay of a rendered impulse probe. An echo is the first local peak at least 6 dB above the
 * preceding valley, 80–1100 ms after the burst, with a level ratio of at least 0.1 (diffuse
 * reverb bumps are far weaker); its lag is refined by correlating with the direct burst.
 */
export function analyzeImpulseResponse(wet: StereoPcmBuffer): ImpulseMeasurement {
  const hop = Math.max(1, Math.floor(wet.sampleRate * ENV_HOP_SEC));
  const w = powerEnvelope(removeDc(toMono(wet), wet.sampleRate), hop);
  const n = w.length;
  const burstF = Math.ceil((wet.sampleRate * 0.04) / hop);
  const none: ImpulseMeasurement = { delayMs: null, echoStrength: 0, tailDecaySec: 0, tailDecayIsLowerBound: false };
  if (n < burstF + 20) return none;

  let direct = 0;
  let peakF = 0;
  for (let f = 0; f <= burstF + 1; f++) {
    direct += w[f];
    if (w[f] > w[peakF]) peakF = f;
  }
  if (direct <= 0) return none;
  // Noise floor from the end of the window. If the output after the burst is no louder early on
  // than at the end, it is a steady floor (e.g. distortion hiss) and is removed entirely;
  // otherwise it is a tail still ringing, so only a floor far below the burst is removed.
  const endLevel = median(w.subarray(Math.floor(n * 0.85)));
  const postStart = burstF + 2;
  const halfEnd = postStart + Math.floor((n - postStart) / 2);
  const earlyLevel = median(w.subarray(postStart, Math.max(postStart + 1, halfEnd)));
  const isSteadyFloor = earlyLevel <= endLevel * 2;
  const floor = isSteadyFloor ? endLevel : Math.min(endLevel, w[peakF] * 1e-5);
  const smooth = new Float64Array(n);
  for (let f = 0; f < n; f++) smooth[f] = (w[Math.max(0, f - 1)] + w[f] + w[Math.min(n - 1, f + 1)]) / 3;

  const minLag = Math.round(ECHO_MIN_LAG_SEC / ENV_HOP_SEC);
  const maxLag = Math.round(ECHO_MAX_LAG_SEC / ENV_HOP_SEC);
  let delayMs: number | null = null;
  let echoStrength = 0;
  let valley = Infinity;
  for (let f = burstF + 2; f < Math.min(n - 1, peakF + maxLag + 1); f++) {
    valley = Math.min(valley, smooth[f]);
    if (f - peakF < minLag) continue;
    const isPeak = smooth[f] >= smooth[f - 1] && smooth[f] >= smooth[f + 1];
    if (!isPeak || smooth[f] <= floor * 4) continue;
    if (pDb(smooth[f]) - pDb(Math.max(valley, floor)) < 6) continue;
    // Refine the lag and measure the repeat's energy against the direct burst
    let lag = f - peakF;
    let bestC = -1;
    for (let l = Math.max(minLag, lag - 6); l <= lag + 6; l++) {
      let c = 0;
      for (let k = 0; k <= burstF + 1; k++) c += w[k] * (w[k + l] || 0);
      if (c > bestC) {
        bestC = c;
        lag = l;
      }
    }
    let repeat = 0;
    for (let k = 0; k <= burstF + 1; k++) repeat += w[k + lag] || 0;
    const ratio = Math.sqrt(repeat / direct);
    if (ratio >= ECHO_MIN_RATIO) {
      delayMs = Math.round(lag * ENV_HOP_SEC * 1000);
      echoStrength = round2(Math.min(1, ratio));
      break;
    }
    valley = smooth[f]; // weak bump (e.g. reverb): keep scanning past it
  }

  // Feedback delay: the response is a staircase of discrete repeats, where a straight-line fit of
  // the Schroeder curve is unreliable. With two or more repeats inside the window, extrapolate
  // the per-repeat level drop to 60 dB instead.
  if (delayMs !== null) {
    const lagF = Math.round(delayMs / 1000 / ENV_HOP_SEC);
    const repeats: number[] = [];
    for (let k = 1; k * lagF + burstF + 1 < n; k++) {
      let e = 0;
      for (let j = 0; j <= burstF + 1; j++) e += Math.max(0, w[peakF - Math.floor(burstF / 2) + k * lagF + j] - floor || 0);
      repeats.push(e);
    }
    if (repeats.length >= 2 && repeats[0] > 0) {
      const dropDb = pDb(Math.max(repeats[1], repeats[0] * 1e-6)) - pDb(repeats[0]); // dB per repeat (≤ 0)
      const lagSec = delayMs / 1000;
      if (dropDb >= -0.5) return { delayMs, echoStrength, tailDecaySec: TAIL_MAX_SEC, tailDecayIsLowerBound: true };
      if (dropDb <= -40) return { delayMs, echoStrength, tailDecaySec: 0, tailDecayIsLowerBound: false }; // single echo, no feedback
      const rt = (lagSec * 60) / -dropDb;
      return {
        delayMs,
        echoStrength,
        tailDecaySec: rt >= TAIL_MAX_SEC ? TAIL_MAX_SEC : rt < 0.15 ? 0 : round2(rt),
        tailDecayIsLowerBound: rt >= TAIL_MAX_SEC
      };
    }
  }

  const post = Array.from(w.subarray(burstF + 2), (v) => Math.max(0, v - floor));
  let postEnergy = 0;
  for (const v of post) postEnergy += v;
  const decay =
    postEnergy > direct * 1e-3 ? schroederDecay(post, ENV_HOP_SEC) : { decaySec: 0, isLowerBound: false };
  return { delayMs, echoStrength, tailDecaySec: decay.decaySec, tailDecayIsLowerBound: decay.isLowerBound };
}

/**
 * Analyze a stereo PCM buffer and return a comprehensive acoustic report + inferred effect cues.
 */
export function analyzePcmAudio(
  pcm: StereoPcmBuffer,
  dryReferencePcm?: StereoPcmBuffer,
  /** Echo/decay measured from an impulse-probe render; overrides the phrase-based estimates. */
  impulse?: ImpulseMeasurement
): AudioAnalysisReport {
  const { sampleRate, left, right } = pcm;
  const numFrames = Math.min(left.length, right.length);
  const mono = new Float32Array(numFrames);

  let sumSq = 0;
  let sumSqL = 0;
  let sumSqR = 0;
  let peak = 0;

  for (let i = 0; i < numFrames; i++) {
    const l = left[i] || 0;
    const r = right[i] || 0;
    const m = (l + r) * 0.5;
    mono[i] = m;
    sumSq += m * m;
    sumSqL += l * l;
    sumSqR += r * r;
    const absMax = Math.max(Math.abs(l), Math.abs(r));
    if (absMax > peak) peak = absMax;
  }

  const rms = Math.sqrt(sumSq / Math.max(1, numFrames));
  const rmsDb = round2(linToDb(rms));
  const peakDb = round2(linToDb(peak));
  const crestFactorDb = round2(Math.max(0, peakDb - rmsDb));

  const rmsL = Math.sqrt(sumSqL / Math.max(1, numFrames));
  const rmsR = Math.sqrt(sumSqR / Math.max(1, numFrames));
  const stereoBalance =
    rmsL + rmsR > 1e-6 ? round2((rmsR - rmsL) / (rmsL + rmsR)) : 0;

  // Spectral analysis via 2048-point FFT
  const fftSize = 2048;
  const powerSpec = computeAveragePowerSpectrum(mono, sampleRate, fftSize);
  const binHz = sampleRate / fftSize;

  let weightedFreqSum = 0;
  let totalSpecPower = 0;
  let logPowerSum = 0;
  let activeBins = 0;

  const bandPower = {
    subBass: 0,
    bass: 0,
    lowMid: 0,
    highMid: 0,
    presence: 0,
    air: 0
  };

  for (let b = 1; b < powerSpec.length; b++) {
    const freq = b * binHz;
    if (freq > 18000) break;
    const p = powerSpec[b];
    weightedFreqSum += freq * p;
    totalSpecPower += p;
    if (freq >= 60 && freq <= 12000) {
      logPowerSum += Math.log(Math.max(1e-15, p));
      activeBins++;
    }

    if (freq >= 20 && freq < 80) bandPower.subBass += p;
    else if (freq >= 80 && freq < 250) bandPower.bass += p;
    else if (freq >= 250 && freq < 800) bandPower.lowMid += p;
    else if (freq >= 800 && freq < 2500) bandPower.highMid += p;
    else if (freq >= 2500 && freq < 6000) bandPower.presence += p;
    else if (freq >= 6000 && freq <= 18000) bandPower.air += p;
  }

  const spectralCentroidHz =
    totalSpecPower > 1e-12 ? Math.round(weightedFreqSum / totalSpecPower) : 0;

  // 85% Spectral Rolloff
  let cumPower = 0;
  let spectralRolloff85Hz = 0;
  for (let b = 1; b < powerSpec.length; b++) {
    cumPower += powerSpec[b];
    if (cumPower >= totalSpecPower * 0.85) {
      spectralRolloff85Hz = Math.round(b * binHz);
      break;
    }
  }

  const geomMean = activeBins > 0 ? Math.exp(logPowerSum / activeBins) : 0;
  const arithMean = activeBins > 0 ? totalSpecPower / activeBins : 1;
  const spectralFlatness = round2(Math.min(1, geomMean / Math.max(1e-15, arithMean)));

  const bandsDb: SpectralBandsDb = {
    subBassDb: round2(powToDb(bandPower.subBass)),
    bassDb: round2(powToDb(bandPower.bass)),
    lowMidDb: round2(powToDb(bandPower.lowMid)),
    highMidDb: round2(powToDb(bandPower.highMid)),
    presenceDb: round2(powToDb(bandPower.presence)),
    airDb: round2(powToDb(bandPower.air))
  };

  // Pitch & inharmonicity
  const fundamentalHz = estimateFundamentalPitchHz(mono, sampleRate);
  let refF0 = 140;
  let dryMono: Float32Array | undefined;
  if (dryReferencePcm) {
    const dryLen = Math.min(dryReferencePcm.left.length, dryReferencePcm.right.length);
    dryMono = new Float32Array(dryLen);
    for (let i = 0; i < dryLen; i++) {
      dryMono[i] = (dryReferencePcm.left[i] + dryReferencePcm.right[i]) * 0.5;
    }
    refF0 = estimateFundamentalPitchHz(dryMono, dryReferencePcm.sampleRate);
  }
  const estimatedPitchRatio = round2(fundamentalHz / Math.max(40, refF0));
  const estimatedSemitones = round2(12 * Math.log2(Math.max(0.25, estimatedPitchRatio)));
  const inharmonicityScore = computeInharmonicity(powerSpec, sampleRate, fundamentalHz);

  const phraseTail = estimatePhraseTail(mono, sampleRate, dryMono);
  const tail = impulse
    ? { tailDb: phraseTail.tailDb, decaySec: impulse.tailDecaySec, isLowerBound: impulse.tailDecayIsLowerBound }
    : phraseTail;
  // A real echo leaves energy after the phrase ends; without a tail, correlation peaks are just
  // rhythm in the source, so they are not reported.
  const phraseEcho =
    phraseTail.decaySec > 0 ? estimateEchoLag(mono, sampleRate, dryMono) : { delayMs: null, strength: 0 };
  const echo = impulse ? { delayMs: impulse.delayMs, strength: impulse.echoStrength } : phraseEcho;
  const tailRmsDb = tail.tailDb;
  const estimatedTailDecaySec = tail.decaySec;
  const isBlindEstimate = !dryMono && !impulse;
  const blindNote = isBlindEstimate ? ' (blind estimate: pass the dry recording for accuracy)' : '';

  // Generate human/AI diagnostic cues
  const inferredCues: string[] = [];
  if (rmsDb < -55) {
    inferredCues.push('Output is nearly silent (RMS < -55 dB); verify SAMPLE block or dry/wet levels.');
  }
  if (bandsDb.bassDb < bandsDb.highMidDb - 14) {
    inferredCues.push(
      `Low frequencies are strongly attenuated (bass ${bandsDb.bassDb} dB vs high-mid ${bandsDb.highMidDb} dB) -> indicates HIGHPASS filter.`
    );
  }
  if (spectralRolloff85Hz > 0 && spectralRolloff85Hz < 1600) {
    inferredCues.push(
      `85% spectral roll-off is dark (${spectralRolloff85Hz} Hz) -> indicates LOWPASS filter.`
    );
  }
  if (crestFactorDb < 8.5 && rmsDb > -35) {
    inferredCues.push(
      `Compressed crest factor (${crestFactorDb} dB) with rich upper harmonics -> indicates DIST distortion.`
    );
  }
  if (Math.abs(estimatedSemitones) >= 2.0 && inharmonicityScore < 0.35) {
    inferredCues.push(
      `Fundamental pitch shifted by ${estimatedSemitones > 0 ? '+' : ''}${estimatedSemitones} st (${estimatedPitchRatio}x) -> indicates HARMONY or SAMPLE pitch shift.`
    );
  }
  if (inharmonicityScore >= 0.35) {
    inferredCues.push(
      `Elevated inharmonic sidebands (${inharmonicityScore}) -> indicates SSB frequency shifter or RING modulator.`
    );
  }
  const hasEcho = echo.delayMs !== null && echo.strength >= ECHO_MIN_RATIO;
  if (hasEcho) {
    inferredCues.push(
      `Discrete echo at ~${echo.delayMs} ms (echo/direct ratio ${echo.strength})${blindNote} -> indicates DELAY (time ~${((echo.delayMs as number) / 1000).toFixed(2)}s).`
    );
  }
  if (estimatedTailDecaySec >= 0.3) {
    const decayText = tail.isLowerBound ? `>${estimatedTailDecaySec}s` : `~${estimatedTailDecaySec}s`;
    inferredCues.push(
      `Tail continues after the phrase ends (RT60 ${decayText}, starts ${round2(rmsDb - tailRmsDb)} dB below the phrase level)${blindNote} -> indicates ${
        hasEcho ? 'DELAY feedback (echo) and/or REVERB' : 'REVERB'
      }.`
    );
  }
  if (Math.abs(stereoBalance) >= 0.15) {
    inferredCues.push(
      `Stereo image panned ${stereoBalance < 0 ? 'LEFT' : 'RIGHT'} (${stereoBalance}) -> indicates BALANCE or DELAY/SAMPLE pan.`
    );
  }

  return {
    durationSec: round2(numFrames / sampleRate),
    sampleRate,
    rmsDb,
    peakDb,
    crestFactorDb,
    stereoBalance,
    isSilent: rmsDb < -55,
    isClipping: peakDb >= -0.45,
    spectralCentroidHz,
    spectralRolloff85Hz,
    spectralFlatness,
    bandsDb,
    fundamentalHz,
    estimatedPitchRatio,
    estimatedSemitones,
    inharmonicityScore,
    tailRmsDb,
    estimatedTailDecaySec,
    tailDecayIsLowerBound: tail.isLowerBound,
    estimatedDelayMs: echo.delayMs,
    echoStrength: echo.strength,
    isBlindEstimate,
    inferredCues
  };
}

/**
 * Multi-Resolution STFT + Temporal Envelope + Spectral Band distance metric
 * between a target reference buffer and a candidate rendered buffer.
 */
export function computeAudioDistance(
  targetPcm: StereoPcmBuffer,
  candidatePcm: StereoPcmBuffer
): AudioDistanceResult {
  const len = Math.min(
    targetPcm.left.length,
    targetPcm.right.length,
    candidatePcm.left.length,
    candidatePcm.right.length
  );

  const monoT = new Float32Array(len);
  const monoC = new Float32Array(len);
  let sumSqLT = 0;
  let sumSqRT = 0;
  let sumSqLC = 0;
  let sumSqRC = 0;

  for (let i = 0; i < len; i++) {
    const lt = targetPcm.left[i] || 0;
    const rt = targetPcm.right[i] || 0;
    const lc = candidatePcm.left[i] || 0;
    const rc = candidatePcm.right[i] || 0;
    monoT[i] = (lt + rt) * 0.5;
    monoC[i] = (lc + rc) * 0.5;
    sumSqLT += lt * lt;
    sumSqRT += rt * rt;
    sumSqLC += lc * lc;
    sumSqRC += rc * rc;
  }

  // 1. Multi-resolution log-spectrum distance (FFT sizes 512 and 2048)
  const specT512 = computeAveragePowerSpectrum(monoT, targetPcm.sampleRate, 512);
  const specC512 = computeAveragePowerSpectrum(monoC, candidatePcm.sampleRate, 512);
  const specT2048 = computeAveragePowerSpectrum(monoT, targetPcm.sampleRate, 2048);
  const specC2048 = computeAveragePowerSpectrum(monoC, candidatePcm.sampleRate, 2048);

  const calcSpecDiff = (sT: Float64Array, sC: Float64Array, fftSize: number) => {
    let diffSum = 0;
    const maxBin = Math.min(sT.length, Math.ceil((14000 * fftSize) / targetPcm.sampleRate));
    for (let b = 1; b < maxBin; b++) {
      const logT = Math.log10(Math.max(1e-10, sT[b]));
      const logC = Math.log10(Math.max(1e-10, sC[b]));
      diffSum += Math.abs(logT - logC);
    }
    return diffSum / Math.max(1, maxBin - 1);
  };

  const spectralLoss =
    0.5 * (calcSpecDiff(specT512, specC512, 512) + calcSpecDiff(specT2048, specC2048, 2048));

  // 2. Temporal RMS envelope distance (20ms frames across the phrase + echo/reverb tail)
  const envHop = Math.max(1, Math.floor(targetPcm.sampleRate * 0.02));
  const numEnv = Math.floor(len / envHop);
  let envDiffSum = 0;
  for (let f = 0; f < numEnv; f++) {
    let sqT = 0;
    let sqC = 0;
    const base = f * envHop;
    for (let i = 0; i < envHop; i++) {
      sqT += monoT[base + i] * monoT[base + i];
      sqC += monoC[base + i] * monoC[base + i];
    }
    const dbT = 10 * Math.log10(Math.max(1e-8, sqT / envHop));
    const dbC = 10 * Math.log10(Math.max(1e-8, sqC / envHop));
    envDiffSum += Math.abs(dbT - dbC) / 20.0;
  }
  const envelopeLoss = envDiffSum / Math.max(1, numEnv);

  // 3. Macro 6-band distance from 2048-point spectrum + stereo balance distance
  const binHz = targetPcm.sampleRate / 2048;
  const bandRanges = [
    [20, 80],
    [80, 250],
    [250, 800],
    [800, 2500],
    [2500, 6000],
    [6000, 18000]
  ];
  let bandLoss = 0;
  for (const [fMin, fMax] of bandRanges) {
    let pT = 0;
    let pC = 0;
    const bStart = Math.max(1, Math.floor(fMin / binHz));
    const bEnd = Math.min(specT2048.length - 1, Math.ceil(fMax / binHz));
    for (let b = bStart; b <= bEnd; b++) {
      pT += specT2048[b];
      pC += specC2048[b];
    }
    bandLoss += Math.abs(powToDb(pT) - powToDb(pC)) / 25.0;
  }
  bandLoss /= bandRanges.length;

  const balT =
    sumSqLT + sumSqRT > 1e-9
      ? (Math.sqrt(sumSqRT) - Math.sqrt(sumSqLT)) / (Math.sqrt(sumSqRT) + Math.sqrt(sumSqLT))
      : 0;
  const balC =
    sumSqLC + sumSqRC > 1e-9
      ? (Math.sqrt(sumSqRC) - Math.sqrt(sumSqLC)) / (Math.sqrt(sumSqRC) + Math.sqrt(sumSqLC))
      : 0;
  const stereoLoss = Math.abs(balT - balC);

  const totalLoss = round2(
    spectralLoss * 0.45 + envelopeLoss * 0.32 + bandLoss * 0.15 + stereoLoss * 0.08
  );

  // Convert totalLoss into intuitive 0..100% similarity score
  const similarityScore = round2(Math.max(0, Math.min(100, 100 * Math.exp(-totalLoss * 0.85))));

  return {
    totalLoss,
    spectralLoss: round2(spectralLoss),
    envelopeLoss: round2(envelopeLoss),
    bandLoss: round2(bandLoss),
    stereoLoss: round2(stereoLoss),
    similarityScore
  };
}
