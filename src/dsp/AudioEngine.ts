import type { AnyEffect, PresetConfig } from '../types/config';
import { createSyntheticAudioBuffer } from './synthSamples';
import {
  PitchShiftKernel,
  SsbFrequencyShiftKernel,
  computeLfoWave,
  cutoffToHz,
  makeDistortionCurve,
  makeSoftClipCurve,
  resolveModDepth
} from './math';
import defaultSpeechUrl from '../assets/speech.mp3';

const WORKLET_PROCESSOR_SOURCE = `
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
`;

export interface ModulationState {
  handlePos: number; // 0.0 to 1.0
  shakeAmount: number; // 0.0 to 1.0 (transient decay)
}

export class DspAudioEngine {
  private ctx: AudioContext | null = null;
  private isRunning: boolean = false;
  private isStarting: boolean = false;
  private startGen: number = 0;
  private currentBuffer: AudioBuffer | null = null;
  private sourceNode: AudioBufferSourceNode | null = null;
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

      // Default sample: Clean spoken speech sample ("The quick brown fox jumps over the lazy dog")
      try {
        const res = await fetch(defaultSpeechUrl);
        if (res.ok) {
          const arrayBuffer = await res.arrayBuffer();
          this.currentBuffer = await this.ctx.decodeAudioData(arrayBuffer);
        } else {
          this.currentBuffer = createSyntheticAudioBuffer(this.ctx);
        }
      } catch {
        this.currentBuffer = createSyntheticAudioBuffer(this.ctx);
      }
    }
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
  }

  public getSafetyLimiter(): DynamicsCompressorNode | null {
    return this.safetyLimiter;
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
    if (!this.isRunning) return;

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
      if (!this.isRunning) return;
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
    }
    if (this.sourceHub) {
      try {
        this.sourceHub.disconnect();
      } catch (e) {}
    }

    this.sourceNode = this.ctx.createBufferSource();
    this.sourceNode.buffer = this.currentBuffer;
    this.sourceNode.loop = this.loopSource;

    this.sourceHub = this.ctx.createGain();
    this.sourceHub.gain.value = 1.0;
    this.sourceNode.connect(this.sourceHub);

    this.rebuildChain();
    this.sourceNode.start(0);
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
    this.stopModulationLoop();
    this.cleanupActiveNodes();
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

    // Reset playbackRate to 1.0 unless SAMPLE.speed overrides it
    if (this.sourceNode) {
      this.sourceNode.playbackRate.value = 1.0;
    }

    const bus1Effects: Array<{ fx: AnyEffect; idx: number }> = [];
    const bus2Effects: Array<{ fx: AnyEffect; idx: number }> = [];

    if (this.preset && this.preset.list.length > 0) {
      this.preset.list.forEach((fx, rowIdx) => {
        if (fx.BUS === 2) {
          bus2Effects.push({ fx, idx: rowIdx });
        } else {
          bus1Effects.push({ fx, idx: rowIdx });
        }
      });
    }

    // Master summing node before master gain
    const busSummer = this.ctx.createGain();
    busSummer.gain.value = 1.0;
    this.busSummer = busSummer;

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

    busSummer.connect(this.gainMaster);
    this.applyLiveModulation();
  }

  private buildEffectNodes(
    fx: AnyEffect,
    rowIdx: number
  ): { input: AudioNode; output: AudioNode; nodeRefs: Record<string, any> } | null {
    if (!this.ctx) return null;

    const ctx = this.ctx;
    // Normalized [0..1] parameters in UI (e.g. LOWPASS/HIGHPASS cutoff)
    const toCutoffRatio = (v: number | undefined, defaultVal: number) =>
      typeof v === 'number' ? (v > 1 ? v / 100 : v) : defaultVal;
    // Percentage [0..100] parameters in UI (where 1 means 1% = 0.01, not 100%)
    const toRatio = (v: number | undefined, defaultVal: number) =>
      typeof v === 'number' ? (v >= 1 ? v / 100 : v) : defaultVal;

    switch (fx.effect) {
      case 'LOWPASS': {
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.Q.value = 2.0;
        const cutoff = toCutoffRatio(fx.cutoff, 1.0);
        filter.frequency.value = cutoffToHz(cutoff);
        return { input: filter, output: filter, nodeRefs: { filter, rowIdx } };
      }

      case 'HIGHPASS': {
        const filter = ctx.createBiquadFilter();
        filter.type = 'highpass';
        filter.Q.value = 2.0;
        const cutoff = toCutoffRatio(fx.cutoff, 0.0);
        filter.frequency.value = cutoffToHz(cutoff);
        return { input: filter, output: filter, nodeRefs: { filter, rowIdx } };
      }

      case 'EQUALISER': {
        const eq = ctx.createBiquadFilter();
        eq.type = 'peaking';
        const cutoff = typeof fx.CUTOFF === 'number' ? fx.CUTOFF : 0.5;
        eq.frequency.value = cutoffToHz(cutoff);
        const q = typeof fx.Q === 'number' ? fx.Q : 0.7;
        eq.Q.value = Math.max(0.1, q * 10);
        const gain = typeof fx.GAIN === 'number' ? fx.GAIN : 0.0;
        eq.gain.value = gain * 15;
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

        const lpTone = ctx.createBiquadFilter();
        lpTone.type = 'lowpass';
        const hpTone = ctx.createBiquadFilter();
        hpTone.type = 'highpass';

        const mix = toRatio(fx.mix, 0.5);
        dryGain.gain.value = 1.0 - mix;
        wetGain.gain.value = mix;

        const amount = typeof fx.amount === 'number' ? fx.amount : 10.0;
        shaper.curve = makeDistortionCurve(amount) as any;
        shaper.oversample = '4x';

        const lp = toRatio(fx['lowpass-cutoff'], 1.0);
        lpTone.frequency.value = cutoffToHz(lp);
        const hp = toRatio(fx['highpass-cutoff'], 0.0);
        hpTone.frequency.value = cutoffToHz(hp);

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
          nodeRefs: { dryGain, wetGain, shaper, lpTone, hpTone, lastAmount: amount, rowIdx }
        };
      }

      case 'DELAY': {
        // Stereo/Dub Delay with up to 1.2s delay line, HP + LP damping in loop, and tape saturation for self-oscillation
        const input = ctx.createGain();
        const output = ctx.createGain();

        const delayNode = ctx.createDelay(2.0);
        const time = typeof fx.time === 'number' ? fx.time : 0.35;
        delayNode.delayTime.value = Math.max(0.01, Math.min(1.2, time));

        const feedbackGain = ctx.createGain();
        const echo = toRatio(fx.echo, 0.4);
        const crossFeed = toRatio(fx['cross-feed'], 0.0);
        feedbackGain.gain.value = Math.min(1.15, echo + crossFeed * 0.15);

        // Soft limiter inside feedback loop so echo > 1.0 (SPACE ECHO) self-oscillates warmly without clipping
        const tapeLimiter = ctx.createWaveShaper();
        tapeLimiter.curve = makeSoftClipCurve() as any;

        const lpFilter = ctx.createBiquadFilter();
        lpFilter.type = 'lowpass';
        const lp = toRatio(fx['lowpass-cutoff'], 1.0);
        lpFilter.frequency.value = cutoffToHz(lp);

        const hpFilter = ctx.createBiquadFilter();
        hpFilter.type = 'highpass';
        const hp = toRatio(fx['highpass-cutoff'], 0.0);
        hpFilter.frequency.value = cutoffToHz(hp);

        const dryGain = ctx.createGain();
        dryGain.gain.value = toRatio(fx['dry-level'], 1.0);

        const wetGain = ctx.createGain();
        wetGain.gain.value = toRatio(fx['wet-level'], 0.5);

        const wetPanner = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
        const bal = typeof fx.balance === 'number' ? fx.balance : 0.5;
        if ('pan' in wetPanner) {
          wetPanner.pan.value = (bal - 0.5) * 2;
        }

        // Connect delay loop: input -> delay -> hp -> lp -> tapeLimiter -> feedback -> delay
        input.connect(dryGain);
        dryGain.connect(output);

        input.connect(delayNode);
        delayNode.connect(hpFilter);
        hpFilter.connect(lpFilter);
        lpFilter.connect(tapeLimiter);
        tapeLimiter.connect(feedbackGain);
        feedbackGain.connect(delayNode);

        tapeLimiter.connect(wetGain);
        wetGain.connect(wetPanner);
        wetPanner.connect(output);

        return {
          input,
          output,
          nodeRefs: { delayNode, feedbackGain, lpFilter, hpFilter, dryGain, wetGain, wetPanner, rowIdx }
        };
      }

      case 'REVERB': {
        // Algorithmic Reverb & Spring Tank with live-modulatable decay time and spring-mix
        const input = ctx.createGain();
        const output = ctx.createGain();

        const dryGain = ctx.createGain();
        dryGain.gain.value = toRatio(fx['dry-level'], 1.0);
        const wetGain = ctx.createGain();
        wetGain.gain.value = toRatio(fx['wet-level'], 0.5);

        const hpFilter = ctx.createBiquadFilter();
        hpFilter.type = 'highpass';
        const hp = toRatio(fx['highpass-cutoff'], 0.0);
        hpFilter.frequency.value = cutoffToHz(hp);

        const combTimes = [0.029, 0.037, 0.043, 0.051];
        const combBaseGains = [0.82, 0.78, 0.74, 0.7];
        const timeScale = typeof fx.time === 'number' ? fx.time : 0.5;
        const springMix = toRatio(fx['spring-mix'], 0.0);

        const combSum = ctx.createGain();
        combSum.gain.value = 0.28 + springMix * 0.45;

        const combFeedbackGains: GainNode[] = [];
        const combDelays: DelayNode[] = [];

        combTimes.forEach((dTime, idx) => {
          const delay = ctx.createDelay(0.5);
          delay.delayTime.value = dTime * (0.6 + timeScale * 0.8);

          const fb = ctx.createGain();
          fb.gain.value = Math.min(0.95, combBaseGains[idx] * (0.6 + timeScale * 0.36));

          hpFilter.connect(delay);
          delay.connect(fb);
          fb.connect(delay);
          delay.connect(combSum);

          combDelays.push(delay);
          combFeedbackGains.push(fb);
        });

        input.connect(dryGain);
        dryGain.connect(output);

        input.connect(hpFilter);
        combSum.connect(wetGain);
        wetGain.connect(output);

        return {
          input,
          output,
          nodeRefs: {
            dryGain,
            wetGain,
            hpFilter,
            combSum,
            combFeedbackGains,
            combDelays,
            combTimes,
            combBaseGains,
            rowIdx
          }
        };
      }

      case 'RING': {
        const input = ctx.createGain();
        const output = ctx.createGain();

        const osc = ctx.createOscillator();
        osc.type = 'sine';
        const freq = typeof fx.frequency === 'number' ? fx.frequency : 440.0;
        osc.frequency.value = Math.max(1, freq);

        const ringGain = ctx.createGain();
        ringGain.gain.value = 0;
        osc.connect(ringGain.gain);
        osc.start();

        const dryGain = ctx.createGain();
        const wetGain = ctx.createGain();
        const mix = toRatio(fx.mix, 0.5);
        dryGain.gain.value = 1.0 - mix;
        wetGain.gain.value = mix;

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
        const dryLevel = toRatio(fx['dry-level'], 1.0);
        dryGain.gain.value = dryLevel;

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
        const input = ctx.createGain();
        const gain = ctx.createGain();
        const level = toRatio(fx.level, 1.0);
        gain.gain.value = level;

        const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
        const bal = typeof fx.balance === 'number' ? fx.balance : 0.5;
        if ('pan' in panner) {
          panner.pan.value = Math.max(-1.0, Math.min(1.0, (bal - 0.5) * 2));
        }

        // Only SAMPLE.speed changes playback speed; SAMPLE.pitch shifts pitch at constant speed
        if (this.sourceNode && typeof fx.speed === 'number' && fx.speed > 0) {
          this.sourceNode.playbackRate.value = fx.speed;
        }

        const semitones = typeof fx.pitch === 'number' ? fx.pitch : 0;
        const pitchRatio = Math.pow(2, semitones / 12);
        const pitchShifter = this.createConstantSpeedPitchShifter(ctx, pitchRatio);

        input.connect(pitchShifter.processor);
        pitchShifter.processor.connect(gain);
        gain.connect(panner);

        return { input, output: panner, nodeRefs: { gain, panner, pitchShifter, rowIdx } };
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
        const bal = typeof fx.balance === 'number' ? fx.balance : 0.5;
        if ('pan' in panner) {
          panner.pan.value = (bal - 0.5) * 2;
        }
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

  private applyLiveModulation() {
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

    this.activeNodes.forEach(({ effectType, params, nodeRefs }) => {
      const rowIdx = nodeRefs.rowIdx;

      // Normalized [-1..1] deltas for [0..1] parameters
      let handleDelta = 0;
      if (handle && handle.target !== 'lfo' && handle.row === rowIdx) {
        const depthRatio = resolveModDepth(effectType, handle.param, handle.depth);
        handleDelta = this.modState.handlePos * depthRatio;
      }

      let shakeDelta = 0;
      if (shake && shake.row === rowIdx) {
        const depthRatio = resolveModDepth(effectType, shake.param, shake.depth);
        shakeDelta = this.modState.shakeAmount * depthRatio;
      }

      let lfoDelta = 0;
      if (lfo && lfo.target !== 'lfo' && lfo.row === rowIdx) {
        const depthRatio = resolveModDepth(effectType, lfo.param, lfo.depth);
        lfoDelta = lfoWave * depthRatio;
      }

      const toCutoffRatio = (v: number | undefined, defaultVal: number) =>
        typeof v === 'number' ? (v > 1 ? v / 100 : v) : defaultVal;
      const toRatio = (v: number | undefined, defaultVal: number) =>
        typeof v === 'number' ? (v >= 1 ? v / 100 : v) : defaultVal;

      if (effectType === 'LOWPASS' || effectType === 'HIGHPASS') {
        const baseCutoff = toCutoffRatio(params.cutoff, effectType === 'LOWPASS' ? 1.0 : 0.0);
        let moddedCutoff = baseCutoff;
        if (handle && handle.target !== 'lfo' && handle.row === rowIdx && handle.param === 'cutoff') moddedCutoff += handleDelta;
        if (shake && shake.row === rowIdx && shake.param === 'cutoff') moddedCutoff += shakeDelta;
        if (lfo && lfo.target !== 'lfo' && lfo.row === rowIdx && lfo.param === 'cutoff') moddedCutoff += lfoDelta;
        moddedCutoff = Math.max(0.0, Math.min(1.0, moddedCutoff));

        const hz = cutoffToHz(moddedCutoff);
        if (nodeRefs.filter) {
          nodeRefs.filter.frequency.setTargetAtTime(hz, ctx.currentTime, 0.015);
        }
      } else if (effectType === 'EQUALISER') {
        if (nodeRefs.eq) {
          const baseCutoff = typeof params.CUTOFF === 'number' ? params.CUTOFF : 0.5;
          let moddedCutoff = baseCutoff;
          if (handle && handle.target !== 'lfo' && handle.row === rowIdx && handle.param === 'CUTOFF') moddedCutoff += handleDelta;
          if (shake && shake.row === rowIdx && shake.param === 'CUTOFF') moddedCutoff += shakeDelta;
          if (lfo && lfo.target !== 'lfo' && lfo.row === rowIdx && lfo.param === 'CUTOFF') moddedCutoff += lfoDelta;
          moddedCutoff = Math.max(0.0, Math.min(1.0, moddedCutoff));
          nodeRefs.eq.frequency.setTargetAtTime(cutoffToHz(moddedCutoff), ctx.currentTime, 0.015);

          let q = typeof params.Q === 'number' ? params.Q : 0.7;
          if (handle && handle.target !== 'lfo' && handle.row === rowIdx && handle.param === 'Q') q += handleDelta;
          if (shake && shake.row === rowIdx && shake.param === 'Q') q += shakeDelta;
          if (lfo && lfo.target !== 'lfo' && lfo.row === rowIdx && lfo.param === 'Q') q += lfoDelta;
          q = Math.max(0.0, Math.min(1.0, q));
          nodeRefs.eq.Q.setTargetAtTime(Math.max(0.1, q * 10), ctx.currentTime, 0.015);

          let gain = typeof params.GAIN === 'number' ? params.GAIN : 0.0;
          if (handle && handle.target !== 'lfo' && handle.row === rowIdx && handle.param === 'GAIN') gain += handleDelta;
          if (shake && shake.row === rowIdx && shake.param === 'GAIN') gain += shakeDelta;
          if (lfo && lfo.target !== 'lfo' && lfo.row === rowIdx && lfo.param === 'GAIN') gain += lfoDelta;
          gain = Math.max(-1.0, Math.min(1.0, gain));
          nodeRefs.eq.gain.setTargetAtTime(gain * 15, ctx.currentTime, 0.015);
        }
      } else if (effectType === 'DIST') {
        if (nodeRefs.shaper) {
          const baseAmount = typeof params.amount === 'number' ? params.amount : 10.0;
          let delta = 0;
          if (handle && handle.target !== 'lfo' && handle.row === rowIdx && handle.param === 'amount') delta += handleDelta;
          if (shake && shake.row === rowIdx && shake.param === 'amount') delta += shakeDelta;
          if (lfo && lfo.target !== 'lfo' && lfo.row === rowIdx && lfo.param === 'amount') delta += lfoDelta;
          const moddedAmount = Math.max(0.0, Math.min(40.0, Math.round((baseAmount + delta) * 100) / 100));
          if (nodeRefs.lastAmount !== moddedAmount) {
            nodeRefs.shaper.curve = makeDistortionCurve(moddedAmount) as any;
            nodeRefs.lastAmount = moddedAmount;
          }
        }
        if (nodeRefs.wetGain && nodeRefs.dryGain) {
          const baseMix = toRatio(params.mix, 0.5);
          let delta = 0;
          if (handle && handle.target !== 'lfo' && handle.row === rowIdx && handle.param === 'mix') delta += handleDelta;
          if (shake && shake.row === rowIdx && shake.param === 'mix') delta += shakeDelta;
          if (lfo && lfo.target !== 'lfo' && lfo.row === rowIdx && lfo.param === 'mix') delta += lfoDelta;
          const mix = Math.max(0.0, Math.min(1.0, baseMix + delta));
          nodeRefs.wetGain.gain.setTargetAtTime(mix, ctx.currentTime, 0.015);
          nodeRefs.dryGain.gain.setTargetAtTime(1.0 - mix, ctx.currentTime, 0.015);
        }
        if (nodeRefs.lpTone) {
          let lp = toRatio(params['lowpass-cutoff'], 1.0);
          if (handle && handle.target !== 'lfo' && handle.row === rowIdx && handle.param === 'lowpass-cutoff') lp += handleDelta;
          if (shake && shake.row === rowIdx && shake.param === 'lowpass-cutoff') lp += shakeDelta;
          if (lfo && lfo.target !== 'lfo' && lfo.row === rowIdx && lfo.param === 'lowpass-cutoff') lp += lfoDelta;
          lp = Math.max(0.0, Math.min(1.0, lp));
          nodeRefs.lpTone.frequency.setTargetAtTime(cutoffToHz(lp), ctx.currentTime, 0.015);
        }
        if (nodeRefs.hpTone) {
          let hp = toRatio(params['highpass-cutoff'], 0.0);
          if (handle && handle.target !== 'lfo' && handle.row === rowIdx && handle.param === 'highpass-cutoff') hp += handleDelta;
          if (shake && shake.row === rowIdx && shake.param === 'highpass-cutoff') hp += shakeDelta;
          if (lfo && lfo.target !== 'lfo' && lfo.row === rowIdx && lfo.param === 'highpass-cutoff') hp += lfoDelta;
          hp = Math.max(0.0, Math.min(1.0, hp));
          nodeRefs.hpTone.frequency.setTargetAtTime(cutoffToHz(hp), ctx.currentTime, 0.015);
        }
      } else if (effectType === 'DELAY') {
        if (nodeRefs.feedbackGain) {
          const baseEcho = toRatio(params.echo, 0.4);
          let crossFeed = toRatio(params['cross-feed'], 0.0);
          if (handle && handle.target !== 'lfo' && handle.row === rowIdx && handle.param === 'cross-feed') crossFeed += handleDelta;
          if (shake && shake.row === rowIdx && shake.param === 'cross-feed') crossFeed += shakeDelta;
          if (lfo && lfo.target !== 'lfo' && lfo.row === rowIdx && lfo.param === 'cross-feed') crossFeed += lfoDelta;
          crossFeed = Math.max(0.0, Math.min(1.0, crossFeed));

          let delta = 0;
          if (handle && handle.target !== 'lfo' && handle.row === rowIdx && handle.param === 'echo') delta += handleDelta;
          if (shake && shake.row === rowIdx && shake.param === 'echo') delta += shakeDelta;
          if (lfo && lfo.target !== 'lfo' && lfo.row === rowIdx && lfo.param === 'echo') delta += lfoDelta;
          // Allow up to 1.18 when modulated past 1.0 so SPACE ECHO self-oscillates through tapeLimiter
          const echo = Math.max(0.0, Math.min(1.18, baseEcho + delta + crossFeed * 0.15));
          nodeRefs.feedbackGain.gain.setTargetAtTime(echo, ctx.currentTime, 0.02);
        }
        if (nodeRefs.delayNode) {
          const baseTime = typeof params.time === 'number' ? params.time : 0.35;
          let delta = 0;
          if (handle && handle.target !== 'lfo' && handle.row === rowIdx && handle.param === 'time') delta += handleDelta;
          if (shake && shake.row === rowIdx && shake.param === 'time') delta += shakeDelta;
          if (lfo && lfo.target !== 'lfo' && lfo.row === rowIdx && lfo.param === 'time') delta += lfoDelta;
          const dTime = Math.max(0.01, Math.min(1.2, baseTime + delta));
          nodeRefs.delayNode.delayTime.setTargetAtTime(dTime, ctx.currentTime, 0.03);
        }
        if (nodeRefs.wetGain) {
          const baseWet = toRatio(params['wet-level'], 0.5);
          let delta = 0;
          if (handle && handle.target !== 'lfo' && handle.row === rowIdx && handle.param === 'wet-level') delta += handleDelta;
          if (shake && shake.row === rowIdx && shake.param === 'wet-level') delta += shakeDelta;
          if (lfo && lfo.target !== 'lfo' && lfo.row === rowIdx && lfo.param === 'wet-level') delta += lfoDelta;
          nodeRefs.wetGain.gain.setTargetAtTime(Math.max(0.0, Math.min(1.0, baseWet + delta)), ctx.currentTime, 0.02);
        }
        if (nodeRefs.dryGain) {
          let dry = toRatio(params['dry-level'], 1.0);
          if (handle && handle.target !== 'lfo' && handle.row === rowIdx && handle.param === 'dry-level') dry += handleDelta;
          if (shake && shake.row === rowIdx && shake.param === 'dry-level') dry += shakeDelta;
          if (lfo && lfo.target !== 'lfo' && lfo.row === rowIdx && lfo.param === 'dry-level') dry += lfoDelta;
          nodeRefs.dryGain.gain.setTargetAtTime(Math.max(0.0, Math.min(1.0, dry)), ctx.currentTime, 0.02);
        }
        if (nodeRefs.lpFilter) {
          let lp = toRatio(params['lowpass-cutoff'], 1.0);
          if (handle && handle.target !== 'lfo' && handle.row === rowIdx && handle.param === 'lowpass-cutoff') lp += handleDelta;
          if (shake && shake.row === rowIdx && shake.param === 'lowpass-cutoff') lp += shakeDelta;
          if (lfo && lfo.target !== 'lfo' && lfo.row === rowIdx && lfo.param === 'lowpass-cutoff') lp += lfoDelta;
          lp = Math.max(0.0, Math.min(1.0, lp));
          nodeRefs.lpFilter.frequency.setTargetAtTime(cutoffToHz(lp), ctx.currentTime, 0.02);
        }
        if (nodeRefs.hpFilter) {
          let hp = toRatio(params['highpass-cutoff'], 0.0);
          if (handle && handle.target !== 'lfo' && handle.row === rowIdx && handle.param === 'highpass-cutoff') hp += handleDelta;
          if (shake && shake.row === rowIdx && shake.param === 'highpass-cutoff') hp += shakeDelta;
          if (lfo && lfo.target !== 'lfo' && lfo.row === rowIdx && lfo.param === 'highpass-cutoff') hp += lfoDelta;
          hp = Math.max(0.0, Math.min(1.0, hp));
          nodeRefs.hpFilter.frequency.setTargetAtTime(cutoffToHz(hp), ctx.currentTime, 0.02);
        }
        if (nodeRefs.wetPanner && 'pan' in nodeRefs.wetPanner) {
          let bal = typeof params.balance === 'number' ? params.balance : 0.5;
          if (handle && handle.target !== 'lfo' && handle.row === rowIdx && handle.param === 'balance') bal += handleDelta;
          if (shake && shake.row === rowIdx && shake.param === 'balance') bal += shakeDelta;
          if (lfo && lfo.target !== 'lfo' && lfo.row === rowIdx && lfo.param === 'balance') bal += lfoDelta;
          bal = Math.max(0.0, Math.min(1.0, bal));
          nodeRefs.wetPanner.pan.setTargetAtTime((bal - 0.5) * 2, ctx.currentTime, 0.015);
        }
      } else if (effectType === 'HARMONY') {
        const basePitch = typeof params.pitch === 'number' ? params.pitch : 1.0;
        let moddedPitch = basePitch;

        if (handle && handle.target !== 'lfo' && handle.row === rowIdx && handle.param === 'pitch') {
          moddedPitch += this.modState.handlePos * (typeof handle.depth === 'number' ? handle.depth : 0.5);
        }
        if (shake && shake.row === rowIdx && shake.param === 'pitch') {
          moddedPitch += this.modState.shakeAmount * (typeof shake.depth === 'number' ? shake.depth : -0.2);
        }
        if (lfo && lfo.target !== 'lfo' && lfo.row === rowIdx && lfo.param === 'pitch') {
          moddedPitch += lfoWave * (typeof lfo.depth === 'number' ? lfo.depth : 0.1);
        }
        moddedPitch = Math.max(0.5, Math.min(2.0, moddedPitch));

        if (nodeRefs.pitchShifter) {
          nodeRefs.pitchShifter.setPitch(moddedPitch);
        }

        if (nodeRefs.dryGain) {
          const baseDry = toRatio(params['dry-level'], 1.0);
          let delta = 0;
          if (handle && handle.target !== 'lfo' && handle.row === rowIdx && handle.param === 'dry-level') delta += handleDelta;
          if (shake && shake.row === rowIdx && shake.param === 'dry-level') delta += shakeDelta;
          if (lfo && lfo.target !== 'lfo' && lfo.row === rowIdx && lfo.param === 'dry-level') delta += lfoDelta;
          nodeRefs.dryGain.gain.setTargetAtTime(Math.max(0.0, Math.min(1.0, baseDry + delta)), ctx.currentTime, 0.015);
        }
      } else if (effectType === 'SAMPLE') {
        const baseSemitones = typeof params.pitch === 'number' ? params.pitch : 0;
        let moddedSemitones = baseSemitones;
        if (handle && handle.target !== 'lfo' && handle.row === rowIdx && handle.param === 'pitch') {
          moddedSemitones += this.modState.handlePos * (typeof handle.depth === 'number' ? handle.depth : 12);
        }
        if (shake && shake.row === rowIdx && shake.param === 'pitch') {
          moddedSemitones += this.modState.shakeAmount * (typeof shake.depth === 'number' ? shake.depth : 12);
        }
        if (lfo && lfo.target !== 'lfo' && lfo.row === rowIdx && lfo.param === 'pitch') {
          moddedSemitones += lfoWave * (typeof lfo.depth === 'number' ? lfo.depth : 6);
        }
        if (nodeRefs.pitchShifter) {
          nodeRefs.pitchShifter.setPitch(Math.pow(2, moddedSemitones / 12));
        }

        if (this.sourceNode) {
          let moddedSpeed = typeof params.speed === 'number' ? params.speed : 1.0;
          if (handle && handle.target !== 'lfo' && handle.row === rowIdx && handle.param === 'speed') moddedSpeed += handleDelta;
          if (shake && shake.row === rowIdx && shake.param === 'speed') moddedSpeed += shakeDelta;
          if (lfo && lfo.target !== 'lfo' && lfo.row === rowIdx && lfo.param === 'speed') moddedSpeed += lfoDelta;
          moddedSpeed = Math.max(0.05, Math.min(4.0, moddedSpeed));
          this.sourceNode.playbackRate.value = moddedSpeed;
        }

        if (nodeRefs.gain) {
          let level = toRatio(params.level, 1.0);
          if (handle && handle.target !== 'lfo' && handle.row === rowIdx && handle.param === 'level') level += handleDelta;
          if (shake && shake.row === rowIdx && shake.param === 'level') level += shakeDelta;
          if (lfo && lfo.target !== 'lfo' && lfo.row === rowIdx && lfo.param === 'level') level += lfoDelta;
          nodeRefs.gain.gain.setTargetAtTime(Math.max(0.0, Math.min(1.0, level)), ctx.currentTime, 0.015);
        }

        if (nodeRefs.panner && 'pan' in nodeRefs.panner) {
          let bal = typeof params.balance === 'number' ? params.balance : 0.5;
          if (handle && handle.target !== 'lfo' && handle.row === rowIdx && handle.param === 'balance') bal += handleDelta;
          if (shake && shake.row === rowIdx && shake.param === 'balance') bal += shakeDelta;
          if (lfo && lfo.target !== 'lfo' && lfo.row === rowIdx && lfo.param === 'balance') bal += lfoDelta;
          bal = Math.max(0.0, Math.min(1.0, bal));
          nodeRefs.panner.pan.setTargetAtTime((bal - 0.5) * 2, ctx.currentTime, 0.015);
        }
      } else if (effectType === 'RING' || effectType === 'SSB') {
        const baseFreq = typeof params.frequency === 'number' ? params.frequency : (effectType === 'RING' ? 440.0 : 0.0);
        let moddedFreq = baseFreq;
        if (handle && handle.target !== 'lfo' && handle.row === rowIdx && handle.param === 'frequency') {
          moddedFreq += this.modState.handlePos * (typeof handle.depth === 'number' ? handle.depth : 500.0);
        }
        if (shake && shake.row === rowIdx && shake.param === 'frequency') {
          moddedFreq += this.modState.shakeAmount * (typeof shake.depth === 'number' ? shake.depth : 200.0);
        }
        if (lfo && lfo.target !== 'lfo' && lfo.row === rowIdx && lfo.param === 'frequency') {
          const rawDepth = typeof lfo.depth === 'number' ? lfo.depth : 50.0;
          moddedFreq += lfoWave * rawDepth;
        }
        if (effectType === 'SSB' && nodeRefs.ssbShifter) {
          nodeRefs.ssbShifter.setFrequency(moddedFreq);
        } else if (nodeRefs.osc) {
          nodeRefs.osc.frequency.setTargetAtTime(Math.max(1, Math.abs(moddedFreq)), ctx.currentTime, 0.015);
        }
        if (effectType === 'RING' && nodeRefs.dryGain && nodeRefs.wetGain) {
          let mix = toRatio(params.mix, 0.5);
          if (handle && handle.target !== 'lfo' && handle.row === rowIdx && handle.param === 'mix') mix += handleDelta;
          if (shake && shake.row === rowIdx && shake.param === 'mix') mix += shakeDelta;
          if (lfo && lfo.target !== 'lfo' && lfo.row === rowIdx && lfo.param === 'mix') mix += lfoDelta;
          mix = Math.max(0.0, Math.min(1.0, mix));
          nodeRefs.wetGain.gain.setTargetAtTime(mix, ctx.currentTime, 0.015);
          nodeRefs.dryGain.gain.setTargetAtTime(1.0 - mix, ctx.currentTime, 0.015);
        }
      } else if (effectType === 'REVERB') {
        if (nodeRefs.wetGain) {
          const baseWet = toRatio(params['wet-level'], 0.5);
          let delta = 0;
          if (handle && handle.target !== 'lfo' && handle.row === rowIdx && handle.param === 'wet-level') delta += handleDelta;
          if (shake && shake.row === rowIdx && shake.param === 'wet-level') delta += shakeDelta;
          if (lfo && lfo.target !== 'lfo' && lfo.row === rowIdx && lfo.param === 'wet-level') delta += lfoDelta;
          nodeRefs.wetGain.gain.setTargetAtTime(Math.max(0.0, Math.min(1.0, baseWet + delta)), ctx.currentTime, 0.02);
        }
        if (nodeRefs.dryGain) {
          const baseDry = toRatio(params['dry-level'], 1.0);
          let delta = 0;
          if (handle && handle.target !== 'lfo' && handle.row === rowIdx && handle.param === 'dry-level') delta += handleDelta;
          if (shake && shake.row === rowIdx && shake.param === 'dry-level') delta += shakeDelta;
          if (lfo && lfo.target !== 'lfo' && lfo.row === rowIdx && lfo.param === 'dry-level') delta += lfoDelta;
          nodeRefs.dryGain.gain.setTargetAtTime(Math.max(0.0, Math.min(1.0, baseDry + delta)), ctx.currentTime, 0.02);
        }
        if (nodeRefs.hpFilter) {
          let hp = toRatio(params['highpass-cutoff'], 0.0);
          if (handle && handle.target !== 'lfo' && handle.row === rowIdx && handle.param === 'highpass-cutoff') hp += handleDelta;
          if (shake && shake.row === rowIdx && shake.param === 'highpass-cutoff') hp += shakeDelta;
          if (lfo && lfo.target !== 'lfo' && lfo.row === rowIdx && lfo.param === 'highpass-cutoff') hp += lfoDelta;
          hp = Math.max(0.0, Math.min(1.0, hp));
          nodeRefs.hpFilter.frequency.setTargetAtTime(cutoffToHz(hp), ctx.currentTime, 0.02);
        }
        if (nodeRefs.combFeedbackGains && nodeRefs.combBaseGains) {
          const baseTime = typeof params.time === 'number' ? params.time : 0.5;
          let delta = 0;
          if (handle && handle.target !== 'lfo' && handle.row === rowIdx && handle.param === 'time') delta += handleDelta;
          if (shake && shake.row === rowIdx && shake.param === 'time') delta += shakeDelta;
          if (lfo && lfo.target !== 'lfo' && lfo.row === rowIdx && lfo.param === 'time') delta += lfoDelta;
          const timeScale = Math.max(0.0, Math.min(1.0, baseTime + delta));
          nodeRefs.combFeedbackGains.forEach((fb: GainNode, idx: number) => {
            const g = Math.min(0.96, nodeRefs.combBaseGains[idx] * (0.6 + timeScale * 0.36));
            fb.gain.setTargetAtTime(g, ctx.currentTime, 0.02);
          });
          if (nodeRefs.combDelays && nodeRefs.combTimes) {
            nodeRefs.combDelays.forEach((delay: DelayNode, idx: number) => {
              const dTime = nodeRefs.combTimes[idx] * (0.6 + timeScale * 0.8);
              delay.delayTime.setTargetAtTime(dTime, ctx.currentTime, 0.02);
            });
          }
        }
        if (nodeRefs.combSum) {
          const baseSpring = toRatio(params['spring-mix'], 0.0);
          let delta = 0;
          if (handle && handle.target !== 'lfo' && handle.row === rowIdx && handle.param === 'spring-mix') delta += handleDelta;
          if (shake && shake.row === rowIdx && shake.param === 'spring-mix') delta += shakeDelta;
          if (lfo && lfo.target !== 'lfo' && lfo.row === rowIdx && lfo.param === 'spring-mix') delta += lfoDelta;
          const spring = Math.max(0.0, Math.min(1.0, baseSpring + delta));
          nodeRefs.combSum.gain.setTargetAtTime(0.28 + spring * 0.55, ctx.currentTime, 0.02);
        }
      } else if (effectType === 'BALANCE') {
        const baseBal = typeof params.balance === 'number' ? params.balance : 0.5;
        let delta = 0;
        if (handle && handle.target !== 'lfo' && handle.row === rowIdx && handle.param === 'balance') delta += handleDelta;
        if (shake && shake.row === rowIdx && shake.param === 'balance') delta += shakeDelta;
        if (lfo && lfo.target !== 'lfo' && lfo.row === rowIdx && lfo.param === 'balance') delta += lfoDelta;
        const rawBal = baseBal + delta;
        const bal = Math.max(0.0, Math.min(1.0, rawBal));
        if (nodeRefs.panner && 'pan' in nodeRefs.panner) {
          nodeRefs.panner.pan.setTargetAtTime((bal - 0.5) * 2, ctx.currentTime, 0.01);
        }
        // When LFO square-modulates balance across extremes (like LOSING SIGNAL), impart choppy gate pulse
        if (nodeRefs.chopperGain) {
          const isChopped = lfo && lfo.row === rowIdx && lfo.param === 'balance' && lfoWave < 0;
          nodeRefs.chopperGain.gain.setTargetAtTime(isChopped ? 0.18 : 1.0, ctx.currentTime, 0.008);
        }
      }
    });
  }
}

export const audioEngine = new DspAudioEngine();
