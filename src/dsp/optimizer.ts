/**
 * Headless Parameter Optimizer & Semantic/Acoustic Chain Synthesizer for EP-2350.
 * Combines analytical acoustic warm-starting with coordinate-descent knob optimization.
 */

import { EFFECTS_REGISTRY } from '../constants/effectsRegistry';
import type { AnyEffect, PresetConfig } from '../types/config';
import type { StereoPcmBuffer } from '../utils/wavCodec';
import { generateSyntheticVocalPcm } from '../utils/wavCodec';
import type { AudioAnalysisReport, AudioDistanceResult } from './analyzer';
import { analyzePcmAudio, computeAudioDistance } from './analyzer';
import { renderPresetOffline } from './offlineRenderer';

export interface OptimizationOptions {
  maxIterations?: number;
  dryPcm?: StereoPcmBuffer;
}

export interface OptimizationResult {
  optimizedPreset: PresetConfig;
  initialDistance: AudioDistanceResult;
  finalDistance: AudioDistanceResult;
  iterationsRun: number;
  targetReport: AudioAnalysisReport;
  renderedReport: AudioAnalysisReport;
  renderedPcm: StereoPcmBuffer;
}

function clonePreset(preset: PresetConfig): PresetConfig {
  return {
    ...preset,
    list: preset.list.map((fx) => ({ ...fx })),
    handle: preset.handle ? { ...preset.handle } : undefined,
    shake: preset.shake ? { ...preset.shake } : undefined,
    lfo: preset.lfo ? { ...preset.lfo } : undefined,
    trigger: preset.trigger ? { ...preset.trigger } : undefined
  };
}

function roundToStep(val: number, min: number, max: number, step: number): number {
  const clamped = Math.max(min, Math.min(max, val));
  if (step <= 0) return Math.round(clamped * 1000) / 1000;
  const steps = Math.round((clamped - min) / step);
  return Math.round((min + steps * step) * 1000) / 1000;
}

/**
 * Use acoustic analysis of the target audio to warm-start key parameters
 * (e.g. DELAY.time from echo autocorrelation lag, HARMONY.pitch from f0 ratio)
 * before running coordinate-descent search.
 */
function applyAnalyticalWarmStart(preset: PresetConfig, targetReport: AudioAnalysisReport): void {
  for (const fx of preset.list) {
    if (fx.effect === 'DELAY' && targetReport.estimatedDelayMs !== null && targetReport.echoStrength >= 0.16) {
      fx.time = roundToStep(targetReport.estimatedDelayMs / 1000, 0.0, 1.1, 0.01);
      if (targetReport.echoStrength >= 0.35) {
        const estMix = Math.round(Math.min(75, Math.max(35, targetReport.echoStrength * 75)));
        fx.echo = Math.max(typeof fx.echo === 'number' ? fx.echo : 0, estMix);
        fx['wet-level'] = Math.max(typeof fx['wet-level'] === 'number' ? fx['wet-level'] : 0, estMix);
      }
    }
    if (fx.effect === 'HARMONY' && Math.abs(targetReport.estimatedSemitones) >= 1.5) {
      fx.pitch = roundToStep(targetReport.estimatedPitchRatio, 0.5, 2.0, 0.01);
    }
    if (fx.effect === 'LOWPASS' && targetReport.spectralRolloff85Hz > 60 && targetReport.spectralRolloff85Hz < 8000) {
      const estNorm = Math.log(targetReport.spectralRolloff85Hz / 20) / Math.log(1000);
      fx.cutoff = roundToStep(estNorm, 0.0, 1.0, 0.01);
    }
  }
}

/**
 * Optimize continuous knob parameters of `candidatePreset` so that rendering `dryPcm`
 * through the preset matches `targetPcm` as closely as possible.
 */
export function optimizePresetParameters(
  candidatePreset: PresetConfig,
  targetPcm: StereoPcmBuffer,
  options: OptimizationOptions = {}
): OptimizationResult {
  const dryPcm = options.dryPcm ?? generateSyntheticVocalPcm(targetPcm.sampleRate, 1.6, 0.8);
  const maxIterations = Math.max(4, Math.min(300, options.maxIterations ?? 48));

  const targetReport = analyzePcmAudio(targetPcm, dryPcm);
  const initialRendered = renderPresetOffline(candidatePreset, dryPcm);
  const initialDistance = computeAudioDistance(targetPcm, initialRendered);

  let bestPreset = clonePreset(candidatePreset);
  let bestDistance = initialDistance;
  let bestPcm = initialRendered;
  let iterationsRun = 1;

  // Check if analytical warm-start immediately improves over raw initial parameters
  const warmPreset = clonePreset(candidatePreset);
  applyAnalyticalWarmStart(warmPreset, targetReport);
  const warmPcm = renderPresetOffline(warmPreset, dryPcm);
  const warmDist = computeAudioDistance(targetPcm, warmPcm);
  iterationsRun++;
  if (warmDist.totalLoss < bestDistance.totalLoss) {
    bestPreset = warmPreset;
    bestDistance = warmDist;
    bestPcm = warmPcm;
  }

  // Enumerate tunable parameters across the chain (excluding SAMPLE playback speed unless explicitly non-1.0)
  const tunableParams: Array<{
    rowIdx: number;
    paramName: string;
    min: number;
    max: number;
    step: number;
  }> = [];

  bestPreset.list.forEach((fx, rowIdx) => {
    const meta = EFFECTS_REGISTRY[fx.effect];
    if (!meta) return;
    for (const p of meta.params) {
      if (fx.effect === 'SAMPLE' && (p.name === 'speed' || p.name === 'pitch' || p.name === 'level')) {
        continue;
      }
      tunableParams.push({
        rowIdx,
        paramName: p.name,
        min: p.min,
        max: p.max,
        step: p.step
      });
    }
  });

  // Multi-scale coordinate descent with coarse -> medium -> fine step fractions
  const stepScales = [0.22, 0.09, 0.03];
  for (const scale of stepScales) {
    if (iterationsRun >= maxIterations) break;
    for (const paramSpec of tunableParams) {
      if (iterationsRun >= maxIterations) break;
      const fx = bestPreset.list[paramSpec.rowIdx];
      const currentVal =
        typeof fx[paramSpec.paramName] === 'number'
          ? fx[paramSpec.paramName]
          : EFFECTS_REGISTRY[fx.effect].params.find((p) => p.name === paramSpec.paramName)?.defaultVal ?? 0;

      const delta = Math.max(paramSpec.step, (paramSpec.max - paramSpec.min) * scale);
      const candidates = [
        roundToStep(currentVal + delta, paramSpec.min, paramSpec.max, paramSpec.step),
        roundToStep(currentVal - delta, paramSpec.min, paramSpec.max, paramSpec.step)
      ];
      if (
        fx.effect === 'DELAY' &&
        paramSpec.paramName === 'time' &&
        targetReport.estimatedDelayMs !== null
      ) {
        candidates.unshift(
          roundToStep(targetReport.estimatedDelayMs / 1000, paramSpec.min, paramSpec.max, paramSpec.step)
        );
      }

      for (const candVal of candidates) {
        if (Math.abs(candVal - currentVal) < 1e-6 || iterationsRun >= maxIterations) continue;
        const trialPreset = clonePreset(bestPreset);
        trialPreset.list[paramSpec.rowIdx][paramSpec.paramName] = candVal;
        const trialPcm = renderPresetOffline(trialPreset, dryPcm);
        const trialDist = computeAudioDistance(targetPcm, trialPcm);
        iterationsRun++;

        if (trialDist.totalLoss < bestDistance.totalLoss) {
          bestPreset = trialPreset;
          bestDistance = trialDist;
          bestPcm = trialPcm;
          break; // Move in winning direction
        }
      }
    }
  }

  const renderedReport = analyzePcmAudio(bestPcm, dryPcm);

  return {
    optimizedPreset: bestPreset,
    initialDistance,
    finalDistance: bestDistance,
    iterationsRun,
    targetReport,
    renderedReport,
    renderedPcm: bestPcm
  };
}

/**
 * Automatically infer and optimize the best EP-2350 effect chain from a reference audio buffer alone.
 */
export function matchReferenceAudio(
  targetPcm: StereoPcmBuffer,
  options: OptimizationOptions = {}
): OptimizationResult & { candidatesEvaluated: number } {
  const dryPcm = options.dryPcm ?? generateSyntheticVocalPcm(targetPcm.sampleRate, 1.6, 0.8);
  const report = analyzePcmAudio(targetPcm, dryPcm);

  // Build candidate topologies informed by acoustic report cues
  const candidateChains: PresetConfig[] = [];

  // Candidate 1: Acoustic-cue inferred chain
  const inferredList: AnyEffect[] = [];
  if (report.bandsDb.bassDb < report.bandsDb.highMidDb - 11) {
    inferredList.push({ id: 'fx-hp', effect: 'HIGHPASS', cutoff: 0.42 });
  }
  if (report.crestFactorDb < 7.8) {
    inferredList.push({
      id: 'fx-dist',
      effect: 'DIST',
      amount: 12,
      mix: 65,
      'lowpass-cutoff': 80,
      'highpass-cutoff': 20
    });
  }
  if (Math.abs(report.estimatedSemitones) >= 1.8 && report.inharmonicityScore < 0.36) {
    inferredList.push({
      id: 'fx-harm',
      effect: 'HARMONY',
      pitch: roundToStep(report.estimatedPitchRatio, 0.5, 2.0, 0.01),
      'dry-level': 20
    });
  }
  if (report.inharmonicityScore >= 0.35) {
    inferredList.push({
      id: 'fx-ssb',
      effect: 'SSB',
      frequency: 280
    });
  }
  if (report.spectralRolloff85Hz > 0 && report.spectralRolloff85Hz < 2600) {
    inferredList.push({ id: 'fx-lp', effect: 'LOWPASS', cutoff: 0.58 });
  }
  if (report.estimatedDelayMs !== null && report.echoStrength >= 0.16) {
    inferredList.push({
      id: 'fx-delay',
      effect: 'DELAY',
      time: roundToStep(report.estimatedDelayMs / 1000, 0.05, 1.1, 0.01),
      echo: 50,
      'wet-level': 55,
      'dry-level': 90,
      'lowpass-cutoff': 75,
      'highpass-cutoff': 20,
      balance: 0.5
    });
  } else if (report.tailRmsDb > -42) {
    inferredList.push({
      id: 'fx-rev',
      effect: 'REVERB',
      time: 0.65,
      'spring-mix': 35,
      'highpass-cutoff': 20,
      'wet-level': 55,
      'dry-level': 90
    });
  }
  if (Math.abs(report.stereoBalance) >= 0.12) {
    inferredList.push({
      id: 'fx-bal',
      effect: 'BALANCE',
      balance: roundToStep(0.5 + report.stereoBalance * 0.5, 0, 1, 0.01)
    });
  }
  inferredList.push({ id: 'fx-smp', effect: 'SAMPLE', speed: 1.0, pitch: 0, level: 100, balance: 0.5 });

  candidateChains.push({
    id: 'cand-inferred',
    pos: 0,
    name: 'MATCHED REFERENCE',
    comment: 'AI acoustic reference match',
    list: inferredList
  });

  // Candidate 2: Bandpass + Distortion + Delay (Radio / Dub archetype)
  candidateChains.push({
    id: 'cand-radio-dub',
    pos: 0,
    name: 'RADIO DUB MATCH',
    comment: 'Bandpass + saturation + echo',
    list: [
      { id: 'r-hp', effect: 'HIGHPASS', cutoff: 0.35 },
      { id: 'r-dist', effect: 'DIST', amount: 8, mix: 50, 'lowpass-cutoff': 80, 'highpass-cutoff': 15 },
      { id: 'r-lp', effect: 'LOWPASS', cutoff: 0.65 },
      {
        id: 'r-del',
        effect: 'DELAY',
        time: report.estimatedDelayMs ? roundToStep(report.estimatedDelayMs / 1000, 0.05, 1.1, 0.01) : 0.35,
        echo: 45,
        'wet-level': 45,
        'dry-level': 95,
        'lowpass-cutoff': 80,
        'highpass-cutoff': 15,
        balance: 0.5
      },
      { id: 'r-smp', effect: 'SAMPLE', speed: 1.0, pitch: 0, level: 100, balance: 0.5 }
    ]
  });

  const perCandidateIters = Math.max(12, Math.floor((options.maxIterations ?? 48) / candidateChains.length));
  let bestResult: OptimizationResult | null = null;

  for (const chain of candidateChains) {
    const res = optimizePresetParameters(chain, targetPcm, {
      dryPcm,
      maxIterations: perCandidateIters
    });
    if (!bestResult || res.finalDistance.totalLoss < bestResult.finalDistance.totalLoss) {
      bestResult = res;
    }
  }

  return {
    ...bestResult!,
    candidatesEvaluated: candidateChains.length
  };
}

/**
 * Synthesize a hardware-valid EP-2350 `PresetConfig` from a natural-language sound description.
 * Maps musical/timbral keywords to effect topologies, parameters, and handle/shake/LFO assignments.
 */
export function synthesizePresetFromDescription(
  description: string,
  slot = 0,
  customName?: string
): { preset: PresetConfig; rationale: string[] } {
  const text = description.toLowerCase();
  const list: AnyEffect[] = [];
  const rationale: string[] = [];

  const hasKeyword = (...words: string[]) => words.some((w) => text.includes(w));
  let rowCounter = 0;
  const nextId = (prefix: string) => `${prefix}-${rowCounter++}`;

  // 1. Pre-filtering (Highpass for radio, walkie-talkie, telephone, megaphone, thin, dub)
  let hpRow = -1;
  if (hasKeyword('walkie', 'radio', 'telephone', 'megaphone', 'intercom', 'thin', 'highpass', 'hpf', 'tinny', 'dub')) {
    hpRow = list.length;
    const cutoff = hasKeyword('telephone', 'walkie', 'megaphone', 'intercom') ? 0.45 : 0.32;
    list.push({ id: nextId('hp'), effect: 'HIGHPASS', cutoff });
    rationale.push(`Added HIGHPASS (cutoff=${cutoff}) to carve out low-end mud and create a focused transducer response.`);
  }

  // 2. Pitch / Harmony (deep, monster, trap, demon, chipmunk, hyperpop, octave, harmony, choir, pitch)
  let harmonyRow = -1;
  if (hasKeyword('deep', 'monster', 'demon', 'trap', 'low voice', 'sub vocal', 'chipmunk', 'hyper', 'high pitch', 'harmony', 'octave', 'pitch')) {
    harmonyRow = list.length;
    let pitch = 1.0;
    let dryLevel = 35;
    if (hasKeyword('deep', 'monster', 'demon', 'trap', 'low voice', 'sub vocal')) {
      pitch = 0.65;
      dryLevel = 20;
    } else if (hasKeyword('chipmunk', 'hyper', 'high pitch')) {
      pitch = 1.5;
      dryLevel = 25;
    } else if (hasKeyword('octave')) {
      pitch = 0.5;
      dryLevel = 50;
    } else {
      pitch = 1.25;
      dryLevel = 50;
    }
    list.push({ id: nextId('harm'), effect: 'HARMONY', pitch, 'dry-level': dryLevel });
    rationale.push(`Added HARMONY (pitch=${pitch}x, dry-level=${dryLevel}%) for constant-speed vocal pitch shifting.`);
  }

  // 3. Distortion / Overdrive (gritty, distorted, overdrive, fuzz, crunch, megaphone, walkie, cyberpunk, broken, saturated)
  let distRow = -1;
  if (hasKeyword('grit', 'distort', 'overdrive', 'fuzz', 'crunch', 'megaphone', 'walkie', 'cyberpunk', 'broken', 'saturat', 'warm', 'dirty')) {
    distRow = list.length;
    const amount = hasKeyword('fuzz', 'heavy', 'aggressive', 'broken') ? 22.0 : 11.0;
    const mix = hasKeyword('warm', 'subtle') ? 40 : 75;
    list.push({
      id: nextId('dist'),
      effect: 'DIST',
      amount,
      mix,
      'lowpass-cutoff': 78,
      'highpass-cutoff': 22
    });
    rationale.push(`Added DIST (amount=${amount}x, mix=${mix}%) with pre/post tone shaping for harmonic grit.`);
  }

  // 4. Sci-Fi / Metallic / AM Tuning (ssb, alien, cryptic, frequency shift, losing signal, am tuner, ring, robot, dalek, metallic, clang)
  let ssbRow = -1;
  let ringRow = -1;
  if (hasKeyword('ssb', 'am tuner', 'losing signal', 'alien', 'cryptic', 'frequency shift', 'sideband', 'scramble')) {
    ssbRow = list.length;
    const freq = hasKeyword('alien', 'cryptic') ? -240 : 180;
    list.push({ id: nextId('ssb'), effect: 'SSB', frequency: freq });
    rationale.push(`Added SSB Single-Sideband Frequency Shifter (${freq} Hz) for linear carrier detuning.`);
  }
  if (hasKeyword('ring', 'robot', 'dalek', 'metallic', 'clang', 'droid', 'glitch')) {
    ringRow = list.length;
    const freq = hasKeyword('low', 'growl') ? 95 : 320;
    list.push({ id: nextId('ring'), effect: 'RING', frequency: freq, mix: 60 });
    rationale.push(`Added RING Modulator (${freq} Hz, mix=60%) for robotic/metallic sidebands.`);
  }

  // 5. Lowpass Filter (walkie, radio, dark, muffled, underwater, lpf, lowpass, sweep, filter)
  let lpRow = -1;
  if (hasKeyword('walkie', 'radio', 'telephone', 'dark', 'muffled', 'underwater', 'lpf', 'lowpass', 'filter', 'sweep')) {
    lpRow = list.length;
    const cutoff = hasKeyword('underwater', 'dark', 'muffled') ? 0.42 : 0.64;
    list.push({ id: nextId('lp'), effect: 'LOWPASS', cutoff });
    rationale.push(`Added LOWPASS filter (cutoff=${cutoff}) to roll off harsh highs and allow resonant sweeps.`);
  }

  // 6. Delay / Echo (delay, echo, dub, slapback, repeat, space, ping-pong, canyon)
  let delayRow = -1;
  if (hasKeyword('delay', 'echo', 'dub', 'slapback', 'repeat', 'space', 'canyon', 'ping')) {
    delayRow = list.length;
    const time = hasKeyword('slapback', 'short') ? 0.14 : hasKeyword('long', 'canyon', 'space') ? 0.55 : 0.36;
    const echo = hasKeyword('dub', 'space', 'self-oscillat', 'infinite') ? 75 : 48;
    list.push({
      id: nextId('delay'),
      effect: 'DELAY',
      time,
      echo,
      'cross-feed': hasKeyword('ping', 'stereo', 'wide') ? 55 : 20,
      'lowpass-cutoff': 68,
      'highpass-cutoff': 25,
      'wet-level': 55,
      'dry-level': 95,
      balance: 0.5
    });
    rationale.push(`Added DELAY (time=${time}s, echo=${echo}%) with tape-saturated feedback filtering.`);
  }

  // 7. Reverb / Room / Spring (reverb, spring, room, hall, cave, ambient, atmospheric, tank, boing)
  let reverbRow = -1;
  if (hasKeyword('reverb', 'spring', 'room', 'hall', 'cave', 'ambient', 'atmospher', 'tank', 'boing', 'space')) {
    reverbRow = list.length;
    const springMix = hasKeyword('spring', 'tank', 'boing', 'dub') ? 75 : 25;
    const time = hasKeyword('cave', 'hall', 'ambient', 'huge') ? 0.82 : 0.55;
    list.push({
      id: nextId('rev'),
      effect: 'REVERB',
      time,
      'spring-mix': springMix,
      'highpass-cutoff': 22,
      'wet-level': 55,
      'dry-level': 95
    });
    rationale.push(`Added REVERB (time=${time}, spring-mix=${springMix}%) for spatial depth and spring dispersion.`);
  }

  // 8. Balance / Chopper (chopper, tremolo, stutter, pan, stereo)
  let balanceRow = -1;
  if (hasKeyword('chop', 'tremolo', 'stutter', 'gate', 'pan')) {
    balanceRow = list.length;
    list.push({ id: nextId('bal'), effect: 'BALANCE', balance: 0.5 });
    rationale.push('Added BALANCE stage for stereo positioning / LFO rhythmic gating.');
  }

  // Fallback if prompt was super generic: add warm saturation + delay + lowpass
  if (list.length === 0) {
    distRow = list.length;
    list.push({ id: nextId('dist'), effect: 'DIST', amount: 8, mix: 45, 'lowpass-cutoff': 85, 'highpass-cutoff': 15 });
    lpRow = list.length;
    list.push({ id: nextId('lp'), effect: 'LOWPASS', cutoff: 0.72 });
    delayRow = list.length;
    list.push({
      id: nextId('delay'),
      effect: 'DELAY',
      time: 0.35,
      echo: 45,
      'wet-level': 45,
      'dry-level': 100,
      'lowpass-cutoff': 75,
      'highpass-cutoff': 20,
      balance: 0.5
    });
    rationale.push('Constructed balanced multi-FX chain (DIST -> LOWPASS -> DELAY -> SAMPLE).');
  }

  // Always include SAMPLE block so hardware preset passes audio & triggers samples
  const sampleRow = list.length;
  list.push({ id: nextId('smp'), effect: 'SAMPLE', speed: 1.0, pitch: 0, level: 100, balance: 0.5 });
  rationale.push('Included required SAMPLE injector block at end of chain.');

  // Assign expressive Handle, Shake, and LFO modulations based on active blocks
  let handle: PresetConfig['handle'];
  if (delayRow >= 0 && hasKeyword('dub', 'echo', 'space')) {
    handle = { row: delayRow, param: 'echo', depth: 35 };
    rationale.push('Mapped Handle lever to DELAY.echo (+35%) for expressive dub feedback swells.');
  } else if (lpRow >= 0) {
    handle = { row: lpRow, param: 'cutoff', depth: 35 };
    rationale.push('Mapped Handle lever to LOWPASS.cutoff (+35%) for manual filter sweeps.');
  } else if (harmonyRow >= 0) {
    handle = { row: harmonyRow, param: 'pitch', depth: 0.35 };
    rationale.push('Mapped Handle lever to HARMONY.pitch (+0.35x) for live pitch bending.');
  } else if (ssbRow >= 0) {
    handle = { row: ssbRow, param: 'frequency', depth: 450 };
    rationale.push('Mapped Handle lever to SSB.frequency (+450 Hz) for manual carrier tuning.');
  }

  let shake: PresetConfig['shake'];
  if (ssbRow >= 0) {
    shake = { row: ssbRow, param: 'frequency', depth: 800 };
    rationale.push('Mapped Shake sensor to SSB.frequency (+800 Hz) for signal-scramble bursts.');
  } else if (ringRow >= 0) {
    shake = { row: ringRow, param: 'frequency', depth: 600 };
    rationale.push('Mapped Shake sensor to RING.frequency (+600 Hz) for metallic glitch bursts.');
  } else if (reverbRow >= 0) {
    shake = { row: reverbRow, param: 'spring-mix', depth: 65 };
    rationale.push('Mapped Shake sensor to REVERB.spring-mix (+65%) for physical spring-tank crash.');
  } else if (distRow >= 0) {
    shake = { row: distRow, param: 'amount', depth: 18 };
    rationale.push('Mapped Shake sensor to DIST.amount (+18x) for transient overdrive bursts.');
  } else if (hpRow >= 0) {
    shake = { row: hpRow, param: 'cutoff', depth: 40 };
  }

  let lfo: PresetConfig['lfo'];
  if (balanceRow >= 0 && hasKeyword('chop', 'tremolo', 'stutter')) {
    lfo = { row: balanceRow, param: 'balance', shape: 'square', speed: 6.0, depth: 80 };
    rationale.push('Configured 6 Hz square LFO on BALANCE for rhythmic chopper gating.');
  } else if (ssbRow >= 0 && hasKeyword('wobble', 'drift', 'losing signal', 'alien')) {
    lfo = { row: ssbRow, param: 'frequency', shape: 'sine', speed: 1.8, depth: 160 };
    rationale.push('Configured 1.8 Hz sine LFO on SSB.frequency for organic tuning drift.');
  } else if (lpRow >= 0 && hasKeyword('wobble', 'lfo', 'pulse', 'modulat')) {
    lfo = { row: lpRow, param: 'cutoff', shape: 'sine', speed: 2.5, depth: 28 };
    rationale.push('Configured 2.5 Hz sine LFO on LOWPASS.cutoff for rhythmic filter movement.');
  }

  const preset: PresetConfig = {
    id: `ai-preset-${slot}-${Date.now()}`,
    pos: Math.max(0, Math.min(3, slot)),
    name: (customName || description.slice(0, 18).toUpperCase()).trim(),
    comment: description.slice(0, 80),
    list,
    handle,
    shake,
    lfo,
    trigger: { row: sampleRow }
  };

  return { preset, rationale };
}
