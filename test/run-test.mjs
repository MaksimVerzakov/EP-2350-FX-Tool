import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const TMP_TEST_BUILD = path.join(ROOT_DIR, '.tmp-test-build');

/**
 * Transpile TypeScript modules on the fly using Node 22+ built-in type stripper.
 * Zero external bundlers or native binaries needed.
 */
function buildSourceModulesForTest() {
  fs.rmSync(TMP_TEST_BUILD, { recursive: true, force: true });
  fs.mkdirSync(TMP_TEST_BUILD, { recursive: true });

  const filesToCompile = [
    'src/types/config.ts',
    'src/constants/effectsRegistry.ts',
    'src/constants/defaultPresets.ts',
    'src/utils/parser.ts',
    'src/utils/serializer.ts',
    'src/dsp/math.ts',
    'src/dsp/synthSamples.ts',
    'src/dsp/AudioEngine.ts'
  ];

  for (const relPath of filesToCompile) {
    const absIn = path.join(ROOT_DIR, relPath);
    let source = fs.readFileSync(absIn, 'utf8');

    // Handle vite ?raw imports in defaultPresets.ts
    source = source.replace(
      /import\s+([a-zA-Z0-9_]+)\s+from\s+['"]([^'"]+)\?raw['"]/g,
      (match, varName, importPath) => {
        const fullJsonPath = path.resolve(path.dirname(absIn), importPath);
        const jsonContent = fs.readFileSync(fullJsonPath, 'utf8');
        return `const ${varName} = ${JSON.stringify(jsonContent)};`;
      }
    );

    // Handle static asset imports (e.g. speech.mp3 and *.wav in AudioEngine.ts)
    source = source.replace(
      /import\s+([a-zA-Z0-9_]+)\s+from\s+['"]([^'"]+\.(?:mp3|wav))['"];?/g,
      (_, varName, assetPath) => `const ${varName} = ${JSON.stringify(assetPath)};`
    );

    const stripped = stripTypeScriptTypes(source);
    // Rewrite relative imports to .mjs
    const rewritten = stripped.replace(
      /from\s+['"](\.[^'"]+)['"]/g,
      (_, spec) => `from '${spec}.mjs'`
    );

    const absOut = path.join(TMP_TEST_BUILD, relPath.replace(/\.ts$/, '.mjs'));
    fs.mkdirSync(path.dirname(absOut), { recursive: true });
    fs.writeFileSync(absOut, rewritten, 'utf8');
  }
}

buildSourceModulesForTest();

// Load modules
const { EFFECTS_REGISTRY, isPercentParam, getModDepthConfig, MAX_EFFECTS_PER_PRESET } = await import(
  pathToFileURL(path.join(TMP_TEST_BUILD, 'src/constants/effectsRegistry.mjs')).href
);
const { OFFICIAL_TE_PACKS, createEmptyPack } = await import(
  pathToFileURL(path.join(TMP_TEST_BUILD, 'src/constants/defaultPresets.mjs')).href
);
const { parseConfigJson } = await import(
  pathToFileURL(path.join(TMP_TEST_BUILD, 'src/utils/parser.mjs')).href
);
const { serializeToConfigJson, validatePackConfig } = await import(
  pathToFileURL(path.join(TMP_TEST_BUILD, 'src/utils/serializer.mjs')).href
);
const {
  NoiseGateKernel,
  PitchShiftKernel,
  SsbFrequencyShiftKernel,
  computeLfoWave,
  cutoffToHz,
  hann,
  makeDistortionCurve,
  makeSoftClipCurve,
  resolveModDepth
} = await import(
  pathToFileURL(path.join(TMP_TEST_BUILD, 'src/dsp/math.mjs')).href
);
const { DspAudioEngine, BUNDLED_SAMPLES } = await import(
  pathToFileURL(path.join(TMP_TEST_BUILD, 'src/dsp/AudioEngine.mjs')).href
);

// Clean up on exit
process.on('exit', () => {
  fs.rmSync(TMP_TEST_BUILD, { recursive: true, force: true });
});

console.log('=== RUNNING EP-2350 FULL COMPREHENSIVE TEST SUITE ===\n');

// ---------------------------------------------------------------------------
// SUITE 1: Official Teenage Engineering Preset Packs Lossless Round-Trip
// ---------------------------------------------------------------------------
assert.strictEqual(OFFICIAL_TE_PACKS.length, 3, 'Must have 3 official preset packs');
const officialPackFiles = [
  'packs/ep-2350_preset_pack-broken_radio/config.json',
  'packs/ep-2350_preset_pack-dub/config.json',
  'packs/ep-2350_preset_pack-mysterious/config.json'
];

for (const relPackPath of officialPackFiles) {
  const fullPath = path.join(ROOT_DIR, relPackPath);
  const rawJson = fs.readFileSync(fullPath, 'utf8');
  const originalObj = JSON.parse(rawJson);

  const parsedResult = parseConfigJson(rawJson);
  assert.strictEqual(parsedResult.error, undefined, `Pack ${relPackPath} should parse without error`);
  assert.ok(parsedResult.pack, `Pack ${relPackPath} must return a pack object`);
  assert.strictEqual(parsedResult.pack.presets.length, 4, `Pack ${relPackPath} must have 4 presets`);

  // Validate official pack produces zero validation errors
  const validationIssues = validatePackConfig(parsedResult.pack);
  const errors = validationIssues.filter((i) => i.type === 'error');
  assert.strictEqual(errors.length, 0, `Official pack ${relPackPath} must have 0 validation errors`);

  // Round-trip back to config.json and compare deeply with official TE hardware config
  const reserializedJson = serializeToConfigJson(parsedResult.pack);
  const reserializedObj = JSON.parse(reserializedJson);

  assert.deepStrictEqual(
    reserializedObj,
    originalObj,
    `Lossless round-trip failed for official pack: ${relPackPath}`
  );
  console.log(`✓ Suite 1: Official TE Pack round-trip verified (${originalObj.name})`);
}

// ---------------------------------------------------------------------------
// SUITE 2: Effects Registry & Modulation Depth Unit Scaling
// ---------------------------------------------------------------------------
const expectedEffects = [
  'DELAY', 'DIST', 'EQUALISER', 'HARMONY', 'LOWPASS',
  'HIGHPASS', 'SAMPLE', 'REVERB', 'RING', 'SSB', 'BALANCE'
];
for (const fxName of expectedEffects) {
  assert.ok(EFFECTS_REGISTRY[fxName], `EFFECTS_REGISTRY must define ${fxName}`);
}

assert.strictEqual(MAX_EFFECTS_PER_PRESET, 16, 'Hardware limit MAX_EFFECTS_PER_PRESET must be 16');
const delayTimeParam = EFFECTS_REGISTRY.DELAY.params.find((p) => p.name === 'time');
assert.strictEqual(delayTimeParam.max, 1.1, 'DELAY.time max must be 1.1s per fx.map() hardware ceiling');
assert.strictEqual(getModDepthConfig('DELAY', 'time').max, 1.1, 'DELAY.time mod depth max must be 1.1s');
assert.strictEqual(getModDepthConfig('DELAY', 'time').min, -1.1, 'DELAY.time mod depth min must be -1.1s');

// Native units
assert.strictEqual(getModDepthConfig('SSB', 'frequency').isNormalizedPercent, false);
assert.strictEqual(getModDepthConfig('SSB', 'frequency').unit, 'Hz');
assert.strictEqual(getModDepthConfig('RING', 'frequency').isNormalizedPercent, false);
assert.strictEqual(getModDepthConfig('HARMONY', 'pitch').isNormalizedPercent, false);
assert.strictEqual(getModDepthConfig('HARMONY', 'pitch').unit, 'x');
assert.strictEqual(getModDepthConfig('DELAY', 'time').isNormalizedPercent, false);
assert.strictEqual(getModDepthConfig('DELAY', 'time').unit, 's');
assert.strictEqual(getModDepthConfig('SAMPLE', 'pitch').isNormalizedPercent, false);
assert.strictEqual(getModDepthConfig('SAMPLE', 'speed').isNormalizedPercent, false);
assert.strictEqual(getModDepthConfig('DIST', 'amount').isNormalizedPercent, false);

// Percentage units
assert.strictEqual(getModDepthConfig('LOWPASS', 'cutoff').isNormalizedPercent, true);
assert.strictEqual(getModDepthConfig('DIST', 'mix').isNormalizedPercent, true);
assert.strictEqual(getModDepthConfig('DELAY', 'echo').isNormalizedPercent, true);
assert.strictEqual(getModDepthConfig('REVERB', 'time').isNormalizedPercent, true);
assert.strictEqual(getModDepthConfig('BALANCE', 'balance').isNormalizedPercent, true);

assert.strictEqual(isPercentParam('LOWPASS', 'cutoff'), false);
assert.strictEqual(isPercentParam('DIST', 'mix'), true);
console.log('✓ Suite 2: Effects Registry & Modulation Depth units verified');

// ---------------------------------------------------------------------------
// SUITE 3: Validator Constraints & Out-of-Bounds Checks
// ---------------------------------------------------------------------------
const invalidPack = {
  name: '   ',
  useBuiltInSamples: true,
  samples: [],
  presets: [
    {
      id: 'p0',
      pos: 0,
      name: 'BROKEN CHAIN',
      comment: '',
      list: [
        { id: '1', effect: 'DELAY', time: 0.4 },
        { id: '2', effect: 'DELAY', time: 0.2 },
        { id: '3', effect: 'HARMONY', pitch: 1.2 },
        { id: '4', effect: 'HARMONY', pitch: 0.8 }
      ],
      handle: { row: 9, param: 'cutoff', depth: 50 },
      shake: { row: -1, param: 'mix', depth: 50 },
      lfo: { row: 8, param: 'cutoff', depth: 50, shape: 'sine', speed: 2 }
    }
  ]
};

const issues = validatePackConfig(invalidPack);
assert.ok(issues.some((i) => i.type === 'warning' && i.message.includes('Pack name is empty')));
assert.ok(issues.some((i) => i.type === 'warning' && i.message.includes('Missing')));
assert.ok(issues.some((i) => i.type === 'error' && i.message.includes("'DELAY' can only be used once")));
assert.ok(issues.some((i) => i.type === 'error' && i.message.includes("'HARMONY' can only be used once")));
assert.ok(issues.some((i) => i.type === 'error' && i.message.includes('Handle targets row 9')));
assert.ok(issues.some((i) => i.type === 'error' && i.message.includes('Shake targets row -1')));
assert.ok(issues.some((i) => i.type === 'error' && i.message.includes('LFO targets row 8')));

// Verify 16-row hardware limit and EQUALISER firmware compatibility warning
const oversizedPresetPack = {
  name: 'OVERSIZED',
  useBuiltInSamples: true,
  samples: [],
  presets: [
    {
      id: 'p-over',
      pos: 0,
      name: 'TOO MANY FX',
      comment: '',
      list: [
        ...Array.from({ length: 16 }, (_, idx) => ({ id: `fx-${idx}`, effect: 'LOWPASS', cutoff: 0.5 })),
        { id: 'fx-eq', effect: 'EQUALISER', CUTOFF: 0.5, Q: 0.5, GAIN: 0.0 },
        { id: 'fx-s', effect: 'SAMPLE' }
      ]
    }
  ]
};
const oversizedIssues = validatePackConfig(oversizedPresetPack);
assert.ok(
  oversizedIssues.some((i) => i.type === 'error' && i.message.includes('Exceeds hardware limit of 16 effects')),
  'Validator must report an error when a preset exceeds 16 effects'
);
assert.ok(
  oversizedIssues.some((i) => i.type === 'warning' && i.message.includes("'EQUALISER' is documented in the TE guide")),
  'Validator must warn about EQUALISER firmware <= 1.0.8 compatibility'
);
console.log('✓ Suite 3: Validator constraints, 16-row hardware limit & out-of-bounds modulation checks verified');

// ---------------------------------------------------------------------------
// SUITE 4: Parser Resilience, Custom Samples, Parallel Buses & Bipolar Depths
// ---------------------------------------------------------------------------
assert.ok(parseConfigJson('not-valid-json').error, 'Malformed JSON must return error');
assert.ok(parseConfigJson('null').error, 'Non-object JSON root must return error');

const singlePresetRaw = JSON.stringify({
  name: 'CUSTOM DUB',
  samples: [
    { pos: 0, file: 'samples/siren.wav', playmode: 'oneshot' },
    { pos: 1, file: 'samples/sub.wav', playmode: 'hold' }
  ],
  presets: [
    {
      pos: 0,
      name: 'PARALLEL BUS',
      comment: 'bus 1 and bus 2 split',
      list: [
        { effect: 'HARMONY', pitch: 1.5, 'dry-level': 0.4, BUS: 2 },
        { effect: 'DELAY', time: 0.5, echo: 0.6, BUS: 1 },
        { effect: 'SAMPLE', speed: 1.0, pitch: -12 }
      ],
      handle: { target: 'lfo', param: 'speed', depth: -6.5 },
      shake: { row: 1, param: 'echo', depth: -0.4 },
      lfo: { row: 0, param: 'pitch', depth: -0.25, shape: 'sawtooth', speed: 3.5, phase: 0.5 },
      trigger: { row: 2 }
    }
  ]
});

const customParsed = parseConfigJson(singlePresetRaw);
assert.strictEqual(customParsed.error, undefined);
assert.strictEqual(customParsed.pack.useBuiltInSamples, false);
assert.strictEqual(customParsed.pack.samples.length, 2);
assert.strictEqual(customParsed.pack.presets.length, 4, 'Missing slots 1..3 must be auto-populated');
assert.strictEqual(customParsed.pack.presets[0].shake.depth, -40, 'Normalized -0.4 depth -> -40% in UI');
assert.strictEqual(customParsed.pack.presets[0].lfo.depth, -0.25, 'HARMONY.pitch depth stays -0.25x');

const customReserialized = JSON.parse(serializeToConfigJson(customParsed.pack));
assert.strictEqual(customReserialized.samples.length, 2);
assert.strictEqual(customReserialized.presets[0].handle.target, 'lfo');
assert.strictEqual(customReserialized.presets[0].handle.depth, -6.5);
assert.strictEqual(customReserialized.presets[0].shake.depth, -0.4);
assert.strictEqual(customReserialized.presets[0].lfo.depth, -0.25);
assert.strictEqual(customReserialized.presets[0].lfo.phase, 0.5);

// 4b. 1% and -1% parameter and modulation depth round-trip (regression test for > 1 bug)
const onePercentJson = JSON.stringify({
  name: 'ONE PERCENT TEST',
  presets: [
    {
      pos: 0,
      name: 'SUBTLE',
      list: [
        { effect: 'DIST', amount: 10, mix: 0.01, 'lowpass-cutoff': 0.01, 'highpass-cutoff': 0.01 },
        { effect: 'DELAY', time: 0.35, echo: 0.01, 'wet-level': 0.01, 'dry-level': 0.01 },
        { effect: 'SAMPLE', level: 0.01 }
      ],
      handle: { row: 0, param: 'mix', depth: 0.01 },
      shake: { row: 1, param: 'echo', depth: -0.01 },
      lfo: { row: 1, param: 'wet-level', depth: 0.01, shape: 'sine', speed: 2.0 }
    }
  ]
});
const onePercentParsed = parseConfigJson(onePercentJson);
assert.strictEqual(onePercentParsed.error, undefined);
const p0 = onePercentParsed.pack.presets[0];
assert.strictEqual(p0.list[0].mix, 1, '0.01 JSON mix must parse to 1% in UI');
assert.strictEqual(p0.list[1].echo, 1, '0.01 JSON echo must parse to 1% in UI');
assert.strictEqual(p0.handle.depth, 1, '0.01 JSON handle depth must parse to 1% in UI');
assert.strictEqual(p0.shake.depth, -1, '-0.01 JSON shake depth must parse to -1% in UI');
assert.strictEqual(p0.lfo.depth, 1, '0.01 JSON lfo depth must parse to 1% in UI');

const onePercentReserialized = JSON.parse(serializeToConfigJson(onePercentParsed.pack)).presets[0];
assert.strictEqual(onePercentReserialized.list[0].mix, 0.01, '1% UI mix must serialize back to 0.01 (not 1.0)');
assert.strictEqual(onePercentReserialized.list[0]['lowpass-cutoff'], 0.01, '1% LP cutoff must serialize to 0.01');
assert.strictEqual(onePercentReserialized.list[1].echo, 0.01, '1% UI echo must serialize back to 0.01');
assert.strictEqual(onePercentReserialized.list[1]['wet-level'], 0.01, '1% wet-level must serialize back to 0.01');
assert.strictEqual(onePercentReserialized.list[2].level, 0.01, '1% sample level must serialize back to 0.01');
assert.strictEqual(onePercentReserialized.handle.depth, 0.01, '+1% handle depth must serialize to 0.01');
assert.strictEqual(onePercentReserialized.shake.depth, -0.01, '-1% shake depth must serialize to -0.01');
assert.strictEqual(onePercentReserialized.lfo.depth, 0.01, '+1% lfo depth must serialize to 0.01');

// 4c. Security hardening: prototype pollution stripping, array roots, and bounded array lengths
assert.ok(parseConfigJson('[]').error, 'Array JSON root must return error');
assert.ok(parseConfigJson('42').error, 'Primitive JSON root must return error');
const pollutedRaw =
  '{"name":"SEC","samples":' +
  JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ pos: i, file: `${i}.wav` }))) +
  ',"presets":[{"pos":0,"list":' +
  JSON.stringify([
    { effect: 'DIST', mix: 0.5, BUS: '2', __proto__: { polluted: true }, constructor: { bad: 1 }, nested: { drop: true } },
    { effect: 'LOWPASS', cutoff: 0.5, BUS: 99 },
    ...Array.from({ length: 20 }, () => ({ effect: 'HIGHPASS', cutoff: 0.2, BUS: 0 }))
  ]) +
  ',"handle":{"target":"lfo"}}]}';
const secParsed = parseConfigJson(pollutedRaw);
assert.strictEqual(secParsed.error, undefined);
assert.strictEqual(({}).polluted, undefined, 'Object.prototype must not be polluted');
assert.strictEqual(secParsed.pack.samples.length, 64, 'Samples array must be capped at 64 items');
assert.strictEqual(secParsed.pack.presets[0].list.length, 16, 'Effect list must be capped at 16 items per hardware limit');
assert.strictEqual(secParsed.pack.presets[0].list[0].BUS, 2, 'Numeric string BUS "2" must coerce to number 2');
assert.strictEqual(secParsed.pack.presets[0].list[1].BUS, undefined, 'Invalid BUS 99 must be stripped');
assert.strictEqual(secParsed.pack.presets[0].list[2].BUS, undefined, 'Invalid BUS 0 must be stripped');
assert.strictEqual(secParsed.pack.presets[0].list[0].nested, undefined, 'Nested object properties on effects must be stripped');
assert.strictEqual(secParsed.pack.presets[0].handle.param, 'speed', 'LFO-targeted handle must default param to speed');
console.log('✓ Suite 4: Parser resilience, 1% round-trip, security hardening & bipolar depths verified');

// ---------------------------------------------------------------------------
// SUITE 5: Pure DSP Math Functions (src/dsp/math.ts)
// ---------------------------------------------------------------------------
// 5a. Cutoff mapping
assert.strictEqual(cutoffToHz(0), 20);
assert.ok(Math.abs(cutoffToHz(1) - 20000) < 1e-4);
assert.ok(Math.abs(cutoffToHz(0.5) - 20 * Math.sqrt(1000)) < 1e-4);

// 5b. resolveModDepth (Verifies bug fix where 1% was misidentified as 100%)
assert.ok(Math.abs(resolveModDepth('LOWPASS', 'cutoff', 1) - 0.01) < 1e-6, '1% cutoff depth must equal 0.01 ratio');
assert.strictEqual(resolveModDepth('LOWPASS', 'cutoff', 50), 0.5);
assert.strictEqual(resolveModDepth('DIST', 'mix', -100), -1);
assert.strictEqual(resolveModDepth('SSB', 'frequency', 1000), 1000);
assert.strictEqual(resolveModDepth('DELAY', 'time', 0.005), 0.005);
assert.strictEqual(resolveModDepth('HARMONY', 'pitch', -0.5), -0.5);

// 5c. LFO shapes & phase offset
assert.ok(Math.abs(computeLfoWave('sine', 0, 1) - 0) < 1e-6);
assert.ok(Math.abs(computeLfoWave('sine', 0.25, 1) - 1) < 1e-6);
assert.ok(Math.abs(computeLfoWave('sine', 0, 1, 0.25) - 1) < 1e-6, 'Phase offset 0.25 at t=0 must peak at 1.0');
assert.strictEqual(computeLfoWave('square', 0.1, 10), 1);
assert.strictEqual(computeLfoWave('square', 0.06, 10), -1);
assert.ok(Math.abs(computeLfoWave('sawtooth', 0.25, 1) - 0.5) < 1e-6);
const randVal = computeLfoWave('random', 1.2, 2);
assert.strictEqual(randVal, computeLfoWave('random', 1.4, 2));

// 5d. Waveshaper curves
const distCurve = makeDistortionCurve(0, 1000);
// i=500 is exactly x=0
assert.strictEqual(distCurve[500], 0, 'Zero-crossing at x=0 must be exactly 0');
assert.ok(distCurve[750] / 0.5 > distCurve[999] / 1.0, 'amount: 0 must have warm saturation curve');
const clipCurve = makeSoftClipCurve(512);
assert.ok(Math.max(...clipCurve) <= Math.tanh(1.4) + 1e-6);

// 5e. Hann window partition of unity
for (let p = 0; p < 1; p += 0.05) {
  assert.ok(Math.abs(hann(p) + hann((p + 0.5) % 1) - 1.0) < 1e-12);
}

// 5f. NoiseGateKernel hysteresis & noise floor suppression
const gate = new NoiseGateKernel(48000, -46, -52, 0.05);
const silentBlock = new Float32Array(24000); // 0.5s of silence
const gateOutSilent = new Float32Array(24000);
gate.process(silentBlock, gateOutSilent);
assert.ok(gate.getGain() < 0.06, `NoiseGateKernel must close to ~0.05 floor on silence (got ${gate.getGain().toFixed(4)})`);

const loudBlock = new Float32Array(4800); // 0.1s of loud signal
loudBlock.fill(0.5);
const gateOutLoud = new Float32Array(4800);
gate.process(loudBlock, gateOutLoud);
assert.ok(gate.getGain() > 0.99, `NoiseGateKernel must open to ~1.0 on active signal (got ${gate.getGain().toFixed(4)})`);
console.log('✓ Suite 5: Pure DSP Math functions verified (cutoff, resolveModDepth, LFO shapes, waveshapers, NoiseGateKernel)');

// ---------------------------------------------------------------------------
// SUITE 6: PitchShiftKernel Constant Speed & Accurate Pitch Shifting
// ---------------------------------------------------------------------------
const sampleRate = 48000;
const durationSamples = 48000;
const baseFreq = 220;
const sine220 = new Float32Array(durationSamples);
for (let i = 0; i < durationSamples; i++) {
  sine220[i] = Math.sin((2 * Math.PI * baseFreq * i) / sampleRate);
}

function runShifter(signal, pitch) {
  const kernel = new PitchShiftKernel(pitch);
  const out = new Float32Array(signal.length);
  const blockSize = 512;
  for (let i = 0; i < signal.length; i += blockSize) {
    kernel.process(signal.subarray(i, i + blockSize), out.subarray(i, i + blockSize));
  }
  return out;
}

// Bit-transparent at unity
const out1x = runShifter(sine220, 1.0);
assert.strictEqual(out1x.length, durationSamples);
for (let i = 0; i < durationSamples; i++) {
  assert.ok(Math.abs(out1x[i] - sine220[i]) < 1e-6, 'Unity pitch must be bit-transparent');
}

function estimateFundamentalHz(signal, sr) {
  const windowLen = 1024;
  const minLag = Math.floor(sr / 800);
  const maxLag = Math.floor(sr / 60);
  const acc = new Float64Array(maxLag + 1);
  for (let f = Math.floor(sr * 0.2); f + windowLen + maxLag < signal.length; f += 512) {
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0;
      for (let i = 0; i < windowLen; i++) s += signal[f + i] * signal[f + i + lag];
      acc[lag] += s;
    }
  }
  let bestLag = minLag;
  let inPeak = false;
  let maxVal = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (!inPeak && acc[lag] < 0 && acc[lag + 1] >= 0) inPeak = true;
    if (inPeak) {
      if (acc[lag] > maxVal) {
        maxVal = acc[lag];
        bestLag = lag;
      } else if (acc[lag] < 0) break;
    }
  }
  return sr / bestLag;
}

const out2x = runShifter(sine220, 2.0);
const outHalf = runShifter(sine220, 0.5);
assert.strictEqual(out2x.length, durationSamples, 'Duration must remain 1.0x at 2.0x pitch');
assert.strictEqual(outHalf.length, durationSamples, 'Duration must remain 1.0x at 0.5x pitch');

const hz2x = estimateFundamentalHz(out2x, sampleRate);
const hzHalf = estimateFundamentalHz(outHalf, sampleRate);

assert.ok(Math.abs(hz2x - 440) < 10, `2.0x pitch of 220Hz should be ~440Hz (got ${hz2x.toFixed(1)}Hz)`);
assert.ok(Math.abs(hzHalf - 110) < 5, `0.5x pitch of 220Hz should be ~110Hz (got ${hzHalf.toFixed(1)}Hz)`);
const dynamicKernel = new PitchShiftKernel(1.0);
dynamicKernel.setPitch(1.5);
dynamicKernel.process(sine220.subarray(0, 4096), new Float32Array(4096));
assert.ok(Math.abs(dynamicKernel.getPitch() - 1.5) < 1e-3);
console.log(
  `✓ Suite 6a: PitchShiftKernel verified (220Hz -> 0.5x=${hzHalf.toFixed(1)}Hz, 2.0x=${hz2x.toFixed(1)}Hz at constant speed)`
);

// 6b. SsbFrequencyShiftKernel Hilbert Quadrature Single-Sideband Frequency Shifter
const ssbN = 24000;
const sine440 = new Float32Array(ssbN);
for (let i = 0; i < ssbN; i++) {
  sine440[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate);
}

function measurePeakDftHz(sig, sr) {
  const start = 4000;
  const len = 8000;
  let bestHz = 0;
  let bestMag = -1;
  for (let f = 100; f <= 1000; f += 2) {
    let re = 0;
    let im = 0;
    for (let n = 0; n < len; n++) {
      const ang = (2 * Math.PI * f * n) / sr;
      re += sig[start + n] * Math.cos(ang);
      im -= sig[start + n] * Math.sin(ang);
    }
    const mag = Math.hypot(re, im);
    if (mag > bestMag) {
      bestMag = mag;
      bestHz = f;
    }
  }
  return bestHz;
}

const ssbUp = new SsbFrequencyShiftKernel(200, sampleRate);
const outSsbUp = new Float32Array(ssbN);
ssbUp.process(sine440, outSsbUp);
const peakUpHz = measurePeakDftHz(outSsbUp, sampleRate);
assert.ok(Math.abs(peakUpHz - 640) <= 4, `+200Hz SSB shift of 440Hz must peak at 640Hz (got ${peakUpHz}Hz)`);

const ssbDown = new SsbFrequencyShiftKernel(-200, sampleRate);
const outSsbDown = new Float32Array(ssbN);
ssbDown.process(sine440, outSsbDown);
const peakDownHz = measurePeakDftHz(outSsbDown, sampleRate);
assert.ok(Math.abs(peakDownHz - 240) <= 4, `-200Hz SSB shift of 440Hz must down-shift to 240Hz (got ${peakDownHz}Hz)`);

const ssbZero = new SsbFrequencyShiftKernel(0, sampleRate);
const outSsbZero = new Float32Array(ssbN);
ssbZero.process(sine440, outSsbZero);
for (let i = 0; i < ssbN; i++) {
  assert.ok(Math.abs(outSsbZero[i] - sine440[i]) < 1e-6, '0Hz SSB shift must be bit-transparent');
}
ssbZero.setFrequency(-500);
ssbZero.process(sine440.subarray(0, 4096), new Float32Array(4096));
assert.ok(Math.abs(ssbZero.getFrequency() - -500) < 1e-2);
assert.strictEqual(SsbFrequencyShiftKernel.clampFreq(99999), 20000);
assert.strictEqual(SsbFrequencyShiftKernel.clampFreq(-99999), -20000);
assert.strictEqual(SsbFrequencyShiftKernel.clampFreq(NaN), 0);
console.log(
  `✓ Suite 6b: SsbFrequencyShiftKernel Hilbert SSB verified (440Hz -> -200Hz=${peakDownHz}Hz, +200Hz=${peakUpHz}Hz)`
);

// -----------------------------------------------------------------------------
// Suite 7: UX Behavior Verification (Lever Defaults to Pressed & Cartoon Shake)
// -----------------------------------------------------------------------------
const micDeviceSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/components/MicDevice.tsx'), 'utf8');
const topBannerSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/components/TopBanner.tsx'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/App.tsx'), 'utf8');
const themeCss = fs.readFileSync(path.join(ROOT_DIR, 'src/styles/te-theme.css'), 'utf8');

// 1. Lever defaults to fully pressed (1.0) in App.tsx
assert.ok(
  /useState(?:<number>)?\(1(?:\.0)?\)/.test(appSrc),
  'handlePos must initialize to 1.0 (fully pressed by default)'
);

// 2. MicDevice maintains stationary main mic without image flicking
assert.ok(
  !micDeviceSrc.includes("isShakingFlash ? 'scale-[1.02] -rotate-1' : ''"),
  'Main mic container must not scale or rotate when shaking or clicking buttons'
);

// 3. Cartoon shake afterimages & two horizontal orange affordance arrows ("Push ->" and "Shake ->")
assert.ok(
  themeCss.includes('cartoonShakeGhost1') && themeCss.includes('cartoonShakeGhost2'),
  'CSS keyframes must define cartoonShakeGhost1 and cartoonShakeGhost2'
);
assert.ok(
  micDeviceSrc.includes('cartoonShakeGhost1') && micDeviceSrc.includes('cartoonShakeGhost2'),
  'MicDevice must render ghost afterimages during cartoon shake'
);
assert.ok(
  !micDeviceSrc.includes('Top-Right Curved Motion Arrow') &&
    !micDeviceSrc.includes('Bottom-Left Curved Motion Arrow') &&
    !micDeviceSrc.includes('Lever press and release indicator arrow'),
  'Previous curved arrows must be removed'
);
assert.ok(
  micDeviceSrc.includes('Push lever indicator arrow') &&
    micDeviceSrc.includes('Shake Mic FX block indicator arrow') &&
    micDeviceSrc.includes('Push') &&
    micDeviceSrc.includes('Shake'),
  'MicDevice must render two horizontal orange arrows ("Push ->" to middle of lever and "Shake ->" to middle of Mic FX block)'
);
assert.ok(
  !micDeviceSrc.includes('!isInMotion') && micDeviceSrc.includes('y1="116"'),
  'Orange indicator arrows must remain visible during push/shake and Push arrow must sit at the visual middle of the lever'
);

// 4. Shake is triggered on the lower chassis faceplate block (Mic FX / Ting FX), NOT on wire or buttons
assert.ok(
  micDeviceSrc.includes('Click Mic FX block to SHAKE') &&
    !micDeviceSrc.includes('Click bottom of mic to SHAKE'),
  'Shake must be triggered on the Mic FX / Ting FX lower faceplate block, not the wire section'
);
assert.ok(
  micDeviceSrc.includes('stopPropagation') && !micDeviceSrc.includes('onClick={triggerShakeWithFlash}'),
  'Buttons and wire section must not trigger shake'
);

// 5. TopBanner right block matches left block size & 2-row format ([EXPORT][IMPORT] on top, dropdown below + New Pack option)
assert.strictEqual(
  (topBannerSrc.match(/w-\[236px\] h-\[66px\]/g) || []).length,
  2,
  'Both left and right TopBanner blocks must share identical 236x66 modular dimensions'
);
assert.ok(
  topBannerSrc.includes('aria-label="Export and Import actions"') &&
    topBannerSrc.includes('aria-label="Select default pack"') &&
    topBannerSrc.includes('NEW PACK') &&
    topBannerSrc.includes('onCreateNewPack'),
  'Right TopBanner block must have Export & Import buttons on top row, pack dropdown below, and + New Pack action'
);

// 6. PresetLedger does not rescale <= 1.0 modulation depths or inject default phase: 0
const presetLedgerSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/components/PresetLedger.tsx'), 'utf8');
assert.ok(
  !presetLedgerSrc.includes('Math.abs(preset.handle.depth) <= 1.0') &&
    !presetLedgerSrc.includes('Math.abs(preset.shake.depth) <= 1.0') &&
    !presetLedgerSrc.includes('Math.abs(preset.lfo.depth) <= 1.0'),
  'PresetLedger must not multiply <= 1.0 UI modulation depths by 100 on render'
);
assert.ok(
  !presetLedgerSrc.includes('phase: 0'),
  'PresetLedger must not inject spurious phase: 0 when toggling LFO ON'
);

console.log('✓ Suite 7: UX horizontal Push/Shake arrows, Mic FX block shake & balanced TopBanner verified');

// -----------------------------------------------------------------------------
// SUITE 8: DspAudioEngine Graph Routing, Live Modulation, Safety Limiter & Race Protection
// -----------------------------------------------------------------------------
function createMockAudioParam(initial = 0) {
  return {
    value: initial,
    setTargetAtTime(val) {
      this.value = val;
    }
  };
}

class MockAudioNode {
  constructor() {
    this.connections = [];
  }
  connect(target) {
    this.connections.push(target);
    return target;
  }
  disconnect() {
    this.connections = [];
  }
}

class MockAudioContext {
  constructor() {
    this.sampleRate = 48000;
    this.currentTime = 0.25; // quarter second
    this.state = 'running';
    this.destination = new MockAudioNode();
  }
  async resume() {
    this.state = 'running';
  }
  createBuffer(channels, length, sampleRate) {
    const chData = Array.from({ length: channels }, () => new Float32Array(length));
    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      getChannelData: (c) => chData[c]
    };
  }
  createBufferSource() {
    const node = new MockAudioNode();
    node.buffer = null;
    node.loop = false;
    node.playbackRate = createMockAudioParam(1.0);
    node.started = false;
    node.stopped = false;
    node.start = () => {
      node.started = true;
    };
    node.stop = () => {
      node.stopped = true;
    };
    return node;
  }
  createGain() {
    const node = new MockAudioNode();
    node.gain = createMockAudioParam(1.0);
    return node;
  }
  createAnalyser() {
    const node = new MockAudioNode();
    node.fftSize = 256;
    return node;
  }
  createDynamicsCompressor() {
    const node = new MockAudioNode();
    node.threshold = createMockAudioParam(-24);
    node.knee = createMockAudioParam(30);
    node.ratio = createMockAudioParam(12);
    node.attack = createMockAudioParam(0.003);
    node.release = createMockAudioParam(0.25);
    return node;
  }
  createBiquadFilter() {
    const node = new MockAudioNode();
    node.type = 'lowpass';
    node.frequency = createMockAudioParam(350);
    node.Q = createMockAudioParam(1.0);
    node.gain = createMockAudioParam(0.0);
    return node;
  }
  createWaveShaper() {
    const node = new MockAudioNode();
    node.curve = null;
    node.oversample = 'none';
    return node;
  }
  createDelay() {
    const node = new MockAudioNode();
    node.delayTime = createMockAudioParam(0.0);
    return node;
  }
  createOscillator() {
    const node = new MockAudioNode();
    node.type = 'sine';
    node.frequency = createMockAudioParam(440);
    node.start = () => {};
    node.stop = () => {};
    return node;
  }
  createStereoPanner() {
    const node = new MockAudioNode();
    node.pan = createMockAudioParam(0.0);
    return node;
  }
  createScriptProcessor() {
    const node = new MockAudioNode();
    node.onaudioprocess = null;
    return node;
  }
  createMediaStreamSource(stream) {
    const node = new MockAudioNode();
    node.mediaStream = stream;
    return node;
  }
}

globalThis.window = { AudioContext: MockAudioContext };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.fetch = async () => ({ ok: false });

const engine = new DspAudioEngine();
await engine.init();

// 8a. Master brickwall safety limiter verification
const limiter = engine.getSafetyLimiter();
assert.ok(limiter, 'DspAudioEngine must initialize a master safetyLimiter');
assert.strictEqual(limiter.threshold.value, -0.5, 'Safety limiter threshold must be -0.5 dB');
assert.strictEqual(limiter.knee.value, 0.0, 'Safety limiter must use hard knee (0 dB)');
assert.strictEqual(limiter.ratio.value, 20.0, 'Safety limiter ratio must be 20:1');
assert.strictEqual(limiter.attack.value, 0.001, 'Safety limiter attack must be 1ms');
assert.ok(engine.gainMaster.connections.includes(limiter), 'gainMaster must connect into safetyLimiter');
assert.ok(limiter.connections.includes(engine.ctx.destination), 'safetyLimiter must connect to ctx.destination');

// 8b. Build full multi-effect chain with Bus 1 + Bus 2 and verify 1% ratio & live parameter updates
const testPreset = {
  id: 'test-p',
  pos: 0,
  name: 'ENGINE TEST',
  comment: '',
  list: [
    { id: 'fx0', effect: 'DIST', amount: 5, mix: 1, 'lowpass-cutoff': 50, 'highpass-cutoff': 10, BUS: 1 },
    { id: 'fx1', effect: 'DELAY', time: 0.4, echo: 1, 'wet-level': 1, 'dry-level': 80, balance: 0.5, BUS: 1 },
    { id: 'fx2', effect: 'REVERB', time: 0.5, 'spring-mix': 1, 'highpass-cutoff': 20, 'wet-level': 50, 'dry-level': 100, BUS: 2 },
    { id: 'fx3', effect: 'RING', frequency: 300, mix: 1, BUS: 2 },
    { id: 'fx4', effect: 'EQUALISER', CUTOFF: 0.5, Q: 0.5, GAIN: 0.2, BUS: 1 },
    { id: 'fx5', effect: 'SAMPLE', speed: 1.0, pitch: 0, level: 1, BUS: 1 }
  ],
  handle: { row: 0, param: 'amount', depth: 20 },
  shake: { row: 3, param: 'mix', depth: 50 },
  lfo: { row: 4, param: 'GAIN', depth: 50, shape: 'sine', speed: 1.0, phase: 0.0 }
};

engine.updatePreset(testPreset);
engine.updateModulation({ handlePos: 0.0, shakeAmount: 0.0 });
await engine.start();
assert.strictEqual(engine.getIsRunning(), true, 'Engine must be running after start()');

// Verify RP2350 pre-chain inputCompressor + inputNoiseGate routing ahead of sourceHub
const inputComp = engine.getInputCompressor();
const inputGate = engine.getInputNoiseGate();
assert.ok(inputComp, 'Engine must instantiate hardware pre-chain inputCompressor');
assert.ok(inputGate, 'Engine must instantiate hardware pre-chain inputNoiseGate');
assert.ok(engine.sourceNode.connections.includes(inputComp), 'sourceNode must feed into inputCompressor');
assert.ok(inputComp.connections.includes(inputGate), 'inputCompressor must feed into inputNoiseGate');
assert.ok(inputGate.connections.includes(engine.sourceHub), 'inputNoiseGate must feed into sourceHub');

const distNode = engine.activeNodes.find((n) => n.effectType === 'DIST');
const delayNode = engine.activeNodes.find((n) => n.effectType === 'DELAY');
const reverbNode = engine.activeNodes.find((n) => n.effectType === 'REVERB');
const ringNode = engine.activeNodes.find((n) => n.effectType === 'RING');
const eqNode = engine.activeNodes.find((n) => n.effectType === 'EQUALISER');
const sampleNode = engine.activeNodes.find((n) => n.effectType === 'SAMPLE');

// Verify 1% UI values map to 0.01 gain ratio (not 1.0!)
assert.ok(Math.abs(distNode.nodeRefs.wetGain.gain.value - 0.01) < 1e-6, 'DIST 1% mix must set wetGain to 0.01');
assert.ok(Math.abs(delayNode.nodeRefs.feedbackGain.gain.value - 0.01) < 1e-6, 'DELAY 1% echo must set feedbackGain to 0.01');
assert.ok(Math.abs(delayNode.nodeRefs.wetGain.gain.value - 0.01) < 1e-6, 'DELAY 1% wet-level must set wetGain to 0.01');
assert.ok(Math.abs(ringNode.nodeRefs.wetGain.gain.value - 0.01) < 1e-6, 'RING 1% mix must set wetGain to 0.01');
assert.ok(Math.abs(sampleNode.nodeRefs.gain.gain.value - 0.01) < 1e-6, 'SAMPLE 1% level must set gain to 0.01');

// Verify live parameter updates without rebuilding topology
const updatedPreset = {
  ...testPreset,
  list: [
    { ...testPreset.list[0], amount: 25, mix: 60 },
    { ...testPreset.list[1], balance: 1.0, 'lowpass-cutoff': 25 },
    { ...testPreset.list[2], time: 0.9, 'highpass-cutoff': 80 },
    { ...testPreset.list[3], mix: 75 },
    { ...testPreset.list[4], Q: 0.9 },
    { ...testPreset.list[5], speed: 1.75, level: 90, balance: 0.0 }
  ]
};
engine.updatePreset(updatedPreset);

assert.strictEqual(distNode.nodeRefs.lastAmount, 25, 'Live DIST.amount update must regenerate distortion curve');
assert.ok(Math.abs(distNode.nodeRefs.wetGain.gain.value - 0.6) < 1e-6, 'Live DIST.mix update must update wetGain');
assert.strictEqual(delayNode.nodeRefs.wetPanner.pan.value, 1.0, 'Live DELAY.balance update must pan wetPanner to +1');
assert.ok(Math.abs(reverbNode.nodeRefs.hpFilter.frequency.value - cutoffToHz(0.8)) < 1e-3, 'Live REVERB.highpass-cutoff must update hpFilter');
assert.ok(Math.abs(ringNode.nodeRefs.wetGain.gain.value - 0.75) < 1e-6, 'Live RING.mix must update wetGain');
assert.ok(Math.abs(eqNode.nodeRefs.eq.Q.value - 9.0) < 1e-6, 'Live EQUALISER.Q must update eq.Q');
assert.strictEqual(engine.sourceNode.playbackRate.value, 1.75, 'Live SAMPLE.speed must update sourceNode.playbackRate');
assert.ok(Math.abs(sampleNode.nodeRefs.gain.gain.value - 0.9) < 1e-6, 'Live SAMPLE.level must update gain');
assert.strictEqual(sampleNode.nodeRefs.panner.pan.value, -1.0, 'Live SAMPLE.balance update must pan StereoPannerNode to -1');

// Verify Handle & Shake modulation on DIST.amount and RING.mix
engine.updateModulation({ handlePos: 1.0, shakeAmount: 0.5 });
assert.strictEqual(distNode.nodeRefs.lastAmount, 40, 'Handle modulation on DIST.amount must clamp at 40x');
assert.strictEqual(ringNode.nodeRefs.wetGain.gain.value, 1.0, 'Shake modulation on RING.mix (75% + 25%) must reach 1.0');

// 8c. All remaining effects (LOWPASS, HIGHPASS, HARMONY, SSB, BALANCE, unknown fallback) & LFO/Handle/Shake modulation
const remainingPreset = {
  id: 'test-p2',
  pos: 1,
  name: 'REMAINING FX',
  comment: '',
  list: [
    { id: 'fx0', effect: 'LOWPASS', cutoff: 50, BUS: 1 },
    { id: 'fx1', effect: 'HIGHPASS', cutoff: 20, BUS: 1 },
    { id: 'fx2', effect: 'HARMONY', pitch: 1.25, 'dry-level': 50, BUS: 1 },
    { id: 'fx3', effect: 'SSB', frequency: -500, BUS: 1 },
    { id: 'fx4', effect: 'BALANCE', balance: 0.5, BUS: 1 },
    { id: 'fx5', effect: 'SAMPLE', speed: 1.0, pitch: 12, level: 80, BUS: 1 },
    { id: 'fx6', effect: 'UNKNOWN_FX', BUS: 1 }
  ],
  handle: { target: 'lfo', param: 'speed', depth: 4.0 },
  shake: { row: 3, param: 'frequency', depth: -300 },
  lfo: { row: 4, param: 'balance', depth: 50, shape: 'square', speed: 2.0, phase: 0.3 },
  trigger: { row: 5 }
};
engine.updatePreset(remainingPreset);
const lpNode = engine.activeNodes.find((n) => n.effectType === 'LOWPASS');
const hpNode = engine.activeNodes.find((n) => n.effectType === 'HIGHPASS');
const harmonyNode = engine.activeNodes.find((n) => n.effectType === 'HARMONY');
const ssbNode = engine.activeNodes.find((n) => n.effectType === 'SSB');
const balanceNode = engine.activeNodes.find((n) => n.effectType === 'BALANCE');
const sampleNode2 = engine.activeNodes.find((n) => n.effectType === 'SAMPLE');

assert.ok(Math.abs(lpNode.nodeRefs.filter.frequency.value - cutoffToHz(0.5)) < 1e-3, 'LOWPASS 50% cutoff must map to log Hz');
assert.ok(Math.abs(hpNode.nodeRefs.filter.frequency.value - cutoffToHz(0.2)) < 1e-3, 'HIGHPASS 20% cutoff must map to log Hz');
assert.strictEqual(harmonyNode.nodeRefs.pitchShifter.getPitch(), 1.25, 'HARMONY pitchShifter must initialize to 1.25x');
assert.strictEqual(ssbNode.nodeRefs.ssbShifter.getFrequency(), -650, 'SSB -500Hz + 0.5*(-300Hz) shake must equal -650Hz');
assert.strictEqual(sampleNode2.nodeRefs.pitchShifter.getPitch(), 2.0, 'SAMPLE +12 semitones must set pitchShifter to 2.0x');
// At currentTime=0.25, effectiveLfoSpeed = 2.0 + 1.0*4.0 = 6.0 -> cycles = 0.25*6.0 + 0.3 = 1.8 (phase 0.8 >= 0.5 -> square = -1)
assert.strictEqual(balanceNode.nodeRefs.chopperGain.gain.value, 0.18, 'Square LFO < 0 on BALANCE must engage 0.18 chopper gate');

// Invoke ScriptProcessor onaudioprocess callbacks on HARMONY and SSB
const dummyIn = new Float32Array(64);
const dummyOut = new Float32Array(64);
const dummyEvent = {
  inputBuffer: { getChannelData: () => dummyIn },
  outputBuffer: { getChannelData: () => dummyOut }
};
harmonyNode.nodeRefs.pitchShifter.processor.onaudioprocess(dummyEvent);
ssbNode.nodeRefs.ssbShifter.processor.onaudioprocess(dummyEvent);

// 8d. Bundled december_pack WAV samples & SAMPLE block trigger modes (oneshot, hold, startstop)
assert.strictEqual(BUNDLED_SAMPLES.length, 4, 'Must bundle 4 WAV samples from december_pack');
for (const s of BUNDLED_SAMPLES) {
  const wavPath = path.join(ROOT_DIR, 'src/assets/samples', s.file);
  assert.ok(fs.existsSync(wavPath), `Bundled sample ${s.file} must exist on disk`);
  const header = fs.readFileSync(wavPath).subarray(0, 12).toString('ascii');
  assert.ok(header.startsWith('RIFF') && header.endsWith('WAVE'), `${s.file} must be a valid RIFF/WAVE file`);
}

engine.setActiveSampleSlot(2);
assert.strictEqual(engine.getActiveSampleSlot(), 2, 'setActiveSampleSlot(2) must select slot 2');
engine.setActiveSampleSlot(99);
assert.strictEqual(engine.getActiveSampleSlot(), 3, 'setActiveSampleSlot(99) must clamp to slot 3');

// Trigger in 'hold' mode: starts on down=true, stops on down=false
await engine.triggerSample(true, 'hold');
assert.strictEqual(engine.getIsSamplePlaying(), true, 'triggerSample(true, "hold") must start sample playback');
assert.strictEqual(engine.sampleSourceNode.loop, true, 'hold mode must loop sample while held');
assert.ok(
  engine.sampleSourceNode.connections.includes(sampleNode2.nodeRefs.sampleInput),
  'Triggered sample must route into SAMPLE node sampleInput at trigger.row'
);
await engine.triggerSample(false, 'hold');
assert.strictEqual(engine.getIsSamplePlaying(), false, 'triggerSample(false, "hold") must stop sample on button release');

// Trigger in 'startstop' mode: toggles on down=true, ignores down=false
await engine.triggerSample(true, 'startstop');
assert.strictEqual(engine.getIsSamplePlaying(), true, 'startstop 1st press must start sample');
await engine.triggerSample(false, 'startstop');
assert.strictEqual(engine.getIsSamplePlaying(), true, 'startstop release must keep sample playing');
await engine.triggerSample(true, 'startstop');
assert.strictEqual(engine.getIsSamplePlaying(), false, 'startstop 2nd press must stop sample');

// Trigger in 'oneshot' mode and verify onended cleanup
await engine.triggerSample(true, 'oneshot');
assert.strictEqual(engine.getIsSamplePlaying(), true, 'oneshot press must start sample');
assert.strictEqual(engine.sampleSourceNode.loop, false, 'oneshot mode must not loop');
engine.sampleSourceNode.onended();
assert.strictEqual(engine.getIsSamplePlaying(), false, 'onended callback must clear isSamplePlaying');

// Verify togglePlay() and triggerShake() decay
assert.strictEqual(engine.togglePlay(), false, 'togglePlay() while running must stop and return false');
assert.strictEqual(engine.togglePlay(), true, 'togglePlay() while stopped must start and return true');
let rafCb = null;
globalThis.requestAnimationFrame = (cb) => {
  rafCb = cb;
  return 1;
};
engine.triggerShake(0.8);
assert.strictEqual(engine.modState.shakeAmount, 0.8);
if (rafCb) rafCb();

// 8e. AudioWorkletNode path verification when AudioWorklet is supported
class MockAudioWorkletNode extends MockAudioNode {
  constructor(ctx, name, opts) {
    super();
    this.name = name;
    this.opts = opts;
    this.messages = [];
    this.port = {
      postMessage: (msg) => this.messages.push(msg)
    };
  }
}
globalThis.AudioWorkletNode = MockAudioWorkletNode;
MockAudioContext.prototype.audioWorklet = {
  addModule: async () => {}
};
const workletEngine = new DspAudioEngine();
workletEngine.updatePreset(remainingPreset);
await workletEngine.start();
const workletHarmony = workletEngine.activeNodes.find((n) => n.effectType === 'HARMONY');
const workletSsb = workletEngine.activeNodes.find((n) => n.effectType === 'SSB');
assert.strictEqual(workletHarmony.nodeRefs.pitchShifter.processor.name, 'ep2350-pitch-shifter');
assert.strictEqual(workletSsb.nodeRefs.ssbShifter.processor.name, 'ep2350-ssb-shifter');
assert.strictEqual(workletEngine.getInputNoiseGate().name, 'ep2350-noisegate');
workletEngine.stop();
delete globalThis.AudioWorkletNode;
delete MockAudioContext.prototype.audioWorklet;

// 8f. Live Microphone Input mode (`setInputMode('mic')`) & fallback when permission denied
let trackStopped = false;
const mockMicStream = {
  getTracks: () => [
    {
      stop: () => {
        trackStopped = true;
      }
    }
  ]
};
Object.defineProperty(globalThis, 'navigator', {
  value: {
    mediaDevices: {
      getUserMedia: async () => mockMicStream
    }
  },
  configurable: true,
  writable: true
});
const micEngine = new DspAudioEngine();
micEngine.updatePreset(testPreset);
await micEngine.setInputMode('mic');
assert.strictEqual(micEngine.getInputMode(), 'mic', 'getInputMode() must return "mic"');
await micEngine.start();
assert.strictEqual(micEngine.getIsRunning(), true, 'micEngine must run in live mic mode');
assert.strictEqual(micEngine.sourceNode, null, 'mic mode must not start speech buffer sourceNode');
assert.ok(micEngine.micSourceNode, 'mic mode must create MediaStreamAudioSourceNode');
assert.ok(
  micEngine.micSourceNode.connections.includes(micEngine.getInputCompressor()),
  'micSourceNode must connect into pre-chain inputCompressor'
);
await micEngine.setInputMode('sample');
assert.strictEqual(trackStopped, true, 'Switching from mic to sample mode must stop active mic tracks');
assert.strictEqual(micEngine.getInputMode(), 'sample');
assert.ok(micEngine.sourceNode, 'Switching to sample mode while running must start speech sourceNode');
micEngine.stop();

// Verify graceful fallback to 'sample' when getUserMedia rejects
globalThis.navigator = {
  mediaDevices: {
    getUserMedia: async () => {
      throw new Error('Permission dismissed');
    }
  }
};
const fallbackEngine = new DspAudioEngine();
await fallbackEngine.setInputMode('mic');
await fallbackEngine.start();
assert.strictEqual(fallbackEngine.getInputMode(), 'sample', 'Denied mic permission must fall back to sample mode');
assert.strictEqual(fallbackEngine.getLastMicError(), 'Permission dismissed');
fallbackEngine.stop();

// 8f. Async start() / stop() race protection & remaining parser/serializer edge branches
engine.stop();
assert.strictEqual(engine.getIsRunning(), false, 'Engine must report stopped after stop()');
const engineRace = new DspAudioEngine();
const startPromise = engineRace.start();
assert.strictEqual(engineRace.getIsRunning(), true, 'getIsRunning() must be true immediately while start() is initializing');
engineRace.stop();
assert.strictEqual(engineRace.getIsRunning(), false, 'Calling stop() during async init() must immediately cancel running state');
await startPromise;
assert.strictEqual(engineRace.getIsRunning(), false, 'Cancelled start() must not resume playback after init() resolves');
assert.strictEqual(engineRace.sourceNode, null, 'Cancelled start() must not create an active sourceNode');

const emptyPack = createEmptyPack();
assert.strictEqual(emptyPack.presets.length, 4);
assert.strictEqual(emptyPack.samples[0].file, 'kara-te.wav');
assert.ok(parseConfigJson(123).error, 'Non-string input must return error');
assert.ok(parseConfigJson('x'.repeat(5_000_005)).error, 'Oversized JSON > 5MB must return error');
const emptyPresetsIssues = validatePackConfig({ name: 'X', useBuiltInSamples: true, samples: [], presets: [] });
assert.ok(emptyPresetsIssues.some((i) => i.type === 'error' && i.message.includes('At least one preset')));

console.log('✓ Suite 8: DspAudioEngine all 11 effects, bundled WAV samples, AudioWorklet & race protection verified');

console.log('\n=== ALL 8 PRODUCTION TEST SUITES PASSED (100%) ===');
