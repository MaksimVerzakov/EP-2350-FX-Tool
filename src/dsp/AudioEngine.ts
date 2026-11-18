import type { AnyEffect, PlayMode, PresetConfig } from '../types/config';
import { createSyntheticAudioBuffer } from './synthSamples';
import { busLanes } from '../utils/busRouting';
import { buildStereoDelay } from './stereoDelay';
import {
  NoiseGateKernel,
  PitchShiftKernel,
  ReverbKernel,
  SsbFrequencyShiftKernel,
  computeLfoWave,
  cutoffToHz,
  makeDistortionCurve,
  resolveModDepth
} from './math';
import defaultSpeechUrl from '../assets/speech.mp3';
import sampleSlot0Url from '../assets/samples/kara-te.wav';
import sampleSlot1Url from '../assets/samples/shouty.wav';
import sampleSlot2Url from '../assets/samples/slion.wav';
import sampleSlot3Url from '../assets/samples/alert.wav';

export const BUNDLED_SAMPLES = [
  { pos: 0, name: 'KARA-TE', file: 'kara-te.wav', url: sampleSlot0Url },
  { pos: 1, name: 'SHOUTY', file: 'shouty.wav', url: sampleSlot1Url },
  { pos: 2, name: 'SLION', file: 'slion.wav', url: sampleSlot2Url },
  { pos: 3, name: 'ALERT', file: 'alert.wav', url: sampleSlot3Url }
] as const;

export const WORKLET_PROCESSOR_SOURCE = `
class Ep2350PitchShiftProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.bufferSize = 16384;
    this.mask = 16383;
    this.ring = new Float32Array(16384);
    this.grainSize = 2048;
    this.writeIdx = 0;
    this.phase = 0;
    const initPitch = options?.processorOptions?.pitch ?? 1.0;
    this.currentPitch = Math.max(0.25, Math.min(4.0, initPitch || 1.0));
    this.targetPitch = this.currentPitch;
    this.delayA = 8;
    this.delayB = 1032;
    this.port.onmessage = (e) => {
      if (typeof e.data?.pitch === 'number') {
        this.targetPitch = Math.max(0.25, Math.min(4.0, e.data.pitch || 1.0));
      }
    };
  }
  read(delaySamples) {
    const readPos = this.writeIdx - delaySamples + this.bufferSize;
    const idx0 = Math.floor(readPos);
    const frac = readPos - idx0;
    const ym1 = this.ring[(idx0 - 1) & this.mask];
    const y0 = this.ring[idx0 & this.mask];
    const y1 = this.ring[(idx0 + 1) & this.mask];
    const y2 = this.ring[(idx0 + 2) & this.mask];
    const c1 = 0.5 * (y1 - ym1);
    const c2 = ym1 - 2.5 * y0 + 2.0 * y1 - 0.5 * y2;
    const c3 = 0.5 * (y2 - ym1) + 1.5 * (y0 - y1);
    return ((c3 * frac + c2) * frac + c1) * frac + y0;
  }
  findPhaseAlignedDelay(baseDelay, activeRefDelay) {
    const ref0 = this.read(activeRefDelay);
    const ref1 = this.read(activeRefDelay + 4);
    const ref2 = this.read(activeRefDelay + 8);
    let bestDelay = baseDelay;
    let bestErr = Infinity;
    for (let offset = 0; offset < 480; offset += 2) {
      const cand = baseDelay + offset;
      const d0 = this.ring[(this.writeIdx - Math.floor(cand) + this.bufferSize) & this.mask] - ref0;
      const d1 = this.ring[(this.writeIdx - Math.floor(cand + 4) + this.bufferSize) & this.mask] - ref1;
      const d2 = this.ring[(this.writeIdx - Math.floor(cand + 8) + this.bufferSize) & this.mask] - ref2;
      const err = d0 * d0 + d1 * d1 + d2 * d2;
      if (err < bestErr) {
        bestErr = err;
        bestDelay = cand;
      }
    }
    return bestDelay;
  }
  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return true;
    const grain = this.grainSize;
    for (let i = 0; i < output.length; i++) {
      const x = input ? input[i] : 0;
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
      const wA = 0.5 * (1.0 - Math.cos(2.0 * Math.PI * pA));
      const wB = 0.5 * (1.0 - Math.cos(2.0 * Math.PI * pB));
      const wet = wA * this.read(this.delayA) + wB * this.read(this.delayB);
      const shiftDist = Math.min(1.0, Math.abs(this.currentPitch - 1.0) / 0.015);
      output[i] = x * (1.0 - shiftDist) + wet * shiftDist;
      this.writeIdx = (this.writeIdx + 1) & this.mask;
    }
    return true;
  }
}

class Ep2350SsbShiftProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.cI = [0.47940086558884, 0.87621849353931, 0.976597589508199, 0.997499255935549];
    this.cQ = [0.161758498367701, 0.73302893234149, 0.945349700329113, 0.990599156684529];
    const initFreq = options?.processorOptions?.frequency ?? 0.0;
    this.currentFreq = Math.max(-20000, Math.min(20000, initFreq || 0));
    this.targetFreq = this.currentFreq;
    this.oscPhase = 0;
    this.xI1 = new Float64Array(4);
    this.xI2 = new Float64Array(4);
    this.yI1 = new Float64Array(4);
    this.yI2 = new Float64Array(4);
    this.xQ1 = new Float64Array(4);
    this.xQ2 = new Float64Array(4);
    this.yQ1 = new Float64Array(4);
    this.yQ2 = new Float64Array(4);
    this.qDelay1 = 0;
    this.port.onmessage = (e) => {
      if (typeof e.data?.frequency === 'number') {
        this.targetFreq = Math.max(-20000, Math.min(20000, e.data.frequency));
      }
    };
  }
  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return true;
    const invSr = 1.0 / sampleRate;
    for (let i = 0; i < output.length; i++) {
      const x = input ? input[i] : 0;
      this.currentFreq += (this.targetFreq - this.currentFreq) * 0.005;
      let sI = x;
      for (let k = 0; k < 4; k++) {
        const y = this.cI[k] * (sI - this.yI2[k]) + this.xI2[k];
        this.xI2[k] = this.xI1[k];
        this.xI1[k] = sI;
        this.yI2[k] = this.yI1[k];
        this.yI1[k] = y;
        sI = y;
      }
      let sQ = this.qDelay1;
      this.qDelay1 = x;
      for (let k = 0; k < 4; k++) {
        const y = this.cQ[k] * (sQ - this.yQ2[k]) + this.xQ2[k];
        this.xQ2[k] = this.xQ1[k];
        this.xQ1[k] = sQ;
        this.yQ2[k] = this.yQ1[k];
        this.yQ1[k] = y;
        sQ = y;
      }
      this.oscPhase += this.currentFreq * invSr;
      this.oscPhase -= Math.floor(this.oscPhase);
      const angle = 2.0 * Math.PI * this.oscPhase;
      const wet = sI * Math.cos(angle) - sQ * Math.sin(angle);
      const shiftMix = Math.min(1.0, Math.abs(this.currentFreq) / 1.5);
      output[i] = x * (1.0 - shiftMix) + wet * shiftMix;
    }
    return true;
  }
}

registerProcessor('ep2350-pitch-shifter', Ep2350PitchShiftProcessor);
registerProcessor('ep2350-ssb-shifter', Ep2350SsbShiftProcessor);

class Ep2350NoiseGateProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const sr = typeof sampleRate === 'number' && sampleRate > 0 ? sampleRate : 48000;
    this.openThreshold = Math.pow(10, -46 / 20);
    this.closeThreshold = Math.pow(10, -52 / 20);
    this.floorGain = 0.05;
    this.attackCoeff = Math.exp(-1.0 / (0.002 * sr));
    this.releaseCoeff = Math.exp(-1.0 / (0.06 * sr));
    this.gainAttackCoeff = Math.exp(-1.0 / (0.003 * sr));
    this.gainReleaseCoeff = Math.exp(-1.0 / (0.08 * sr));
    this.env = 0;
    this.gateGain = 1.0;
    this.isOpen = true;
  }
  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return true;
    for (let i = 0; i < output.length; i++) {
      const x = input ? input[i] : 0;
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
    return true;
  }
}

registerProcessor('ep2350-noisegate', Ep2350NoiseGateProcessor);

// REVERB runs the same kernel class as the ScriptProcessor fallback and the tests (src/dsp/math.ts)
const ReverbKernel = (${ReverbKernel.toString()});

class Ep2350ReverbProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const p = (options && options.processorOptions) || {};
    this.kernel = new ReverbKernel(sampleRate);
    this.kernel.setParams(typeof p.time === 'number' ? p.time : 0.5, typeof p.spring === 'number' ? p.spring : 0);
    this.port.onmessage = (e) => {
      const d = e.data || {};
      this.kernel.setParams(
        typeof d.time === 'number' ? d.time : this.kernel.time,
        typeof d.spring === 'number' ? d.spring : this.kernel.spring
      );
    };
  }
  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || !out[0]) return true;
    const input = inputs[0] && inputs[0][0];
    this.kernel.process(input, out[0], out[1] || out[0]);
    return true;
  }
}

registerProcessor('ep2350-reverb', Ep2350ReverbProcessor);
`;

export type InputMode = 'sample' | 'mic';

/** Filter Q when a LOWPASS/HIGHPASS row leaves `Q` out (maps to biquad Q 2.0). */
export const FILTER_DEFAULT_Q = 0.2;
/** config.json Q (0..1) to biquad Q, the same scale as EQUALISER. */
export const filterQ = (q: number) => Math.max(0.1, q * 10);
/** Playback rate of a triggered sample: SAMPLE.speed times the SAMPLE.pitch ratio (tape-style). */
export const samplePlaybackRate = (speed: number, semitones: number) =>
  Math.max(0.01, Math.min(16, speed * Math.pow(2, semitones / 12)));
const DUCK_ATTACK_S = 0.01;
const DUCK_RELEASE_S = 0.12;

export interface ModulationState {
  handlePos: number; // 0.0 to 1.0
  shakeAmount: number; // 0.0 to 1.0 (transient decay)
}

export class DspAudioEngine {
  private ctx: AudioContext | null = null;
  private isRunning: boolean = false;
  private isStarting: boolean = false;
  private startGen: number = 0;
  private inputMode: InputMode = 'sample';
  private micStream: MediaStream | null = null;
  private micSourceNode: MediaStreamAudioSourceNode | null = null;
  private lastMicError: string | null = null;
  private currentBuffer: AudioBuffer | null = null;
  private sampleBuffers: AudioBuffer[] = [];
  /** User WAVs per slot; a slot without one plays its bundled demo sound. */
  private customSampleBuffers: Array<AudioBuffer | null> = [null, null, null, null];
  private activeSampleSlot: number = 0;
  private sampleSourceNode: AudioBufferSourceNode | null = null;
  private isSamplePlaying: boolean = false;
  private sourceNode: AudioBufferSourceNode | null = null;
  private inputCompressor: DynamicsCompressorNode | null = null;
  private inputNoiseGate: (AudioNode & { onaudioprocess?: any }) | null = null;
  /** Turns the mic down while a sample with `duck` plays. Samples bypass it. */
  private duckGain: GainNode | null = null;
  private sourceHub: GainNode | null = null;
  private busSummer: GainNode | null = null;
  private gainMaster: GainNode | null = null;
  private safetyLimiter: DynamicsCompressorNode | null = null;
  private workletReady: boolean = false;
  private loopSource: boolean = true;
  private lfoRafId: number | null = null;

  // Active preset & modulation
  private preset: PresetConfig | null = null;
  private modState: ModulationState = {
    handlePos: 1.0,
    shakeAmount: 0.0
  };

  // Node references for live parameter updating
  private activeNodes: Array<{
    effectType: string;
    params: Record<string, any>;
    nodeRefs: Record<string, any>;
  }> = [];

  constructor() {}

  private async decodeUrlOrFallback(ctx: AudioContext, url: string): Promise<AudioBuffer> {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const arrayBuffer = await res.arrayBuffer();
        return await ctx.decodeAudioData(arrayBuffer);
      }
    } catch {}
    return createSyntheticAudioBuffer(ctx);
  }

  public async init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      this.ctx = new AudioCtx();
      this.gainMaster = this.ctx.createGain();
      this.gainMaster.gain.value = 0.85;

      // Master brickwall safety limiter to protect user hearing & monitors from feedback oscillation spikes
      this.safetyLimiter = this.ctx.createDynamicsCompressor();
      this.safetyLimiter.threshold.value = -0.5;
      this.safetyLimiter.knee.value = 0.0;
      this.safetyLimiter.ratio.value = 20.0;
      this.safetyLimiter.attack.value = 0.001;
      this.safetyLimiter.release.value = 0.05;

      this.gainMaster.connect(this.safetyLimiter);
      this.safetyLimiter.connect(this.ctx.destination);

      if (
        this.ctx.audioWorklet &&
        typeof AudioWorkletNode !== 'undefined' &&
        typeof Blob !== 'undefined' &&
        typeof URL !== 'undefined' &&
        typeof URL.createObjectURL === 'function'
      ) {
        try {
          const blob = new Blob([WORKLET_PROCESSOR_SOURCE], { type: 'application/javascript' });
          const workletUrl = URL.createObjectURL(blob);
          await this.ctx.audioWorklet.addModule(workletUrl);
          URL.revokeObjectURL(workletUrl);
          this.workletReady = true;
        } catch {
          this.workletReady = false;
        }
      }

      const ctx = this.ctx;
      const [speechBuf, ...slotBufs] = await Promise.all([
        this.decodeUrlOrFallback(ctx, defaultSpeechUrl),
        ...BUNDLED_SAMPLES.map((s) => this.decodeUrlOrFallback(ctx, s.url))
      ]);
      this.currentBuffer = speechBuf;
      this.sampleBuffers = slotBufs;
    }
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
  }

  public getSafetyLimiter(): DynamicsCompressorNode | null {
    return this.safetyLimiter;
  }

  public getInputCompressor(): DynamicsCompressorNode | null {
    return this.inputCompressor;
  }

  public getInputNoiseGate(): (AudioNode & { onaudioprocess?: any }) | null {
    return this.inputNoiseGate;
  }

  public getInputMode(): InputMode {
    return this.inputMode;
  }

  public getLastMicError(): string | null {
    return this.lastMicError;
  }

  public async setInputMode(mode: InputMode): Promise<boolean> {
    if (this.inputMode === mode) return true;
    this.inputMode = mode;
    this.lastMicError = null;
    if (this.isRunning) {
      this.stop();
      await this.start();
      return this.isRunning && this.inputMode === mode;
    }
    return true;
  }

  private createInputNoiseGate(ctx: AudioContext): AudioNode & { onaudioprocess?: any } {
    if (this.workletReady && typeof AudioWorkletNode !== 'undefined') {
      return new AudioWorkletNode(ctx, 'ep2350-noisegate', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1]
      }) as AudioNode & { onaudioprocess?: any };
    }
    const processor = ctx.createScriptProcessor(512, 1, 1);
    const kernel = new NoiseGateKernel(ctx.sampleRate);
    processor.onaudioprocess = (e: AudioProcessingEvent) => {
      kernel.process(e.inputBuffer.getChannelData(0), e.outputBuffer.getChannelData(0));
    };
    return processor;
  }

  private ensureInputPreChain(ctx: AudioContext): AudioNode {
    if (!this.sourceHub) {
      this.sourceHub = ctx.createGain();
      this.sourceHub.gain.value = 1.0;
    }
    if (!this.inputCompressor) {
      // Hardware RP2350 pre-chain `compressor` stage (fx.timing(): ~1195 cycles)
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18.0;
      comp.knee.value = 12.0;
      comp.ratio.value = 4.0;
      comp.attack.value = 0.005;
      comp.release.value = 0.12;
      this.inputCompressor = comp;
    }
    if (!this.inputNoiseGate) {
      // Hardware RP2350 pre-chain `noisegate` stage (fx.timing(): ~2231 cycles)
      this.inputNoiseGate = this.createInputNoiseGate(ctx);
    }
    try {
      this.inputCompressor.disconnect();
    } catch {}
    try {
      this.inputNoiseGate.disconnect();
    } catch {}
    if (!this.duckGain) {
      this.duckGain = ctx.createGain();
      this.duckGain.gain.value = 1.0;
    }
    try {
      this.duckGain.disconnect();
    } catch {}
    this.inputCompressor.connect(this.inputNoiseGate);
    this.inputNoiseGate.connect(this.duckGain);
    this.duckGain.connect(this.sourceHub);
    return this.inputCompressor;
  }

  /**
   * Decode a WAV file for auditioning. Before the first click the page may not start audio, so an
   * OfflineAudioContext decodes instead; an AudioBuffer plays in any context.
   */
  public async decodeSampleFile(bytes: Uint8Array): Promise<AudioBuffer> {
    // decodeAudioData detaches its input, so hand it a copy
    const copy = bytes.slice().buffer;
    if (this.ctx) return this.ctx.decodeAudioData(copy);
    const w = typeof window !== 'undefined' ? (window as any) : undefined;
    const Offline = w?.OfflineAudioContext || w?.webkitOfflineAudioContext;
    if (Offline) return new Offline(1, 1, 48000).decodeAudioData(copy);
    await this.init();
    if (!this.ctx) throw new Error('Audio is not available in this browser.');
    return (this.ctx as AudioContext).decodeAudioData(copy);
  }

  /**
   * Render `buffer` (decoded from a file at `srcRate`) for the mic: trimmed to `enc.trim` (frames of
   * the original file), mixed to `enc.channels` and resampled to `enc.sampleRate`.
   */
  public async renderForDevice(
    buffer: AudioBuffer,
    srcRate: number,
    enc: { trim?: { start: number; end: number }; channels: number; sampleRate: number }
  ): Promise<{ channels: Float32Array[]; sampleRate: number }> {
    const w = typeof window !== 'undefined' ? (window as any) : undefined;
    const Offline = w?.OfflineAudioContext || w?.webkitOfflineAudioContext;
    if (!Offline) throw new Error('This browser cannot re-encode audio.');
    const startSec = enc.trim ? enc.trim.start / srcRate : 0;
    const durSec = enc.trim ? (enc.trim.end - enc.trim.start) / srcRate : buffer.duration;
    const frames = Math.max(1, Math.round(durSec * enc.sampleRate));
    const off = new Offline(enc.channels, frames, enc.sampleRate);
    const src = off.createBufferSource();
    src.buffer = buffer;
    src.connect(off.destination); // a mono destination mixes stereo down to (L + R) / 2
    src.start(0, startSec, durSec);
    const out: AudioBuffer = await off.startRendering();
    return {
      channels: Array.from({ length: out.numberOfChannels }, (_, c) => out.getChannelData(c)),
      sampleRate: enc.sampleRate
    };
  }

  /** Play `buffer` from sample slot `slot` (null: back to the bundled demo sound). */
  public setCustomSample(slot: number, buffer: AudioBuffer | null) {
    if (slot < 0 || slot > 3) return;
    if (this.customSampleBuffers[slot] === buffer) return;
    this.customSampleBuffers[slot] = buffer;
    if (slot === this.activeSampleSlot) this.stopSample();
  }

  public hasCustomSample(slot: number): boolean {
    return !!this.customSampleBuffers[slot];
  }

  public setActiveSampleSlot(slot: number) {
    const clamped = Math.max(0, Math.min(3, Math.floor(slot)));
    if (clamped !== this.activeSampleSlot) {
      this.activeSampleSlot = clamped;
      this.stopSample();
    }
  }

  public getActiveSampleSlot(): number {
    return this.activeSampleSlot;
  }

  public getIsSamplePlaying(): boolean {
    return this.isSamplePlaying;
  }

  public stopSample() {
    this.isSamplePlaying = false;
    this.setDuck(0);
    if (this.sampleSourceNode) {
      try {
        this.sampleSourceNode.onended = null;
        this.sampleSourceNode.stop();
        this.sampleSourceNode.disconnect();
      } catch (e) {}
      this.sampleSourceNode = null;
    }
    if (!this.isRunning) {
      this.stopModulationLoop();
    }
  }

  public getDuckGain(): GainNode | null {
    return this.duckGain;
  }

  /** Duck the mic by `amount` (0 = untouched, 1 = silent): fast attack, slower release. */
  private setDuck(amount: number) {
    if (!this.ctx || !this.duckGain) return;
    const target = 1 - Math.max(0, Math.min(1, amount));
    const param = this.duckGain.gain;
    const now = this.ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.setTargetAtTime(target, now, target < param.value ? DUCK_ATTACK_S : DUCK_RELEASE_S);
  }

  public async triggerSample(down: boolean = true, playmode: PlayMode = 'oneshot', duck: number = 0) {
    if (!down) {
      if (playmode === 'hold') {
        this.stopSample();
      }
      return;
    }

    if (playmode === 'startstop' && this.isSamplePlaying) {
      this.stopSample();
      return;
    }

    await this.init();
    if (!this.ctx || !this.gainMaster) return;

    if (!this.sourceHub) {
      this.ensureInputPreChain(this.ctx);
    }
    if (this.activeNodes.length === 0) {
      this.rebuildChain();
    }

    this.stopSample();

    const sampleBuf =
      this.customSampleBuffers[this.activeSampleSlot] || this.sampleBuffers[this.activeSampleSlot] || this.currentBuffer;
    if (!sampleBuf) return;

    const triggerRow = this.preset?.trigger?.row;
    const sampleNodeEntry =
      (typeof triggerRow === 'number'
        ? this.activeNodes.find((n) => n.effectType === 'SAMPLE' && n.nodeRefs.rowIdx === triggerRow)
        : undefined) || this.activeNodes.find((n) => n.effectType === 'SAMPLE');

    const targetInput: AudioNode | null = sampleNodeEntry?.nodeRefs?.sampleInput || this.sourceHub;
    if (!targetInput) return;

    const src = this.ctx.createBufferSource();
    src.buffer = sampleBuf;
    src.loop = playmode === 'hold' || playmode === 'startstop';
    src.playbackRate.value = sampleNodeEntry?.nodeRefs?.lastRate ?? 1.0;

    this.sampleSourceNode = src;
    this.isSamplePlaying = true;
    src.onended = () => {
      if (this.sampleSourceNode === src) {
        this.isSamplePlaying = false;
        this.sampleSourceNode = null;
        this.setDuck(0);
        if (!this.isRunning) {
          this.stopModulationLoop();
        }
      }
    };

    src.connect(targetInput);
    this.applyLiveModulation(true);
    if (typeof duck === 'number' && duck > 0) this.setDuck(duck);
    src.start(0);
    this.startModulationLoop();
  }

  public updatePreset(preset: PresetConfig) {
    const prevTopology = [...this.activeNodes]
      .sort((a, b) => a.nodeRefs.rowIdx - b.nodeRefs.rowIdx)
      .map((n) => `${n.effectType}:${n.params.BUS || 1}:${n.nodeRefs.rowIdx}`)
      .join('|');
    const nextTopology = (preset.list || [])
      .map((fx, idx) => `${fx.effect}:${fx.BUS || 1}:${idx}`)
      .join('|');

    this.preset = preset;
    if (!this.isRunning && !this.isSamplePlaying) return;

    if (prevTopology === nextTopology && this.activeNodes.length === preset.list.length) {
      // Update parameters in place without tearing down nodes or restarting audio
      this.activeNodes.forEach((node) => {
        const updatedFx = preset.list[node.nodeRefs.rowIdx];
        if (updatedFx) {
          node.params = { ...updatedFx };
        }
      });
      this.applyLiveModulation();
    } else {
      this.rebuildChain();
    }
  }

  public updateModulation(mod: Partial<ModulationState>) {
    this.modState = { ...this.modState, ...mod };
    this.applyLiveModulation();
  }

  public triggerShake(impulse: number = 1.0) {
    this.modState.shakeAmount = impulse;
    this.applyLiveModulation();

    // Decay shake over 450ms
    const start = performance.now();
    const decay = () => {
      const elapsed = (performance.now() - start) / 450;
      if (elapsed < 1.0) {
        this.modState.shakeAmount = impulse * (1.0 - elapsed);
        this.applyLiveModulation();
        requestAnimationFrame(decay);
      } else {
        this.modState.shakeAmount = 0.0;
        this.applyLiveModulation();
      }
    };
    requestAnimationFrame(decay);
  }

  private startModulationLoop() {
    this.stopModulationLoop();
    const tick = () => {
      if (!this.isRunning && !this.isSamplePlaying) return;
      this.applyLiveModulation();
      this.lfoRafId = requestAnimationFrame(tick);
    };
    this.lfoRafId = requestAnimationFrame(tick);
  }

  private stopModulationLoop() {
    if (this.lfoRafId !== null) {
      cancelAnimationFrame(this.lfoRafId);
      this.lfoRafId = null;
    }
  }

  public async start() {
    if (this.isStarting) return;
    const myGen = ++this.startGen;
    this.isStarting = true;
    this.isRunning = true;

    try {
      await this.init();
    } finally {
      if (myGen === this.startGen) {
        this.isStarting = false;
      }
    }

    if (myGen !== this.startGen || !this.isRunning || !this.ctx || !this.currentBuffer) {
      if (myGen === this.startGen) {
        this.isRunning = false;
      }
      return;
    }

    if (this.sourceNode) {
      try {
        this.sourceNode.stop();
        this.sourceNode.disconnect();
      } catch (e) {}
      this.sourceNode = null;
    }
    if (this.micSourceNode) {
      try {
        this.micSourceNode.disconnect();
      } catch (e) {}
      this.micSourceNode = null;
    }
    if (this.micStream) {
      try {
        this.micStream.getTracks().forEach((t) => t.stop());
      } catch (e) {}
      this.micStream = null;
    }
    if (this.sourceHub) {
      try {
        this.sourceHub.disconnect();
      } catch (e) {}
    }

    const preChainInput = this.ensureInputPreChain(this.ctx);

    if (this.inputMode === 'mic') {
      const canGetMic =
        typeof navigator !== 'undefined' &&
        navigator.mediaDevices &&
        typeof navigator.mediaDevices.getUserMedia === 'function' &&
        typeof (this.ctx as any).createMediaStreamSource === 'function';

      if (canGetMic) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false
            }
          });
          if (myGen !== this.startGen || !this.isRunning) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          this.micStream = stream;
          this.micSourceNode = this.ctx.createMediaStreamSource(stream);
          this.micSourceNode.connect(preChainInput);
          this.lastMicError = null;
        } catch (err: any) {
          this.lastMicError = err?.message || 'Microphone access denied';
          this.inputMode = 'sample';
        }
      } else {
        this.lastMicError = 'Live microphone capture not supported in this environment';
        this.inputMode = 'sample';
      }
    }

    if (this.inputMode === 'sample') {
      this.sourceNode = this.ctx.createBufferSource();
      this.sourceNode.buffer = this.currentBuffer;
      this.sourceNode.loop = this.loopSource;
      this.sourceNode.connect(preChainInput);
    }

    this.rebuildChain();
    if (this.sourceNode) {
      this.sourceNode.start(0);
    }
    this.startModulationLoop();
  }

  private cleanupActiveNodes() {
    this.activeNodes.forEach(({ nodeRefs }) => {
      if (nodeRefs.osc) {
        try {
          nodeRefs.osc.stop();
          nodeRefs.osc.disconnect();
        } catch (e) {}
      }
      if (nodeRefs.pitchShifter?.processor) {
        try {
          nodeRefs.pitchShifter.processor.onaudioprocess = null;
          nodeRefs.pitchShifter.processor.disconnect();
        } catch (e) {}
      }
      if (nodeRefs.reverb?.processor) {
        try {
          nodeRefs.reverb.processor.onaudioprocess = null;
          nodeRefs.reverb.processor.disconnect();
        } catch (e) {}
      }
      if (nodeRefs.ssbShifter?.processor) {
        try {
          nodeRefs.ssbShifter.processor.onaudioprocess = null;
          nodeRefs.ssbShifter.processor.disconnect();
        } catch (e) {}
      }
    });
    this.activeNodes = [];
  }

  /**
   * Run PitchShiftKernel in an AudioWorkletNode on the dedicated audio rendering thread,
   * falling back to ScriptProcessorNode in headless/Node test environments.
   */
  private createConstantSpeedPitchShifter(ctx: AudioContext, initialPitch: number) {
    let currentPitch = PitchShiftKernel.clampPitch(initialPitch);
    if (this.workletReady && typeof AudioWorkletNode !== 'undefined') {
      const workletNode = new AudioWorkletNode(ctx, 'ep2350-pitch-shifter', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { pitch: currentPitch }
      });
      return {
        processor: workletNode as AudioNode & { onaudioprocess?: any },
        setPitch: (newPitch: number) => {
          currentPitch = PitchShiftKernel.clampPitch(newPitch);
          workletNode.port.postMessage({ pitch: currentPitch });
        },
        getPitch: () => currentPitch
      };
    }

    const processor = ctx.createScriptProcessor(512, 1, 1);
    const kernel = new PitchShiftKernel(currentPitch);
    processor.onaudioprocess = (e: AudioProcessingEvent) => {
      kernel.process(e.inputBuffer.getChannelData(0), e.outputBuffer.getChannelData(0));
    };
    return {
      processor,
      setPitch: (newPitch: number) => {
        currentPitch = PitchShiftKernel.clampPitch(newPitch);
        kernel.setPitch(currentPitch);
      },
      getPitch: () => currentPitch
    };
  }

  /**
   * REVERB in an AudioWorkletNode (stereo wet out), or a ScriptProcessor running the same kernel
   * where worklets are unavailable. Parameters are only sent when they change.
   */
  private createReverb(ctx: AudioContext, initialTime: number, initialSpring: number) {
    let current = { time: initialTime, spring: initialSpring };
    if (this.workletReady && typeof AudioWorkletNode !== 'undefined') {
      const node = new AudioWorkletNode(ctx, 'ep2350-reverb', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: current
      });
      return {
        processor: node as AudioNode & { onaudioprocess?: any },
        setParams: (time: number, spring: number) => {
          if (time === current.time && spring === current.spring) return;
          current = { time, spring };
          node.port.postMessage(current);
        },
        getParams: () => current
      };
    }
    const processor = ctx.createScriptProcessor(512, 1, 2);
    const kernel = new ReverbKernel(ctx.sampleRate);
    kernel.setParams(initialTime, initialSpring);
    processor.onaudioprocess = (e: AudioProcessingEvent) => {
      const out = e.outputBuffer;
      kernel.process(e.inputBuffer.getChannelData(0), out.getChannelData(0), out.getChannelData(out.numberOfChannels > 1 ? 1 : 0));
    };
    return {
      processor,
      setParams: (time: number, spring: number) => {
        if (time === current.time && spring === current.spring) return;
        current = { time, spring };
        kernel.setParams(time, spring);
      },
      getParams: () => current
    };
  }

  /**
   * Run Hilbert-transform Single-Sideband (SSB) frequency shifter in an AudioWorkletNode
   * on the dedicated audio thread, falling back to ScriptProcessorNode in test environments.
   */
  private createSsbFrequencyShifter(ctx: AudioContext, initialFreqHz: number) {
    let currentFreq = SsbFrequencyShiftKernel.clampFreq(initialFreqHz);
    if (this.workletReady && typeof AudioWorkletNode !== 'undefined') {
      const workletNode = new AudioWorkletNode(ctx, 'ep2350-ssb-shifter', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { frequency: currentFreq }
      });
      return {
        processor: workletNode as AudioNode & { onaudioprocess?: any },
        setFrequency: (newFreqHz: number) => {
          currentFreq = SsbFrequencyShiftKernel.clampFreq(newFreqHz);
          workletNode.port.postMessage({ frequency: currentFreq });
        },
        getFrequency: () => currentFreq
      };
    }

    const processor = ctx.createScriptProcessor(512, 1, 1);
    const kernel = new SsbFrequencyShiftKernel(currentFreq, ctx.sampleRate);
    processor.onaudioprocess = (e: AudioProcessingEvent) => {
      kernel.process(e.inputBuffer.getChannelData(0), e.outputBuffer.getChannelData(0));
    };
    return {
      processor,
      setFrequency: (newFreqHz: number) => {
        currentFreq = SsbFrequencyShiftKernel.clampFreq(newFreqHz);
        kernel.setFrequency(currentFreq);
      },
      getFrequency: () => currentFreq
    };
  }

  public stop() {
    ++this.startGen;
    this.isStarting = false;
    this.isRunning = false;
    this.stopSample();
    this.stopModulationLoop();
    this.cleanupActiveNodes();
    if (this.inputCompressor) {
      try {
        this.inputCompressor.disconnect();
      } catch (e) {}
      this.inputCompressor = null;
    }
    if (this.inputNoiseGate) {
      try {
        this.inputNoiseGate.onaudioprocess = null;
        this.inputNoiseGate.disconnect();
      } catch (e) {}
      this.inputNoiseGate = null;
    }
    if (this.duckGain) {
      try {
        this.duckGain.disconnect();
      } catch (e) {}
      this.duckGain = null;
    }
    if (this.sourceHub) {
      try {
        this.sourceHub.disconnect();
      } catch (e) {}
      this.sourceHub = null;
    }
    if (this.busSummer) {
      try {
        this.busSummer.disconnect();
      } catch (e) {}
      this.busSummer = null;
    }
    if (this.micSourceNode) {
      try {
        this.micSourceNode.disconnect();
      } catch (e) {}
      this.micSourceNode = null;
    }
    if (this.micStream) {
      try {
        this.micStream.getTracks().forEach((t) => t.stop());
      } catch (e) {}
      this.micStream = null;
    }
    if (this.sourceNode) {
      try {
        this.sourceNode.stop();
        this.sourceNode.disconnect();
      } catch (e) {}
      this.sourceNode = null;
    }
  }

  public togglePlay(): boolean {
    if (this.isRunning) {
      this.stop();
      return false;
    } else {
      this.start();
      return true;
    }
  }

  public getIsRunning(): boolean {
    return this.isRunning;
  }

  private rebuildChain() {
    if (!this.ctx || !this.currentBuffer || !this.gainMaster || !this.sourceHub) return;

    this.cleanupActiveNodes();

    try {
      this.sourceHub.disconnect();
    } catch (e) {}

    if (this.busSummer) {
      try {
        this.busSummer.disconnect();
      } catch (e) {}
    }

    // Keep main vocal audition stream playbackRate at 1.0x (SAMPLE.speed only affects triggered WAV samples)
    if (this.sourceNode) {
      this.sourceNode.playbackRate.value = 1.0;
    }

    const bus1Effects: Array<{ fx: AnyEffect; idx: number }> = [];
    const bus2Effects: Array<{ fx: AnyEffect; idx: number }> = [];
    const mixEffects: Array<{ fx: AnyEffect; idx: number }> = [];

    if (this.preset && this.preset.list.length > 0) {
      const lanes = busLanes(this.preset.list);
      this.preset.list.forEach((fx, rowIdx) => {
        const lane = lanes[rowIdx];
        (lane === 2 ? bus2Effects : lane === 'mix' ? mixEffects : bus1Effects).push({ fx, idx: rowIdx });
      });
    }

    // Summing node for both buses. The chain's last node (chainOut) is what rebuilds and stop()
    // disconnect from the master gain, so the mix rows' tails are cut along with the buses.
    const busSummer = this.ctx.createGain();
    busSummer.gain.value = 1.0;
    const chainOut = this.ctx.createGain();
    chainOut.gain.value = 1.0;
    this.busSummer = chainOut;

    // 1. Process Bus 1 (Primary parallel branch)
    let bus1Head: AudioNode = this.sourceHub;
    bus1Effects.forEach(({ fx, idx }) => {
      const built = this.buildEffectNodes(fx, idx);
      if (built) {
        bus1Head.connect(built.input);
        bus1Head = built.output;
        this.activeNodes.push({
          effectType: fx.effect,
          params: { ...fx },
          nodeRefs: built.nodeRefs
        });
      }
    });
    bus1Head.connect(busSummer);

    // 2. Process Bus 2 (Secondary parallel branch)
    if (bus2Effects.length > 0) {
      let bus2Head: AudioNode = this.sourceHub;
      bus2Effects.forEach(({ fx, idx }) => {
        const built = this.buildEffectNodes(fx, idx);
        if (built) {
          bus2Head.connect(built.input);
          bus2Head = built.output;
          this.activeNodes.push({
            effectType: fx.effect,
            params: { ...fx },
            nodeRefs: built.nodeRefs
          });
        }
      });
      bus2Head.connect(busSummer);
    }

    // 3. Rows without BUS after the bus rows process the sum of both buses
    let mixHead: AudioNode = busSummer;
    mixEffects.forEach(({ fx, idx }) => {
      const built = this.buildEffectNodes(fx, idx);
      if (built) {
        mixHead.connect(built.input);
        mixHead = built.output;
        this.activeNodes.push({
          effectType: fx.effect,
          params: { ...fx },
          nodeRefs: built.nodeRefs
        });
      }
    });
    mixHead.connect(chainOut);
    chainOut.connect(this.gainMaster);
    this.applyLiveModulation(true);
  }

  private buildEffectNodes(
    fx: AnyEffect,
    rowIdx: number
  ): { input: AudioNode; output: AudioNode; nodeRefs: Record<string, any> } | null {
    if (!this.ctx) return null;
    const ctx = this.ctx;

    switch (fx.effect) {
      case 'LOWPASS':
      case 'HIGHPASS': {
        const filter = ctx.createBiquadFilter();
        filter.type = fx.effect === 'LOWPASS' ? 'lowpass' : 'highpass';
        filter.Q.value = filterQ(FILTER_DEFAULT_Q);
        return { input: filter, output: filter, nodeRefs: { filter, rowIdx } };
      }

      case 'EQUALISER': {
        const eq = ctx.createBiquadFilter();
        eq.type = 'peaking';
        return { input: eq, output: eq, nodeRefs: { eq, rowIdx } };
      }

      case 'DIST': {
        // Distortion with Waveshaper + Pre/Post Tone Filters + Mix
        // Even at amount: 0.0 (e.g. DEEP TRAP), base saturation is active when mix > 0
        const inputGain = ctx.createGain();
        const outputGain = ctx.createGain();
        const dryGain = ctx.createGain();
        const wetGain = ctx.createGain();
        const shaper = ctx.createWaveShaper();
        shaper.oversample = '4x';

        const lpTone = ctx.createBiquadFilter();
        lpTone.type = 'lowpass';
        const hpTone = ctx.createBiquadFilter();
        hpTone.type = 'highpass';

        inputGain.connect(dryGain);
        inputGain.connect(hpTone);
        hpTone.connect(shaper);
        shaper.connect(lpTone);
        lpTone.connect(wetGain);
        dryGain.connect(outputGain);
        wetGain.connect(outputGain);

        return {
          input: inputGain,
          output: outputGain,
          nodeRefs: { dryGain, wetGain, shaper, lpTone, hpTone, lastAmount: null, rowIdx }
        };
      }

      case 'DELAY': {
        // Two echo lines (left/right) with cross-feed between them; see stereoDelay.ts
        const delay = buildStereoDelay(ctx);
        return { input: delay.input, output: delay.output, nodeRefs: { delay, rowIdx } };
      }

      case 'REVERB': {
        // Room (Freeverb-style combs + allpass diffusers) and dispersive spring, in ReverbKernel.
        // input -> dry -> output; input -> high-pass -> reverb (stereo wet) -> wet -> output
        const input = ctx.createGain();
        const output = ctx.createGain();
        const dryGain = ctx.createGain();
        const wetGain = ctx.createGain();
        const hpFilter = ctx.createBiquadFilter();
        hpFilter.type = 'highpass';
        const time = typeof fx.time === 'number' ? fx.time : 0.5;
        const reverb = this.createReverb(ctx, time, 0);

        input.connect(dryGain);
        dryGain.connect(output);
        input.connect(hpFilter);
        hpFilter.connect(reverb.processor);
        reverb.processor.connect(wetGain);
        wetGain.connect(output);

        return { input, output, nodeRefs: { dryGain, wetGain, hpFilter, reverb, rowIdx } };
      }

      case 'RING': {
        const input = ctx.createGain();
        const output = ctx.createGain();
        const osc = ctx.createOscillator();
        osc.type = 'sine';

        const ringGain = ctx.createGain();
        ringGain.gain.value = 0;
        osc.connect(ringGain.gain);
        osc.start();

        const dryGain = ctx.createGain();
        const wetGain = ctx.createGain();

        input.connect(dryGain);
        dryGain.connect(output);
        input.connect(ringGain);
        ringGain.connect(wetGain);
        wetGain.connect(output);

        return {
          input,
          output,
          nodeRefs: { osc, dryGain, wetGain, rowIdx }
        };
      }

      case 'HARMONY': {
        // Real-time vocal pitch shifter + dry-level vocal doubler
        // Keeps playback speed strictly at 1.0x while shifting pitch (0.5x..2.0x)
        const input = ctx.createGain();
        const output = ctx.createGain();
        const dryGain = ctx.createGain();
        const wetGain = ctx.createGain();
        wetGain.gain.value = 1.0;

        const pitch = typeof fx.pitch === 'number' ? fx.pitch : 1.0;
        const pitchShifter = this.createConstantSpeedPitchShifter(ctx, pitch);

        input.connect(dryGain);
        dryGain.connect(output);
        input.connect(pitchShifter.processor);
        pitchShifter.processor.connect(wetGain);
        wetGain.connect(output);

        return {
          input,
          output,
          nodeRefs: { dryGain, wetGain, pitchShifter, rowIdx }
        };
      }

      case 'SAMPLE': {
        // Main vocal audition stream passes cleanly through SAMPLE (input -> output).
        // Triggered samples enter via sampleInput -> gain -> panner -> output. SAMPLE.pitch is
        // tape-style like on the mic: it changes the playback rate, so it also changes the length.
        const input = ctx.createGain();
        const output = ctx.createGain();
        const sampleInput = ctx.createGain();
        const gain = ctx.createGain();
        const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();

        input.connect(output);
        sampleInput.connect(gain);
        gain.connect(panner);
        panner.connect(output);

        return {
          input,
          output,
          nodeRefs: { sampleInput, gain, panner, lastSpeed: 1.0, lastRate: 1.0, rowIdx }
        };
      }

      case 'SSB': {
        // True Single Sideband quadrature Hilbert frequency shifter (-20kHz..+20kHz)
        const input = ctx.createGain();
        const output = ctx.createGain();
        const freq = typeof fx.frequency === 'number' ? fx.frequency : 0.0;
        const ssbShifter = this.createSsbFrequencyShifter(ctx, freq);

        input.connect(ssbShifter.processor);
        ssbShifter.processor.connect(output);

        return { input, output, nodeRefs: { ssbShifter, rowIdx } };
      }

      case 'BALANCE': {
        const input = ctx.createGain();
        const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
        const chopperGain = ctx.createGain();
        input.connect(panner);
        panner.connect(chopperGain);
        return { input, output: chopperGain, nodeRefs: { panner, chopperGain, rowIdx } };
      }

      default: {
        const pass = ctx.createGain();
        return { input: pass, output: pass, nodeRefs: { rowIdx } };
      }
    }
  }

  private applyLiveModulation(immediate = false) {
    if (!this.preset || !this.ctx) return;
    const ctx = this.ctx;

    const handle = this.preset.handle;
    const shake = this.preset.shake;
    const lfo = this.preset.lfo;

    // Calculate dynamic LFO speed if handle is assigned to accelerate LFO
    let effectiveLfoSpeed = lfo?.speed ?? 2.0;
    if (handle && handle.target === 'lfo') {
      effectiveLfoSpeed = Math.max(0.1, effectiveLfoSpeed + this.modState.handlePos * (handle.depth || 10.0));
    }

    const lfoPhase = typeof lfo?.phase === 'number' ? lfo.phase : 0;
    const lfoWave = lfo ? computeLfoWave(lfo.shape || 'sine', ctx.currentTime, effectiveLfoSpeed, lfoPhase) : 0;

    // Normalized [0..1] parameters in UI (e.g. LOWPASS/HIGHPASS cutoff)
    const toCutoffRatio = (v: number | undefined, defaultVal: number) =>
      typeof v === 'number' ? (v > 1 ? v / 100 : v) : defaultVal;
    // Percentage [0..100] parameters in UI (where 1 means 1% = 0.01, not 100%)
    const toRatio = (v: number | undefined, defaultVal: number) =>
      typeof v === 'number' ? (v >= 1 ? v / 100 : v) : defaultVal;

    const setParam = (audioParam: AudioParam | undefined, val: number, tau = 0.015) => {
      if (!audioParam) return;
      if (immediate) {
        audioParam.value = val;
      } else {
        audioParam.setTargetAtTime(val, ctx.currentTime, tau);
      }
    };

    this.activeNodes.forEach(({ effectType, params, nodeRefs }) => {
      const rowIdx = nodeRefs.rowIdx;

      const mod = (paramName: string, base: number, min: number, max: number) => {
        let v = base;
        if (handle && handle.target !== 'lfo' && handle.row === rowIdx && handle.param === paramName) {
          v += this.modState.handlePos * resolveModDepth(effectType, paramName, handle.depth);
        }
        if (shake && shake.row === rowIdx && shake.param === paramName) {
          v += this.modState.shakeAmount * resolveModDepth(effectType, paramName, shake.depth);
        }
        if (lfo && lfo.target !== 'lfo' && lfo.row === rowIdx && lfo.param === paramName) {
          v += lfoWave * resolveModDepth(effectType, paramName, lfo.depth);
        }
        return Math.max(min, Math.min(max, v));
      };

      switch (effectType) {
        case 'LOWPASS':
        case 'HIGHPASS': {
          const baseCutoff = toCutoffRatio(params.cutoff, effectType === 'LOWPASS' ? 1.0 : 0.0);
          setParam(nodeRefs.filter?.frequency, cutoffToHz(mod('cutoff', baseCutoff, 0.0, 1.0)), 0.015);
          // Q is optional (firmware 1.0.9+); left out, it keeps the preview's fixed resonance (0.2 -> 2.0)
          const q = mod('Q', typeof params.Q === 'number' ? params.Q : FILTER_DEFAULT_Q, 0.0, 1.0);
          setParam(nodeRefs.filter?.Q, filterQ(q), 0.015);
          break;
        }

        case 'EQUALISER': {
          const cutoff = mod('CUTOFF', typeof params.CUTOFF === 'number' ? params.CUTOFF : 0.5, 0.0, 1.0);
          const q = mod('Q', typeof params.Q === 'number' ? params.Q : 0.7, 0.0, 1.0);
          const gain = mod('GAIN', typeof params.GAIN === 'number' ? params.GAIN : 0.0, -1.0, 1.0);
          setParam(nodeRefs.eq?.frequency, cutoffToHz(cutoff), 0.015);
          setParam(nodeRefs.eq?.Q, Math.max(0.1, q * 10), 0.015);
          setParam(nodeRefs.eq?.gain, gain * 15, 0.015);
          break;
        }

        case 'DIST': {
          const rawAmount = mod('amount', typeof params.amount === 'number' ? params.amount : 10.0, 0.0, 40.0);
          const moddedAmount = Math.round(rawAmount * 100) / 100;
          if (nodeRefs.shaper && nodeRefs.lastAmount !== moddedAmount) {
            nodeRefs.shaper.curve = makeDistortionCurve(moddedAmount) as any;
            nodeRefs.lastAmount = moddedAmount;
          }
          const mix = mod('mix', toRatio(params.mix, 0.5), 0.0, 1.0);
          setParam(nodeRefs.wetGain?.gain, mix, 0.015);
          setParam(nodeRefs.dryGain?.gain, 1.0 - mix, 0.015);
          setParam(nodeRefs.lpTone?.frequency, cutoffToHz(mod('lowpass-cutoff', toRatio(params['lowpass-cutoff'], 1.0), 0.0, 1.0)), 0.015);
          setParam(nodeRefs.hpTone?.frequency, cutoffToHz(mod('highpass-cutoff', toRatio(params['highpass-cutoff'], 0.0), 0.0, 1.0)), 0.015);
          break;
        }

        case 'DELAY': {
          nodeRefs.delay?.apply(
            {
              time: mod('time', typeof params.time === 'number' ? params.time : 0.35, 0.01, 1.1),
              echo: mod('echo', toRatio(params.echo, 0.4), 0.0, 1.18),
              crossFeed: mod('cross-feed', toRatio(params['cross-feed'], 0.0), 0.0, 1.0),
              lowpass: mod('lowpass-cutoff', toRatio(params['lowpass-cutoff'], 1.0), 0.0, 1.0),
              highpass: mod('highpass-cutoff', toRatio(params['highpass-cutoff'], 0.0), 0.0, 1.0),
              wet: mod('wet-level', toRatio(params['wet-level'], 0.5), 0.0, 1.0),
              dry: mod('dry-level', toRatio(params['dry-level'], 1.0), 0.0, 1.0),
              balance: mod('balance', typeof params.balance === 'number' ? params.balance : 0.5, 0.0, 1.0)
            },
            setParam
          );
          break;
        }

        case 'REVERB': {
          setParam(nodeRefs.wetGain?.gain, mod('wet-level', toRatio(params['wet-level'], 0.5), 0.0, 1.0), 0.02);
          setParam(nodeRefs.dryGain?.gain, mod('dry-level', toRatio(params['dry-level'], 1.0), 0.0, 1.0), 0.02);
          setParam(nodeRefs.hpFilter?.frequency, cutoffToHz(mod('highpass-cutoff', toRatio(params['highpass-cutoff'], 0.0), 0.0, 1.0)), 0.02);
          // time sets the decay (0.1..6 s) without changing any delay length, so it never bends the pitch
          const time = mod('time', typeof params.time === 'number' ? params.time : 0.5, 0.0, 1.0);
          const spring = mod('spring-mix', toRatio(params['spring-mix'], 0.0), 0.0, 1.0);
          nodeRefs.reverb?.setParams(time, spring);
          break;
        }

        case 'RING':
        case 'SSB': {
          const defaultFreq = effectType === 'RING' ? 440.0 : 0.0;
          const moddedFreq = mod('frequency', typeof params.frequency === 'number' ? params.frequency : defaultFreq, -20000, 20000);
          if (effectType === 'SSB' && nodeRefs.ssbShifter) {
            nodeRefs.ssbShifter.setFrequency(moddedFreq);
          } else if (nodeRefs.osc) {
            setParam(nodeRefs.osc.frequency, Math.max(1, Math.abs(moddedFreq)), 0.015);
          }
          if (effectType === 'RING') {
            const mix = mod('mix', toRatio(params.mix, 0.5), 0.0, 1.0);
            setParam(nodeRefs.wetGain?.gain, mix, 0.015);
            setParam(nodeRefs.dryGain?.gain, 1.0 - mix, 0.015);
          }
          break;
        }

        case 'HARMONY': {
          const moddedPitch = mod('pitch', typeof params.pitch === 'number' ? params.pitch : 1.0, 0.5, 2.0);
          nodeRefs.pitchShifter?.setPitch(moddedPitch);
          setParam(nodeRefs.dryGain?.gain, mod('dry-level', toRatio(params['dry-level'], 1.0), 0.0, 1.0), 0.015);
          break;
        }

        case 'SAMPLE': {
          const moddedSemitones = mod('pitch', typeof params.pitch === 'number' ? params.pitch : 0, -24, 24);
          const moddedSpeed = mod('speed', typeof params.speed === 'number' ? params.speed : 1.0, 0.05, 4.0);
          // Confirmed on the device: pitch changes the sample's length, so it multiplies the rate
          const rate = samplePlaybackRate(moddedSpeed, moddedSemitones);
          nodeRefs.lastSpeed = moddedSpeed;
          nodeRefs.lastRate = rate;
          if (this.sampleSourceNode) {
            this.sampleSourceNode.playbackRate.value = rate;
          }
          setParam(nodeRefs.gain?.gain, mod('level', toRatio(params.level, 1.0), 0.0, 1.0), 0.015);
          if (nodeRefs.panner && 'pan' in nodeRefs.panner) {
            const bal = mod('balance', typeof params.balance === 'number' ? params.balance : 0.5, 0.0, 1.0);
            setParam(nodeRefs.panner.pan, (bal - 0.5) * 2, 0.015);
          }
          break;
        }

        case 'BALANCE': {
          const bal = mod('balance', typeof params.balance === 'number' ? params.balance : 0.5, 0.0, 1.0);
          if (nodeRefs.panner && 'pan' in nodeRefs.panner) {
            setParam(nodeRefs.panner.pan, (bal - 0.5) * 2, 0.01);
          }
          if (nodeRefs.chopperGain) {
            const isChopped = lfo && lfo.row === rowIdx && lfo.param === 'balance' && lfoWave < 0;
            setParam(nodeRefs.chopperGain.gain, isChopped ? 0.18 : 1.0, 0.008);
          }
          break;
        }
      }
    });
  }
}

export const audioEngine = new DspAudioEngine();
