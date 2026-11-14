/**
 * Pure TypeScript Headless Offline DSP Renderer for EP-2350 presets.
 * Mirrors DspAudioEngine (src/dsp/AudioEngine.ts) sample-for-sample at 48 kHz
 * without requiring a browser AudioContext.
 */

import type { AnyEffect, PresetConfig } from '../types/config';
import type { StereoPcmBuffer } from '../utils/wavCodec';
import { generateSyntheticVocalPcm } from '../utils/wavCodec';
import {
  NoiseGateKernel,
  PitchShiftKernel,
  SsbFrequencyShiftKernel,
  computeLfoWave,
  cutoffToHz,
  makeDistortionCurve,
  resolveModDepth
} from './math';

export type ModulationScenario = 'idle' | 'handle_pushed' | 'shake_burst' | 'dynamic_performance';

export interface OfflineRenderOptions {
  /** Static handle position (0..1) or time-varying curve fn(timeSec) -> 0..1 */
  handlePos?: number | ((timeSec: number) => number);
  /** Static shake amount (0..1) or time-varying curve fn(timeSec) -> 0..1 */
  shakeAmount?: number | ((timeSec: number) => number);
  /** Named scenario preset if handlePos/shakeAmount are not explicitly passed */
  scenario?: ModulationScenario;
  /** Optional triggered sample buffer to inject into the SAMPLE effect block */
  triggerSamplePcm?: StereoPcmBuffer;
  /** Disable pre-chain compressor/noisegate if desired for raw unit tests (defaults to true) */
  enablePreChain?: boolean;
}

/**
 * Standard Robert Bristow-Johnson (RBJ) Audio EQ Cookbook Biquad Filter Kernel.
 * Matches Web Audio API BiquadFilterNode ('lowpass', 'highpass', 'peaking').
 */
export class BiquadFilterKernel {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;

  private x1L = 0;
  private x2L = 0;
  private y1L = 0;
  private y2L = 0;

  private x1R = 0;
  private x2R = 0;
  private y1R = 0;
  private y2R = 0;

  private lastFreq = -1;
  private lastQ = -1;
  private lastGainDb = -999;
  private readonly sampleRate: number;
  private readonly type: 'lowpass' | 'highpass' | 'peaking';

  constructor(type: 'lowpass' | 'highpass' | 'peaking', sampleRate = 48000) {
    this.type = type;
    this.sampleRate = sampleRate > 0 ? sampleRate : 48000;
  }

  public updateCoefficients(freqHz: number, Q = 1.0, gainDb = 0.0): void {
    const nyquist = this.sampleRate * 0.495;
    const clampedFreq = Math.max(15, Math.min(nyquist, freqHz));
    const clampedQ = Math.max(0.05, Math.min(30, Q));

    if (
      Math.abs(clampedFreq - this.lastFreq) < 0.25 &&
      Math.abs(clampedQ - this.lastQ) < 0.005 &&
      Math.abs(gainDb - this.lastGainDb) < 0.02
    ) {
      return;
    }

    this.lastFreq = clampedFreq;
    this.lastQ = clampedQ;
    this.lastGainDb = gainDb;

    const w0 = (2 * Math.PI * clampedFreq) / this.sampleRate;
    const cosW0 = Math.cos(w0);
    const sinW0 = Math.sin(w0);
    const alpha = sinW0 / (2 * clampedQ);

    let b0 = 1;
    let b1 = 0;
    let b2 = 0;
    let a0 = 1;
    let a1 = 0;
    let a2 = 0;

    if (this.type === 'lowpass') {
      b0 = (1 - cosW0) * 0.5;
      b1 = 1 - cosW0;
      b2 = (1 - cosW0) * 0.5;
      a0 = 1 + alpha;
      a1 = -2 * cosW0;
      a2 = 1 - alpha;
    } else if (this.type === 'highpass') {
      b0 = (1 + cosW0) * 0.5;
      b1 = -(1 + cosW0);
      b2 = (1 + cosW0) * 0.5;
      a0 = 1 + alpha;
      a1 = -2 * cosW0;
      a2 = 1 - alpha;
    } else if (this.type === 'peaking') {
      const A = Math.pow(10, gainDb / 40);
      b0 = 1 + alpha * A;
      b1 = -2 * cosW0;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cosW0;
      a2 = 1 - alpha / A;
    }

    const invA0 = 1.0 / a0;
    this.b0 = b0 * invA0;
    this.b1 = b1 * invA0;
    this.b2 = b2 * invA0;
    this.a1 = a1 * invA0;
    this.a2 = a2 * invA0;
  }

  public processSampleL(x: number): number {
    const y =
      this.b0 * x +
      this.b1 * this.x1L +
      this.b2 * this.x2L -
      this.a1 * this.y1L -
      this.a2 * this.y2L;
    this.x2L = this.x1L;
    this.x1L = x;
    this.y2L = this.y1L;
    this.y1L = Number.isFinite(y) ? y : 0;
    return this.y1L;
  }

  public processSampleR(x: number): number {
    const y =
      this.b0 * x +
      this.b1 * this.x1R +
      this.b2 * this.x2R -
      this.a1 * this.y1R -
      this.a2 * this.y2R;
    this.x2R = this.x1R;
    this.x1R = x;
    this.y2R = this.y1R;
    this.y1R = Number.isFinite(y) ? y : 0;
    return this.y1R;
  }
}

/**
 * Envelope compressor/limiter kernel matching RP2350 inputCompressor & master safetyLimiter.
 */
class DynamicsCompressorKernel {
  private readonly thresholdLin: number;
  private readonly ratio: number;
  private readonly attackCoeff: number;
  private readonly releaseCoeff: number;
  private env = 0;

  constructor(
    sampleRate: number,
    thresholdDb: number,
    ratio: number,
    attackSec: number,
    releaseSec: number
  ) {
    this.thresholdLin = Math.pow(10, thresholdDb / 20);
    this.ratio = Math.max(1, ratio);
    this.attackCoeff = Math.exp(-1.0 / Math.max(1, attackSec * sampleRate));
    this.releaseCoeff = Math.exp(-1.0 / Math.max(1, releaseSec * sampleRate));
  }

  public processStereo(l: number, r: number): [number, number] {
    const peak = Math.max(Math.abs(l), Math.abs(r));
    if (peak > this.env) {
      this.env = this.attackCoeff * this.env + (1 - this.attackCoeff) * peak;
    } else {
      this.env = this.releaseCoeff * this.env + (1 - this.releaseCoeff) * peak;
    }

    let gain = 1.0;
    if (this.env > this.thresholdLin && this.env > 1e-8) {
      const overDb = 20 * Math.log10(this.env / this.thresholdLin);
      const compressedOverDb = overDb / this.ratio;
      const gainDb = compressedOverDb - overDb;
      gain = Math.pow(10, gainDb / 20);
    }

    return [l * gain, r * gain];
  }
}

interface EffectRuntimeState {
  fx: AnyEffect;
  rowIdx: number;
  filter?: BiquadFilterKernel;
  eq?: BiquadFilterKernel;
  dist?: {
    hpTone: BiquadFilterKernel;
    lpTone: BiquadFilterKernel;
    curve: Float32Array;
    lastAmount: number;
  };
  delay?: {
    buffer: Float32Array;
    writeIdx: number;
    mask: number;
    hpFilter: BiquadFilterKernel;
    lpFilter: BiquadFilterKernel;
    smoothedDelaySamples: number;
  };
  reverb?: {
    hpFilter: BiquadFilterKernel;
    combBuffers: Float32Array[];
    combWriteIdx: Int32Array;
    combBaseTimes: number[];
    combBaseGains: number[];
  };
  ring?: {
    phase: number;
  };
  harmony?: {
    shifterL: PitchShiftKernel;
    shifterR: PitchShiftKernel;
  };
  ssb?: {
    shifterL: SsbFrequencyShiftKernel;
    shifterR: SsbFrequencyShiftKernel;
  };
  sample?: {
    shifterL: PitchShiftKernel;
    shifterR: PitchShiftKernel;
    readCursor: number;
  };
}

const toCutoffRatio = (v: number | undefined, defaultVal: number): number =>
  typeof v === 'number' ? (v > 1 ? v / 100 : v) : defaultVal;

const toRatio = (v: number | undefined, defaultVal: number): number =>
  typeof v === 'number' ? (v >= 1 ? v / 100 : v) : defaultVal;

function evaluateWaveshaper(curve: Float32Array, x: number): number {
  const clamped = Math.max(-1, Math.min(1, x));
  const pos = ((clamped + 1) * 0.5) * (curve.length - 1);
  const idx = Math.floor(pos);
  const frac = pos - idx;
  const s0 = curve[idx] || 0;
  const s1 = curve[Math.min(curve.length - 1, idx + 1)] || 0;
  return s0 + frac * (s1 - s0);
}

function applyStereoPan(l: number, r: number, pan: number): [number, number] {
  const p = Math.max(-1, Math.min(1, pan));
  // Web Audio StereoPannerNode equal-power panning law for stereo input
  const x = (p + 1) * 0.5 * (Math.PI * 0.5);
  const gainL = Math.cos(x);
  const gainR = Math.sin(x);
  const mono = (l + r) * 0.5;
  if (Math.abs(l - r) < 1e-6) {
    return [mono * gainL * Math.SQRT2, mono * gainR * Math.SQRT2];
  }
  return [l * gainL * Math.SQRT2, r * gainR * Math.SQRT2];
}

/**
 * Render an EP-2350 `PresetConfig` offline against an input `StereoPcmBuffer` (or default synthetic vocal).
 */
export function renderPresetOffline(
  preset: PresetConfig,
  inputPcm?: StereoPcmBuffer,
  options: OfflineRenderOptions = {}
): StereoPcmBuffer {
  const srcPcm = inputPcm ?? generateSyntheticVocalPcm(48000, 1.6, 0.8);
  const sampleRate = srcPcm.sampleRate;
  const numFrames = Math.min(srcPcm.left.length, srcPcm.right.length);
  const outLeft = new Float32Array(numFrames);
  const outRight = new Float32Array(numFrames);

  const scenario = options.scenario ?? 'idle';
  const getHandleAt = (t: number): number => {
    if (typeof options.handlePos === 'function') return Math.max(0, Math.min(1, options.handlePos(t)));
    if (typeof options.handlePos === 'number') return Math.max(0, Math.min(1, options.handlePos));
    if (scenario === 'handle_pushed') return 1.0;
    if (scenario === 'dynamic_performance') {
      // Smoothly ramp lever 0 -> 1 -> 0 across the phrase
      return Math.max(0, Math.min(1, Math.sin((Math.PI * t) / Math.max(0.5, srcPcm.durationSec))));
    }
    return 0.0;
  };

  const getShakeAt = (t: number): number => {
    if (typeof options.shakeAmount === 'function') return Math.max(0, Math.min(1, options.shakeAmount(t)));
    if (typeof options.shakeAmount === 'number') return Math.max(0, Math.min(1, options.shakeAmount));
    if (scenario === 'shake_burst') {
      // 450ms transient shake impulse starting at t = 0.25s
      if (t >= 0.25 && t <= 0.7) {
        return 1.0 - (t - 0.25) / 0.45;
      }
      return 0.0;
    }
    if (scenario === 'dynamic_performance' && t >= 0.6 && t <= 1.05) {
      return 1.0 - (t - 0.6) / 0.45;
    }
    return 0.0;
  };

  // Pre-chain compressor & noise gate
  const enablePreChain = options.enablePreChain !== false;
  const inputCompressor = new DynamicsCompressorKernel(sampleRate, -18.0, 4.0, 0.005, 0.12);
  const noiseGateL = new NoiseGateKernel(sampleRate, -46, -52, 0.05);
  const noiseGateR = new NoiseGateKernel(sampleRate, -46, -52, 0.05);
  const masterLimiter = new DynamicsCompressorKernel(sampleRate, -0.5, 20.0, 0.001, 0.05);

  const buildRuntimeState = (fx: AnyEffect, rowIdx: number): EffectRuntimeState => {
    const state: EffectRuntimeState = { fx, rowIdx };
    switch (fx.effect) {
      case 'LOWPASS':
      case 'HIGHPASS': {
        const filter = new BiquadFilterKernel(
          fx.effect === 'LOWPASS' ? 'lowpass' : 'highpass',
          sampleRate
        );
        const initCut = toCutoffRatio(fx.cutoff, fx.effect === 'LOWPASS' ? 1.0 : 0.0);
        filter.updateCoefficients(cutoffToHz(initCut), 2.0, 0);
        state.filter = filter;
        break;
      }
      case 'EQUALISER': {
        const eq = new BiquadFilterKernel('peaking', sampleRate);
        const cut = typeof fx.CUTOFF === 'number' ? fx.CUTOFF : 0.5;
        const q = typeof fx.Q === 'number' ? fx.Q : 0.7;
        const gain = typeof fx.GAIN === 'number' ? fx.GAIN : 0.0;
        eq.updateCoefficients(cutoffToHz(cut), Math.max(0.1, q * 10), gain * 15);
        state.eq = eq;
        break;
      }
      case 'DIST': {
        const hpTone = new BiquadFilterKernel('highpass', sampleRate);
        const lpTone = new BiquadFilterKernel('lowpass', sampleRate);
        const amt = typeof fx.amount === 'number' ? fx.amount : 10.0;
        state.dist = {
          hpTone,
          lpTone,
          curve: makeDistortionCurve(amt, 8192),
          lastAmount: amt
        };
        break;
      }
      case 'DELAY': {
        // Power-of-two circular buffer >= 2.0 seconds
        let bufLen = 131072;
        while (bufLen < sampleRate * 2.2) bufLen <<= 1;
        const initTime = typeof fx.time === 'number' ? fx.time : 0.35;
        state.delay = {
          buffer: new Float32Array(bufLen),
          writeIdx: 0,
          mask: bufLen - 1,
          hpFilter: new BiquadFilterKernel('highpass', sampleRate),
          lpFilter: new BiquadFilterKernel('lowpass', sampleRate),
          smoothedDelaySamples: Math.max(1, initTime * sampleRate)
        };
        break;
      }
      case 'REVERB': {
        const combBaseTimes = [0.029, 0.037, 0.043, 0.051];
        const combBaseGains = [0.82, 0.78, 0.74, 0.7];
        const maxCombSamples = Math.ceil(sampleRate * 0.25);
        state.reverb = {
          hpFilter: new BiquadFilterKernel('highpass', sampleRate),
          combBuffers: combBaseTimes.map(() => new Float32Array(maxCombSamples)),
          combWriteIdx: new Int32Array(combBaseTimes.length),
          combBaseTimes,
          combBaseGains
        };
        break;
      }
      case 'RING': {
        state.ring = { phase: 0 };
        break;
      }
      case 'HARMONY': {
        const pitch = typeof fx.pitch === 'number' ? fx.pitch : 1.0;
        state.harmony = {
          shifterL: new PitchShiftKernel(pitch),
          shifterR: new PitchShiftKernel(pitch)
        };
        break;
      }
      case 'SSB': {
        const freq = typeof fx.frequency === 'number' ? fx.frequency : 0.0;
        state.ssb = {
          shifterL: new SsbFrequencyShiftKernel(freq, sampleRate),
          shifterR: new SsbFrequencyShiftKernel(freq, sampleRate)
        };
        break;
      }
      case 'SAMPLE': {
        const semitones = typeof fx.pitch === 'number' ? fx.pitch : 0;
        const ratio = Math.pow(2, semitones / 12);
        state.sample = {
          shifterL: new PitchShiftKernel(ratio),
          shifterR: new PitchShiftKernel(ratio),
          readCursor: 0
        };
        break;
      }
    }
    return state;
  };

  const bus1States: EffectRuntimeState[] = [];
  const bus2States: EffectRuntimeState[] = [];

  (preset.list || []).forEach((fx, idx) => {
    const st = buildRuntimeState(fx, idx);
    if (fx.BUS === 2) {
      bus2States.push(st);
    } else {
      bus1States.push(st);
    }
  });

  const allStates = [...bus1States, ...bus2States];
  const sampleEffectState = allStates.find((s) => s.fx.effect === 'SAMPLE');

  const handle = preset.handle;
  const shake = preset.shake;
  const lfo = preset.lfo;

  const evalModParam = (
    effectType: string,
    rowIdx: number,
    paramName: string,
    base: number,
    min: number,
    max: number,
    handlePos: number,
    shakeAmt: number,
    lfoWave: number
  ): number => {
    let v = base;
    if (handle && handle.target !== 'lfo' && handle.row === rowIdx && handle.param === paramName) {
      v += handlePos * resolveModDepth(effectType, paramName, handle.depth);
    }
    if (shake && shake.row === rowIdx && shake.param === paramName) {
      v += shakeAmt * resolveModDepth(effectType, paramName, shake.depth);
    }
    if (lfo && lfo.target !== 'lfo' && lfo.row === rowIdx && lfo.param === paramName) {
      v += lfoWave * resolveModDepth(effectType, paramName, lfo.depth);
    }
    return Math.max(min, Math.min(max, v));
  };

  const singleInL = new Float32Array(1);
  const singleOutL = new Float32Array(1);
  const singleInR = new Float32Array(1);
  const singleOutR = new Float32Array(1);

  let sourceCursor = 0;

  const processEffectSample = (
    st: EffectRuntimeState,
    inL: number,
    inR: number,
    handlePos: number,
    shakeAmt: number,
    lfoWave: number
  ): [number, number] => {
    const { fx, rowIdx } = st;
    const effectType = fx.effect;

    switch (effectType) {
      case 'LOWPASS':
      case 'HIGHPASS': {
        const filter = st.filter!;
        const baseCutoff = toCutoffRatio(fx.cutoff, effectType === 'LOWPASS' ? 1.0 : 0.0);
        const modCutoff = evalModParam(
          effectType,
          rowIdx,
          'cutoff',
          baseCutoff,
          0.0,
          1.0,
          handlePos,
          shakeAmt,
          lfoWave
        );
        filter.updateCoefficients(cutoffToHz(modCutoff), 2.0, 0);
        return [filter.processSampleL(inL), filter.processSampleR(inR)];
      }

      case 'EQUALISER': {
        const eq = st.eq!;
        const cutoff = evalModParam(
          effectType,
          rowIdx,
          'CUTOFF',
          typeof fx.CUTOFF === 'number' ? fx.CUTOFF : 0.5,
          0.0,
          1.0,
          handlePos,
          shakeAmt,
          lfoWave
        );
        const q = evalModParam(
          effectType,
          rowIdx,
          'Q',
          typeof fx.Q === 'number' ? fx.Q : 0.7,
          0.0,
          1.0,
          handlePos,
          shakeAmt,
          lfoWave
        );
        const gain = evalModParam(
          effectType,
          rowIdx,
          'GAIN',
          typeof fx.GAIN === 'number' ? fx.GAIN : 0.0,
          -1.0,
          1.0,
          handlePos,
          shakeAmt,
          lfoWave
        );
        eq.updateCoefficients(cutoffToHz(cutoff), Math.max(0.1, q * 10), gain * 15);
        return [eq.processSampleL(inL), eq.processSampleR(inR)];
      }

      case 'DIST': {
        const dist = st.dist!;
        const rawAmount = evalModParam(
          effectType,
          rowIdx,
          'amount',
          typeof fx.amount === 'number' ? fx.amount : 10.0,
          0.0,
          40.0,
          handlePos,
          shakeAmt,
          lfoWave
        );
        const roundedAmount = Math.round(rawAmount * 10) / 10;
        if (Math.abs(dist.lastAmount - roundedAmount) >= 0.1) {
          dist.curve = makeDistortionCurve(roundedAmount, 4096);
          dist.lastAmount = roundedAmount;
        }
        const mix = evalModParam(
          effectType,
          rowIdx,
          'mix',
          toRatio(fx.mix, 0.5),
          0.0,
          1.0,
          handlePos,
          shakeAmt,
          lfoWave
        );
        const lpCut = evalModParam(
          effectType,
          rowIdx,
          'lowpass-cutoff',
          toRatio(fx['lowpass-cutoff'], 1.0),
          0.0,
          1.0,
          handlePos,
          shakeAmt,
          lfoWave
        );
        const hpCut = evalModParam(
          effectType,
          rowIdx,
          'highpass-cutoff',
          toRatio(fx['highpass-cutoff'], 0.0),
          0.0,
          1.0,
          handlePos,
          shakeAmt,
          lfoWave
        );
        dist.hpTone.updateCoefficients(cutoffToHz(hpCut), Math.SQRT1_2, 0);
        dist.lpTone.updateCoefficients(cutoffToHz(lpCut), Math.SQRT1_2, 0);

        const hpL = dist.hpTone.processSampleL(inL);
        const hpR = dist.hpTone.processSampleR(inR);
        const shapedL = evaluateWaveshaper(dist.curve, hpL);
        const shapedR = evaluateWaveshaper(dist.curve, hpR);
        const wetL = dist.lpTone.processSampleL(shapedL);
        const wetR = dist.lpTone.processSampleR(shapedR);

        return [inL * (1 - mix) + wetL * mix, inR * (1 - mix) + wetR * mix];
      }

      case 'DELAY': {
        const d = st.delay!;
        const crossFeed = evalModParam(
          effectType,
          rowIdx,
          'cross-feed',
          toRatio(fx['cross-feed'], 0.0),
          0.0,
          1.0,
          handlePos,
          shakeAmt,
          lfoWave
        );
        const echo = evalModParam(
          effectType,
          rowIdx,
          'echo',
          toRatio(fx.echo, 0.4) + crossFeed * 0.15,
          0.0,
          1.18,
          handlePos,
          shakeAmt,
          lfoWave
        );
        const targetTimeSec = evalModParam(
          effectType,
          rowIdx,
          'time',
          typeof fx.time === 'number' ? fx.time : 0.35,
          0.01,
          1.1,
          handlePos,
          shakeAmt,
          lfoWave
        );
        const wetLevel = evalModParam(
          effectType,
          rowIdx,
          'wet-level',
          toRatio(fx['wet-level'], 0.5),
          0.0,
          1.0,
          handlePos,
          shakeAmt,
          lfoWave
        );
        const dryLevel = evalModParam(
          effectType,
          rowIdx,
          'dry-level',
          toRatio(fx['dry-level'], 1.0),
          0.0,
          1.0,
          handlePos,
          shakeAmt,
          lfoWave
        );
        const lpCut = evalModParam(
          effectType,
          rowIdx,
          'lowpass-cutoff',
          toRatio(fx['lowpass-cutoff'], 1.0),
          0.0,
          1.0,
          handlePos,
          shakeAmt,
          lfoWave
        );
        const hpCut = evalModParam(
          effectType,
          rowIdx,
          'highpass-cutoff',
          toRatio(fx['highpass-cutoff'], 0.0),
          0.0,
          1.0,
          handlePos,
          shakeAmt,
          lfoWave
        );
        const bal = evalModParam(
          effectType,
          rowIdx,
          'balance',
          typeof fx.balance === 'number' ? fx.balance : 0.5,
          0.0,
          1.0,
          handlePos,
          shakeAmt,
          lfoWave
        );

        d.hpFilter.updateCoefficients(cutoffToHz(hpCut), Math.SQRT1_2, 0);
        d.lpFilter.updateCoefficients(cutoffToHz(lpCut), Math.SQRT1_2, 0);

        const targetSamples = Math.max(1, Math.min(d.buffer.length - 4, targetTimeSec * sampleRate));
        d.smoothedDelaySamples += (targetSamples - d.smoothedDelaySamples) * 0.002;

        const readPos = d.writeIdx - d.smoothedDelaySamples + d.buffer.length;
        const idx0 = Math.floor(readPos);
        const frac = readPos - idx0;
        const delayedSample =
          d.buffer[idx0 & d.mask] * (1 - frac) + d.buffer[(idx0 + 1) & d.mask] * frac;

        const hpOut = d.hpFilter.processSampleL(delayedSample);
        const lpOut = d.lpFilter.processSampleL(hpOut);
        const saturated = Math.tanh(lpOut);

        const monoIn = (inL + inR) * 0.5;
        d.buffer[d.writeIdx] = monoIn + saturated * echo;
        d.writeIdx = (d.writeIdx + 1) & d.mask;

        const [wetL, wetR] = applyStereoPan(
          saturated * wetLevel,
          saturated * wetLevel,
          (bal - 0.5) * 2
        );
        return [inL * dryLevel + wetL, inR * dryLevel + wetR];
      }

      case 'REVERB': {
        const rev = st.reverb!;
        const wetLevel = evalModParam(
          effectType,
          rowIdx,
          'wet-level',
          toRatio(fx['wet-level'], 0.5),
          0.0,
          1.0,
          handlePos,
          shakeAmt,
          lfoWave
        );
        const dryLevel = evalModParam(
          effectType,
          rowIdx,
          'dry-level',
          toRatio(fx['dry-level'], 1.0),
          0.0,
          1.0,
          handlePos,
          shakeAmt,
          lfoWave
        );
        const hpCut = evalModParam(
          effectType,
          rowIdx,
          'highpass-cutoff',
          toRatio(fx['highpass-cutoff'], 0.0),
          0.0,
          1.0,
          handlePos,
          shakeAmt,
          lfoWave
        );
        const timeScale = evalModParam(
          effectType,
          rowIdx,
          'time',
          typeof fx.time === 'number' ? fx.time : 0.5,
          0.0,
          1.0,
          handlePos,
          shakeAmt,
          lfoWave
        );
        const spring = evalModParam(
          effectType,
          rowIdx,
          'spring-mix',
          toRatio(fx['spring-mix'], 0.0),
          0.0,
          1.0,
          handlePos,
          shakeAmt,
          lfoWave
        );

        rev.hpFilter.updateCoefficients(cutoffToHz(hpCut), Math.SQRT1_2, 0);
        const hpOut = rev.hpFilter.processSampleL((inL + inR) * 0.5);

        let combAccL = 0;
        let combAccR = 0;
        for (let c = 0; c < rev.combBuffers.length; c++) {
          const buf = rev.combBuffers[c];
          const wIdx = rev.combWriteIdx[c];
          const delaySec = rev.combBaseTimes[c] * (0.6 + timeScale * 0.8);
          const delaySamples = Math.max(1, Math.min(buf.length - 2, Math.floor(delaySec * sampleRate)));
          const rIdx = (wIdx - delaySamples + buf.length) % buf.length;
          const delayed = buf[rIdx];
          const fbGain = Math.min(0.96, rev.combBaseGains[c] * (0.6 + timeScale * 0.36));
          buf[wIdx] = hpOut + delayed * fbGain;
          rev.combWriteIdx[c] = (wIdx + 1) % buf.length;
          if ((c & 1) === 0) {
            combAccL += delayed;
            combAccR += delayed * 0.85;
          } else {
            combAccL += delayed * 0.85;
            combAccR += delayed;
          }
        }

        const combSumGain = 0.28 + spring * 0.55;
        const wetL = combAccL * combSumGain * wetLevel * 0.5;
        const wetR = combAccR * combSumGain * wetLevel * 0.5;
        return [inL * dryLevel + wetL, inR * dryLevel + wetR];
      }

      case 'RING': {
        const ring = st.ring!;
        const moddedFreq = evalModParam(
          effectType,
          rowIdx,
          'frequency',
          typeof fx.frequency === 'number' ? fx.frequency : 440.0,
          -20000,
          20000,
          handlePos,
          shakeAmt,
          lfoWave
        );
        const carrierHz = Math.max(1, Math.abs(moddedFreq));
        const mix = evalModParam(
          effectType,
          rowIdx,
          'mix',
          toRatio(fx.mix, 0.5),
          0.0,
          1.0,
          handlePos,
          shakeAmt,
          lfoWave
        );

        ring.phase += carrierHz / sampleRate;
        ring.phase -= Math.floor(ring.phase);
        const carrier = Math.sin(2 * Math.PI * ring.phase);

        const wetL = inL * carrier;
        const wetR = inR * carrier;
        return [inL * (1 - mix) + wetL * mix, inR * (1 - mix) + wetR * mix];
      }

      case 'HARMONY': {
        const harm = st.harmony!;
        const moddedPitch = evalModParam(
          effectType,
          rowIdx,
          'pitch',
          typeof fx.pitch === 'number' ? fx.pitch : 1.0,
          0.5,
          2.0,
          handlePos,
          shakeAmt,
          lfoWave
        );
        const dryLevel = evalModParam(
          effectType,
          rowIdx,
          'dry-level',
          toRatio(fx['dry-level'], 1.0),
          0.0,
          1.0,
          handlePos,
          shakeAmt,
          lfoWave
        );

        harm.shifterL.setPitch(moddedPitch);
        harm.shifterR.setPitch(moddedPitch);
        singleInL[0] = inL;
        singleInR[0] = inR;
        harm.shifterL.process(singleInL, singleOutL);
        harm.shifterR.process(singleInR, singleOutR);

        return [inL * dryLevel + singleOutL[0], inR * dryLevel + singleOutR[0]];
      }

      case 'SSB': {
        const ssb = st.ssb!;
        const moddedFreq = evalModParam(
          effectType,
          rowIdx,
          'frequency',
          typeof fx.frequency === 'number' ? fx.frequency : 0.0,
          -20000,
          20000,
          handlePos,
          shakeAmt,
          lfoWave
        );
        ssb.shifterL.setFrequency(moddedFreq);
        ssb.shifterR.setFrequency(moddedFreq);
        singleInL[0] = inL;
        singleInR[0] = inR;
        ssb.shifterL.process(singleInL, singleOutL);
        ssb.shifterR.process(singleInR, singleOutR);
        return [singleOutL[0], singleOutR[0]];
      }

      case 'SAMPLE': {
        const smp = st.sample!;
        if (!options.triggerSamplePcm) {
          return [inL, inR];
        }
        const trig = options.triggerSamplePcm;
        const moddedSemitones = evalModParam(
          effectType,
          rowIdx,
          'pitch',
          typeof fx.pitch === 'number' ? fx.pitch : 0,
          -24,
          24,
          handlePos,
          shakeAmt,
          lfoWave
        );
        const moddedSpeed = evalModParam(
          effectType,
          rowIdx,
          'speed',
          typeof fx.speed === 'number' ? fx.speed : 1.0,
          0.05,
          4.0,
          handlePos,
          shakeAmt,
          lfoWave
        );
        const level = evalModParam(
          effectType,
          rowIdx,
          'level',
          toRatio(fx.level, 1.0),
          0.0,
          1.0,
          handlePos,
          shakeAmt,
          lfoWave
        );
        const bal = evalModParam(
          effectType,
          rowIdx,
          'balance',
          typeof fx.balance === 'number' ? fx.balance : 0.5,
          0.0,
          1.0,
          handlePos,
          shakeAmt,
          lfoWave
        );

        let rawTrigL = 0;
        let rawTrigR = 0;
        if (smp.readCursor < trig.left.length - 1) {
          const idx = Math.floor(smp.readCursor);
          const frac = smp.readCursor - idx;
          rawTrigL = trig.left[idx] * (1 - frac) + trig.left[idx + 1] * frac;
          rawTrigR = trig.right[idx] * (1 - frac) + trig.right[idx + 1] * frac;
          smp.readCursor += moddedSpeed;
        }

        const pitchRatio = Math.pow(2, moddedSemitones / 12);
        smp.shifterL.setPitch(pitchRatio);
        smp.shifterR.setPitch(pitchRatio);
        singleInL[0] = rawTrigL;
        singleInR[0] = rawTrigR;
        smp.shifterL.process(singleInL, singleOutL);
        smp.shifterR.process(singleInR, singleOutR);

        const [pannedL, pannedR] = applyStereoPan(
          singleOutL[0] * level,
          singleOutR[0] * level,
          (bal - 0.5) * 2
        );
        return [inL + pannedL, inR + pannedR];
      }

      case 'BALANCE': {
        const bal = evalModParam(
          effectType,
          rowIdx,
          'balance',
          typeof fx.balance === 'number' ? fx.balance : 0.5,
          0.0,
          1.0,
          handlePos,
          shakeAmt,
          lfoWave
        );
        const isChopped = lfo && lfo.row === rowIdx && lfo.param === 'balance' && lfoWave < 0;
        const chopperGain = isChopped ? 0.18 : 1.0;
        const [pL, pR] = applyStereoPan(inL, inR, (bal - 0.5) * 2);
        return [pL * chopperGain, pR * chopperGain];
      }

      default:
        return [inL, inR];
    }
  };

  for (let i = 0; i < numFrames; i++) {
    const t = i / sampleRate;
    const handlePos = getHandleAt(t);
    const shakeAmt = getShakeAt(t);

    let effectiveLfoSpeed = lfo?.speed ?? 2.0;
    if (handle && handle.target === 'lfo') {
      effectiveLfoSpeed = Math.max(0.1, effectiveLfoSpeed + handlePos * (handle.depth || 10.0));
    }
    const lfoPhase = typeof lfo?.phase === 'number' ? lfo.phase : 0;
    const lfoWave = lfo ? computeLfoWave(lfo.shape || 'sine', t, effectiveLfoSpeed, lfoPhase) : 0;

    // Determine source playback speed if SAMPLE block specifies `speed`
    let playbackSpeed = 1.0;
    if (sampleEffectState) {
      playbackSpeed = evalModParam(
        'SAMPLE',
        sampleEffectState.rowIdx,
        'speed',
        typeof sampleEffectState.fx.speed === 'number' ? sampleEffectState.fx.speed : 1.0,
        0.05,
        4.0,
        handlePos,
        shakeAmt,
        lfoWave
      );
    }

    let rawL = 0;
    let rawR = 0;
    if (sourceCursor < numFrames - 1) {
      const idx = Math.floor(sourceCursor);
      const frac = sourceCursor - idx;
      rawL = srcPcm.left[idx] * (1 - frac) + srcPcm.left[idx + 1] * frac;
      rawR = srcPcm.right[idx] * (1 - frac) + srcPcm.right[idx + 1] * frac;
      sourceCursor += playbackSpeed;
    }

    // Pre-chain compressor + noise gate
    let hubL = rawL;
    let hubR = rawR;
    if (enablePreChain) {
      const [compL, compR] = inputCompressor.processStereo(rawL, rawR);
      singleInL[0] = compL;
      singleInR[0] = compR;
      noiseGateL.process(singleInL, singleOutL);
      noiseGateR.process(singleInR, singleOutR);
      hubL = singleOutL[0];
      hubR = singleOutR[0];
    }

    // Bus 1 chain
    let b1L = hubL;
    let b1R = hubR;
    for (let k = 0; k < bus1States.length; k++) {
      [b1L, b1R] = processEffectSample(bus1States[k], b1L, b1R, handlePos, shakeAmt, lfoWave);
    }

    // Bus 2 chain (if any effects are assigned to BUS: 2)
    let sumL = b1L;
    let sumR = b1R;
    if (bus2States.length > 0) {
      let b2L = hubL;
      let b2R = hubR;
      for (let k = 0; k < bus2States.length; k++) {
        [b2L, b2R] = processEffectSample(bus2States[k], b2L, b2R, handlePos, shakeAmt, lfoWave);
      }
      sumL += b2L;
      sumR += b2R;
    }

    // Master gain (0.85) + Master brickwall safety limiter (-0.5dB)
    const [limL, limR] = masterLimiter.processStereo(sumL * 0.85, sumR * 0.85);
    outLeft[i] = Math.max(-1, Math.min(1, limL));
    outRight[i] = Math.max(-1, Math.min(1, limR));
  }

  return {
    sampleRate,
    left: outLeft,
    right: outRight,
    durationSec: numFrames / sampleRate
  };
}
