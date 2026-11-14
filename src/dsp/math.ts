/**
 * Pure, side-effect-free DSP math used by the Web Audio engine.
 * Everything here is deterministic and unit-testable without an AudioContext.
 */
import { getModDepthConfig } from '../constants/effectsRegistry';

export type LfoShape = 'sine' | 'square' | 'sawtooth' | 'random' | string;

/** Map a normalized cutoff (0.0..1.0) to Hz on a log scale (20 Hz .. 20 kHz). */
export function cutoffToHz(normalized: number): number {
  const n = Math.max(0, Math.min(1, normalized));
  return 20 * Math.pow(1000, n);
}

/** Evaluate an LFO waveform in the range [-1, 1] at `time` seconds for `speed` Hz and `phaseOffset` (0..1). */
export function computeLfoWave(shape: LfoShape, time: number, speed: number, phaseOffset: number = 0): number {
  const offset = typeof phaseOffset === 'number' && !Number.isNaN(phaseOffset) ? phaseOffset : 0;
  const cycles = time * speed + offset;
  const phase = cycles - Math.floor(cycles);
  if (shape === 'square') {
    return phase < 0.5 ? 1 : -1;
  }
  if (shape === 'sawtooth') {
    return 2 * (phase - Math.floor(phase + 0.5));
  }
  if (shape === 'random') {
    // Deterministic sample-and-hold step per cycle
    const stepIndex = Math.floor(cycles);
    const x = Math.sin(stepIndex * 12.9898 + 78.233) * 43758.5453;
    return (x - Math.floor(x)) * 2 - 1;
  }
  return Math.sin(phase * 2 * Math.PI);
}

/**
 * Convert a UI modulation depth into the delta unit the DSP engine applies.
 * - Normalized [0..1] params store depth as -100..+100 (%) in UI -> returns -1..+1.
 * - Native-unit params (Hz, st, x, s) are returned unchanged.
 *
 * Fixes the old `Math.abs(depth) > 1.5 ? depth / 100 : depth` heuristic, which applied
 * a 1% depth as 100%.
 */
export function resolveModDepth(effectType: string | undefined, param: string | undefined, uiDepth: number): number {
  if (typeof uiDepth !== 'number' || Number.isNaN(uiDepth)) return 0;
  const cfg = getModDepthConfig(effectType, param);
  return cfg.isNormalizedPercent ? uiDepth / 100 : uiDepth;
}

/** Waveshaper curve for DIST. Even amount = 0 has base saturation (k = 12). */
export function makeDistortionCurve(amount: number, nSamples = 44100): Float32Array {
  const k = 12 + Math.max(0, amount) * 4;
  const curve = new Float32Array(nSamples);
  const deg = Math.PI / 180;
  for (let i = 0; i < nSamples; ++i) {
    const x = (i * 2) / nSamples - 1;
    curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}

/** tanh soft-clip curve used inside the DELAY feedback loop (unity small-signal gain). */
export function makeSoftClipCurve(nSamples = 8192): Float32Array {
  const curve = new Float32Array(nSamples);
  for (let i = 0; i < nSamples; ++i) {
    const x = (i * 2) / nSamples - 1;
    curve[i] = Math.tanh(x);
  }
  return curve;
}

/** Hann window value at grain phase p (0..1). */
export function hann(p: number): number {
  return 0.5 * (1.0 - Math.cos(2.0 * Math.PI * p));
}

/**
 * Hardware-accurate RP2350 pre-chain Noise Gate kernel (`noisegate` stage in `fx.timing()`).
 * Uses an envelope follower with hysteresis (open threshold vs close threshold) to suppress
 * background mic noise before high-gain effects like `DIST` (up to 40x) and `DELAY`.
 */
export class NoiseGateKernel {
  private readonly openThreshold: number;
  private readonly closeThreshold: number;
  private readonly attackCoeff: number;
  private readonly releaseCoeff: number;
  private readonly gainAttackCoeff: number;
  private readonly gainReleaseCoeff: number;
  private readonly floorGain: number;
  private env = 0;
  private gateGain = 1.0;
  private isOpen = true;

  constructor(
    sampleRate = 48000,
    openThresholdDb = -46,
    closeThresholdDb = -52,
    floorGain = 0.05
  ) {
    const sr = sampleRate > 0 ? sampleRate : 48000;
    this.openThreshold = Math.pow(10, openThresholdDb / 20);
    this.closeThreshold = Math.pow(10, closeThresholdDb / 20);
    this.floorGain = Math.max(0, Math.min(1, floorGain));
    this.attackCoeff = Math.exp(-1.0 / (0.002 * sr));
    this.releaseCoeff = Math.exp(-1.0 / (0.06 * sr));
    this.gainAttackCoeff = Math.exp(-1.0 / (0.003 * sr));
    this.gainReleaseCoeff = Math.exp(-1.0 / (0.08 * sr));
  }

  getGain(): number {
    return this.gateGain;
  }

  process(input: Float32Array, output: Float32Array): void {
    const len = input.length;
    for (let i = 0; i < len; i++) {
      const x = input[i];
      const absX = Math.abs(x);
      if (absX > this.env) {
        this.env = this.attackCoeff * this.env + (1.0 - this.attackCoeff) * absX;
      } else {
        this.env = this.releaseCoeff * this.env + (1.0 - this.releaseCoeff) * absX;
      }

      if (!this.isOpen && this.env >= this.openThreshold) {
        this.isOpen = true;
      } else if (this.isOpen && this.env < this.closeThreshold) {
        this.isOpen = false;
      }

      const targetGain = this.isOpen ? 1.0 : this.floorGain;
      if (targetGain > this.gateGain) {
        this.gateGain = this.gainAttackCoeff * this.gateGain + (1.0 - this.gainAttackCoeff) * targetGain;
      } else {
        this.gateGain = this.gainReleaseCoeff * this.gateGain + (1.0 - this.gainReleaseCoeff) * targetGain;
      }

      output[i] = x * this.gateGain;
    }
  }
}

/**
 * Constant-speed, phase-aligned dual-grain pitch shifter kernel.
 * Shifts pitch by `pitch` (0.25x..4.0x) while keeping playback duration at 1.0x.
 * Use `process(input, output)` per audio block; `setPitch()` changes the target ratio.
 */
export class PitchShiftKernel {
  private readonly bufferSize = 16384; // ~340ms @ 48kHz, power of 2
  private readonly mask = this.bufferSize - 1;
  private readonly ring = new Float32Array(this.bufferSize);
  private readonly grainSize: number;
  private writeIdx = 0;
  private phase = 0;
  private currentPitch: number;
  private targetPitch: number;
  private delayA: number;
  private delayB: number;

  constructor(initialPitch = 1.0, grainSize = 2048) {
    this.grainSize = grainSize;
    this.currentPitch = PitchShiftKernel.clampPitch(initialPitch);
    this.targetPitch = this.currentPitch;
    this.delayA = 8;
    this.delayB = grainSize * 0.5 + 8;
  }

  static clampPitch(p: number): number {
    return Math.max(0.25, Math.min(4.0, p || 1.0));
  }

  setPitch(p: number): void {
    this.targetPitch = PitchShiftKernel.clampPitch(p);
  }

  getPitch(): number {
    return this.currentPitch;
  }

  /** 4-point Hermite fractional read `delaySamples` behind the write head. */
  private read(delaySamples: number): number {
    const { ring, mask, bufferSize } = this;
    const readPos = this.writeIdx - delaySamples + bufferSize;
    const idx0 = Math.floor(readPos);
    const frac = readPos - idx0;
    const ym1 = ring[(idx0 - 1) & mask];
    const y0 = ring[idx0 & mask];
    const y1 = ring[(idx0 + 1) & mask];
    const y2 = ring[(idx0 + 2) & mask];
    const c1 = 0.5 * (y1 - ym1);
    const c2 = ym1 - 2.5 * y0 + 2.0 * y1 - 0.5 * y2;
    const c3 = 0.5 * (y2 - ym1) + 1.5 * (y0 - y1);
    return ((c3 * frac + c2) * frac + c1) * frac + y0;
  }

  /** Pick a start delay near `baseDelay` whose waveform best matches the active grain. */
  private findPhaseAlignedDelay(baseDelay: number, activeRefDelay: number): number {
    const { ring, mask, bufferSize } = this;
    const ref0 = this.read(activeRefDelay);
    const ref1 = this.read(activeRefDelay + 4);
    const ref2 = this.read(activeRefDelay + 8);
    let bestDelay = baseDelay;
    let bestErr = Infinity;
    for (let offset = 0; offset < 480; offset += 2) {
      const cand = baseDelay + offset;
      const d0 = ring[(this.writeIdx - Math.floor(cand) + bufferSize) & mask] - ref0;
      const d1 = ring[(this.writeIdx - Math.floor(cand + 4) + bufferSize) & mask] - ref1;
      const d2 = ring[(this.writeIdx - Math.floor(cand + 8) + bufferSize) & mask] - ref2;
      const err = d0 * d0 + d1 * d1 + d2 * d2;
      if (err < bestErr) {
        bestErr = err;
        bestDelay = cand;
      }
    }
    return bestDelay;
  }

  process(input: Float32Array, output: Float32Array): void {
    const len = input.length;
    const grain = this.grainSize;
    for (let i = 0; i < len; i++) {
      const x = input[i];
      this.ring[this.writeIdx] = x;

      this.currentPitch += (this.targetPitch - this.currentPitch) * 0.0025;

      const prevPhase = this.phase;
      this.phase += 1.0 / grain;
      const baseStart = this.currentPitch > 1.0 ? grain + 8 : 8;
      if (this.phase >= 1.0) {
        this.phase -= 1.0;
        this.delayA = this.findPhaseAlignedDelay(baseStart, this.delayB);
      }
      if (prevPhase < 0.5 && this.phase >= 0.5) {
        this.delayB = this.findPhaseAlignedDelay(baseStart, this.delayA);
      }

      const delta = 1.0 - this.currentPitch;
      this.delayA = Math.max(4, this.delayA + delta);
      this.delayB = Math.max(4, this.delayB + delta);

      const pA = this.phase;
      const pB = this.phase + 0.5 - Math.floor(this.phase + 0.5);
      const wet = hann(pA) * this.read(this.delayA) + hann(pB) * this.read(this.delayB);

      // Crossfade to dry pass-through when pitch is ~1.0x (bit-transparent at unity)
      const shiftDist = Math.min(1.0, Math.abs(this.currentPitch - 1.0) / 0.015);
      output[i] = x * (1.0 - shiftDist) + wet * shiftDist;

      this.writeIdx = (this.writeIdx + 1) & this.mask;
    }
  }
}

/**
 * True Single-Sideband (SSB) frequency shifter kernel using an 8th-order
 * Regalia-Mitra / Niemitalo half-band Hilbert-transform all-pass filter pair.
 *
 * - Positive `freqHz` (+Δf) shifts all spectral components upward by +Δf Hz (upper sideband).
 * - Negative `freqHz` (-Δf) shifts all spectral components downward by -Δf Hz (lower sideband).
 * - `0 Hz` smoothly crossfades to unity pass-through (tuned-in AM station).
 */
export class SsbFrequencyShiftKernel {
  private static readonly COEFF_I = [
    0.47940086558884,
    0.87621849353931,
    0.976597589508199,
    0.997499255935549
  ];
  private static readonly COEFF_Q = [
    0.161758498367701,
    0.73302893234149,
    0.945349700329113,
    0.990599156684529
  ];

  private readonly sampleRate: number;
  private currentFreq: number;
  private targetFreq: number;
  private oscPhase = 0;

  // State history for 4 cascaded z^-2 all-pass stages on I and Q branches
  private readonly xI1 = new Float64Array(4);
  private readonly xI2 = new Float64Array(4);
  private readonly yI1 = new Float64Array(4);
  private readonly yI2 = new Float64Array(4);

  private readonly xQ1 = new Float64Array(4);
  private readonly xQ2 = new Float64Array(4);
  private readonly yQ1 = new Float64Array(4);
  private readonly yQ2 = new Float64Array(4);
  private qDelay1 = 0;

  constructor(initialFreqHz = 0.0, sampleRate = 48000) {
    this.sampleRate = sampleRate > 0 ? sampleRate : 48000;
    this.currentFreq = SsbFrequencyShiftKernel.clampFreq(initialFreqHz);
    this.targetFreq = this.currentFreq;
  }

  static clampFreq(freqHz: number): number {
    if (typeof freqHz !== 'number' || Number.isNaN(freqHz)) return 0;
    return Math.max(-20000, Math.min(20000, freqHz));
  }

  setFrequency(freqHz: number): void {
    this.targetFreq = SsbFrequencyShiftKernel.clampFreq(freqHz);
  }

  getFrequency(): number {
    return this.currentFreq;
  }

  process(input: Float32Array, output: Float32Array): void {
    const len = input.length;
    const invSr = 1.0 / this.sampleRate;
    const cI = SsbFrequencyShiftKernel.COEFF_I;
    const cQ = SsbFrequencyShiftKernel.COEFF_Q;

    for (let i = 0; i < len; i++) {
      const x = input[i];
      this.currentFreq += (this.targetFreq - this.currentFreq) * 0.005;

      // Branch I: 4 cascaded all-pass sections y[n] = c * (x[n] - y[n-2]) + x[n-2]
      let sI = x;
      for (let k = 0; k < 4; k++) {
        const y = cI[k] * (sI - this.yI2[k]) + this.xI2[k];
        this.xI2[k] = this.xI1[k];
        this.xI1[k] = sI;
        this.yI2[k] = this.yI1[k];
        this.yI1[k] = y;
        sI = y;
      }

      // Branch Q: 1-sample delay followed by 4 cascaded all-pass sections
      let sQ = this.qDelay1;
      this.qDelay1 = x;
      for (let k = 0; k < 4; k++) {
        const y = cQ[k] * (sQ - this.yQ2[k]) + this.xQ2[k];
        this.xQ2[k] = this.xQ1[k];
        this.xQ1[k] = sQ;
        this.yQ2[k] = this.yQ1[k];
        this.yQ1[k] = y;
        sQ = y;
      }

      // Advance quadrature oscillator
      this.oscPhase += this.currentFreq * invSr;
      this.oscPhase -= Math.floor(this.oscPhase);
      const angle = 2.0 * Math.PI * this.oscPhase;
      const wet = sI * Math.cos(angle) - sQ * Math.sin(angle);

      // Smooth crossfade to dry unity signal within ±1.5 Hz of 0 Hz (clean AM station tuning)
      const shiftMix = Math.min(1.0, Math.abs(this.currentFreq) / 1.5);
      output[i] = x * (1.0 - shiftMix) + wet * shiftMix;
    }
  }
}
