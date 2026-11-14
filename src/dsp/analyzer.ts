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
  tailRmsDb: number;
  estimatedTailDecaySec: number;
  estimatedDelayMs: number | null;
  echoStrength: number; // 0..1
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

/**
 * Estimate echo delay lag (ms) and echo strength (0..1) from amplitude envelope autocorrelation.
 * If `dryMono` is provided, cross-correlates the residual wet envelope against the dry envelope
 * for sharp delay-time localization even on rhythmic vocal phrases.
 */
function estimateEchoLag(
  mono: Float32Array,
  sampleRate: number,
  dryMono?: Float32Array
): { delayMs: number | null; strength: number } {
  const hopSamples = Math.max(1, Math.floor(sampleRate * 0.005)); // 5ms envelope resolution
  const numEnvFrames = Math.floor(mono.length / hopSamples);
  if (numEnvFrames < 40) return { delayMs: null, strength: 0 };

  const wetEnv = new Float64Array(numEnvFrames);
  const dryEnv = new Float64Array(numEnvFrames);
  let maxWet = 0;
  let maxDry = 0;

  for (let f = 0; f < numEnvFrames; f++) {
    let sumSqW = 0;
    let sumSqD = 0;
    const base = f * hopSamples;
    for (let i = 0; i < hopSamples; i++) {
      const s = mono[base + i] || 0;
      sumSqW += s * s;
      if (dryMono && base + i < dryMono.length) {
        const d = dryMono[base + i] || 0;
        sumSqD += d * d;
      }
    }
    wetEnv[f] = Math.sqrt(sumSqW / hopSamples);
    if (wetEnv[f] > maxWet) maxWet = wetEnv[f];
    if (dryMono) {
      dryEnv[f] = Math.sqrt(sumSqD / hopSamples);
      if (dryEnv[f] > maxDry) maxDry = dryEnv[f];
    }
  }

  if (maxWet < 1e-5) return { delayMs: null, strength: 0 };

  // Search lags between 80ms and 1100ms (16 .. 220 frames at 5ms resolution)
  const minLag = Math.max(16, Math.floor(0.08 / 0.005));
  const maxLag = Math.min(numEnvFrames - 10, Math.ceil(1.1 / 0.005));

  // If dry reference is available, subtract scaled dry envelope so only delayed echo repeats remain,
  // then cross-correlate dryEnv[f] against residualEchoEnv[f + lag]
  if (dryMono && maxDry > 1e-5) {
    // Estimate direct pass-through gain at lag=0
    let dot0 = 0;
    let dryE = 0;
    for (let f = 0; f < numEnvFrames; f++) {
      dot0 += wetEnv[f] * dryEnv[f];
      dryE += dryEnv[f] * dryEnv[f];
    }
    const directGain = dryE > 1e-9 ? dot0 / dryE : 0;
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
      for (let f = 0; f + lag < numEnvFrames; f++) {
        c += dryEnv[f] * residual[f + lag];
      }
      const normC = c / normDenom;
      corrByLag[lag] = normC;
      if (normC > bestCorr) {
        bestCorr = normC;
        bestLag = lag;
      }
    }

    // Prefer fundamental echo lag over 2x harmonic lag if a strong local peak exists at lag/2
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

    if (bestLag < 0 || bestCorr < 0.14) {
      return { delayMs: null, strength: round2(Math.max(0, bestCorr)) };
    }
    return {
      delayMs: Math.round(bestLag * 5),
      strength: round2(Math.min(1, bestCorr))
    };
  }

  // Blind envelope autocorrelation (when no dry reference is provided)
  let mean = 0;
  for (let f = 0; f < numEnvFrames; f++) mean += wetEnv[f];
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
    for (let f = 0; f + lag < numEnvFrames; f++) {
      corr += wetEnv[f] * wetEnv[f + lag];
    }
    const normCorr = corr / energy0;
    if (normCorr > bestCorr) {
      bestCorr = normCorr;
      bestLag = lag;
    }
  }

  if (bestLag < 0 || bestCorr < 0.14) {
    return { delayMs: null, strength: round2(Math.max(0, bestCorr)) };
  }

  return {
    delayMs: Math.round(bestLag * 5),
    strength: round2(Math.min(1, bestCorr))
  };
}

/**
 * Analyze a stereo PCM buffer and return a comprehensive acoustic report + inferred effect cues.
 */
export function analyzePcmAudio(
  pcm: StereoPcmBuffer,
  dryReferencePcm?: StereoPcmBuffer
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

  // Tail energy (last 28% of buffer)
  const tailStart = Math.floor(numFrames * 0.72);
  let tailSumSq = 0;
  for (let i = tailStart; i < numFrames; i++) {
    tailSumSq += mono[i] * mono[i];
  }
  const tailRms = Math.sqrt(tailSumSq / Math.max(1, numFrames - tailStart));
  const tailRmsDb = round2(linToDb(tailRms));

  // Estimate tail decay (RT60 approximation from active vs tail drop)
  const tailDropDb = Math.max(0.1, rmsDb - tailRmsDb);
  const tailDuration = ((numFrames - tailStart) / sampleRate) * 2.0;
  const estimatedTailDecaySec =
    tailRmsDb > -52 ? round2(Math.min(6.0, (tailDuration * 40) / tailDropDb)) : 0;

  const echo = estimateEchoLag(mono, sampleRate, dryMono);

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
  if (echo.delayMs !== null && echo.strength >= 0.18) {
    inferredCues.push(
      `Periodic echo peak detected at ~${echo.delayMs} ms (strength ${echo.strength}) -> indicates DELAY (time ~${(echo.delayMs / 1000).toFixed(2)}s).`
    );
  }
  if (tailRmsDb > -42 && estimatedTailDecaySec >= 0.4) {
    inferredCues.push(
      `Sustained post-phrase tail (${tailRmsDb} dB, decay ~${estimatedTailDecaySec}s) -> indicates REVERB or high-feedback DELAY.`
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
    estimatedDelayMs: echo.delayMs,
    echoStrength: echo.strength,
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
