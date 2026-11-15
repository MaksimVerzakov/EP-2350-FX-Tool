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
    'src/utils/presetUrl.ts',
    'src/utils/webSerial.ts',
    'src/utils/tabGuard.ts',
    'src/utils/wavCodec.ts',
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
const {
  encodeBase64Url,
  decodeBase64Url,
  encodePresetToHash,
  encodePackToHash,
  buildPresetShareUrl,
  buildPackShareUrl,
  decodeHashPayload
} = await import(pathToFileURL(path.join(TMP_TEST_BUILD, 'src/utils/presetUrl.mjs')).href);
const { serializeToConfigJson, validatePackConfig } = await import(
  pathToFileURL(path.join(TMP_TEST_BUILD, 'src/utils/serializer.mjs')).href
);
const { Ep2350SerialClient, EP2350_USB_VID, EP2350_USB_PID } = await import(
  pathToFileURL(path.join(TMP_TEST_BUILD, 'src/utils/webSerial.mjs')).href
);
const { createMultiTabGuard } = await import(
  pathToFileURL(path.join(TMP_TEST_BUILD, 'src/utils/tabGuard.mjs')).href
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
const { decodeWavBuffer, encodeWavBuffer, generateSyntheticVocalPcm } = await import(
  pathToFileURL(path.join(TMP_TEST_BUILD, 'src/utils/wavCodec.mjs')).href
);
const { handleMcpJsonRpcRequest } = await import(
  pathToFileURL(path.join(ROOT_DIR, 'mcp/server.mjs')).href
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

// Verify 16 non-SAMPLE effects triggers 17-effect limit error because SAMPLE is required
const sixteenWithoutSamplePack = {
  name: 'SIXTEEN WITHOUT SAMPLE',
  useBuiltInSamples: true,
  samples: [],
  presets: [
    {
      id: 'p-16-no-s',
      pos: 0,
      name: 'NO SAMPLE 16',
      comment: '',
      list: Array.from({ length: 16 }, (_, idx) => ({ id: `fx-${idx}`, effect: 'LOWPASS', cutoff: 50 }))
    }
  ]
};
const sixteenNoSampleIssues = validatePackConfig(sixteenWithoutSamplePack);
assert.ok(
  sixteenNoSampleIssues.some((i) => i.type === 'error' && i.message.includes('17 total including required SAMPLE')),
  '16 non-SAMPLE effects must fail validation because adding required SAMPLE makes 17 effects'
);

// Verify serializer auto-appends SAMPLE when missing (within 16-effect limit)
const missingSamplePack = {
  name: 'AUTO SAMPLE PACK',
  useBuiltInSamples: true,
  samples: [],
  presets: [
    {
      id: 'p-auto-s',
      pos: 0,
      name: 'AUTO SAMPLE',
      comment: '',
      list: [{ id: 'fx-0', effect: 'DIST', amount: 10, mix: 50 }]
    }
  ]
};
const serializedAutoSample = JSON.parse(serializeToConfigJson(missingSamplePack));
assert.strictEqual(serializedAutoSample.presets[0].list.length, 2);
assert.strictEqual(serializedAutoSample.presets[0].list[1].effect, 'SAMPLE');
assert.deepStrictEqual(serializedAutoSample.presets[0].trigger, { row: 1 });

console.log('✓ Suite 3: Validator constraints, 16-row hardware limit (incl. SAMPLE) & auto-append verified');

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
assert.ok(Math.max(...clipCurve) <= Math.tanh(1.0) + 1e-6);
const smallSignalX = (264 * 2) / 512 - 1;
assert.ok(
  clipCurve[264] <= smallSignalX + 1e-6,
  'makeSoftClipCurve must have <= 1.0 small-signal gain so DELAY feedback does not amplify below ceiling'
);

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
assert.ok(
  presetLedgerSrc.includes('isHiddenTrailingSample') &&
    presetLedgerSrc.includes('visibleBusItems') &&
    presetLedgerSrc.includes('effectiveEffectCount'),
  'PresetLedger must skip unchanged trailing SAMPLE and reserve 1 slot toward the 16-effect limit when SAMPLE is missing'
);

// 7. Side hardware buttons are 3D cylindrical buttons mounted on the right side wall
assert.ok(
  micDeviceSrc.includes('const SideButton: React.FC<SideButtonProps>') &&
    micDeviceSrc.includes('<ellipse') &&
    micDeviceSrc.includes('-translate-x-[2.5px]'),
  'MicDevice must render 3D side-mounted cylindrical buttons with elliptical end caps and inward press motion'
);

// 8. Preset & Sample LEDs light cumulatively as a bar (slot <= activeSlot / activeSampleSlot), orange on top & white on bottom
assert.ok(
  micDeviceSrc.includes('const isActive = slot <= activeSlot;') &&
    micDeviceSrc.includes('const isActive = slot <= activeSampleSlot;') &&
    !micDeviceSrc.includes('const isActive = activeSlot === slot;') &&
    !micDeviceSrc.includes('const isActive = activeSampleSlot === slot;') &&
    micDeviceSrc.includes("fill={isActive ? '#ff3b30' : '#2b3034'}") &&
    micDeviceSrc.includes("fill={isActive ? '#ffffff' : '#2b3034'}"),
  'MicDevice must light preset (orange) and sample (white) LEDs cumulatively (bar-style) rather than single-dot'
);

console.log('✓ Suite 7: UX horizontal Push/Shake arrows, 3D side buttons, cumulative LEDs, Mic FX block shake, trailing SAMPLE hiding & balanced TopBanner verified');

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
assert.strictEqual(
  engine.sourceNode.playbackRate.value,
  1.0,
  'Live SAMPLE.speed must NOT change vocal audition sourceNode.playbackRate'
);
assert.strictEqual(
  sampleNode.nodeRefs.lastSpeed,
  1.75,
  'Live SAMPLE.speed must update sampleNode.nodeRefs.lastSpeed'
);
assert.ok(Math.abs(sampleNode.nodeRefs.gain.gain.value - 0.9) < 1e-6, 'Live SAMPLE.level must update gain');
assert.strictEqual(sampleNode.nodeRefs.panner.pan.value, -1.0, 'Live SAMPLE.balance update must pan StereoPannerNode to -1');

// Verify triggered sample receives SAMPLE.speed live updates while audition speech stays at 1.0x
await engine.triggerSample(true, 'oneshot');
assert.ok(engine.sampleSourceNode, 'triggerSample must create sampleSourceNode');
assert.strictEqual(
  engine.sampleSourceNode.playbackRate.value,
  1.75,
  'Triggered sample playbackRate must reflect SAMPLE.speed'
);
engine.updatePreset({
  ...updatedPreset,
  list: [
    ...updatedPreset.list.slice(0, 5),
    { ...updatedPreset.list[5], speed: 0.65 }
  ]
});
assert.strictEqual(
  engine.sampleSourceNode.playbackRate.value,
  0.65,
  'Live SAMPLE.speed change must update active sampleSourceNode.playbackRate'
);
assert.strictEqual(
  engine.sourceNode.playbackRate.value,
  1.0,
  'Audition voice sourceNode.playbackRate must stay 1.0x when SAMPLE.speed changes live'
);
assert.ok(
  Math.abs(reverbNode.nodeRefs.combSum.gain.value - (0.28 + 0.01 * 0.55) * 0.5) < 1e-6,
  'REVERB combSum.gain must apply 0.5 attenuation matching offlineRenderer to prevent comb buildup'
);

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

// ============================================================================
// SUITE 9: Web Serial Live Hardware Mode (Ep2350SerialClient & UI Integration)
// ============================================================================
assert.strictEqual(EP2350_USB_VID, 0x2367, 'EP-2350 USB Vendor ID must be 0x2367');
assert.strictEqual(EP2350_USB_PID, 0x0620, 'EP-2350 USB Product ID must be 0x0620');

const sentCommands = [];
let openedOptions = null;
let requestedFilters = null;
let readController = null;
let mockHwFxPos = -1;
let mockHwSamPos = 0;
const mockDeviceConfigJson = JSON.stringify({
  name: 'TING HARDWARE PACK',
  presets: [
    {
      pos: 0,
      name: 'HW DELAY',
      list: [{ EFFECT: 'DELAY', time: 0.25, echo: 0.5, 'dry-level': 0.8 }]
    },
    { pos: 1, name: 'HW REVERB', list: [{ EFFECT: 'REVERB', time: 0.4, 'wet-level': 0.5 }] },
    { pos: 2, name: 'HW DIST', list: [{ EFFECT: 'DIST', amount: 0.3, mix: 0.5 }] },
    { pos: 3, name: 'HW RING', list: [{ EFFECT: 'RING', frequency: 220, mix: 0.8 }] }
  ]
});

function createMockSerialPort() {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const readable = new ReadableStream({
    start(controller) {
      readController = controller;
    }
  });
  const writable = new WritableStream({
    write(chunk) {
      const text = decoder.decode(chunk);
      sentCommands.push(text);
      if (text.includes('/fat/config.json') && text.includes('read()')) {
        // Simulate real EP-2350 hardware: leading prompt, echoed command, and multi-chunk JSON output
        readController.enqueue(encoder.encode(`\r\n>>> ${text}`));
        const fullOut = `__CFG_START__${mockDeviceConfigJson}__CFG_END__\r\n>>> `;
        const mid = Math.floor(fullOut.length / 2);
        readController.enqueue(encoder.encode(fullOut.slice(0, mid)));
        readController.enqueue(encoder.encode(fullOut.slice(mid)));
      } else if (text.includes('"__EP_" + "SLOT__:"')) {
        readController.enqueue(
          encoder.encode(`\r\n>>> ${text}__EP_SLOT__:${mockHwFxPos}:${mockHwSamPos}\r\n>>> `)
        );
      } else {
        readController.enqueue(encoder.encode(`\r\n${text}>>> `));
      }
    }
  });

  return {
    readable,
    writable,
    getInfo: () => ({ usbVendorId: EP2350_USB_VID, usbProductId: EP2350_USB_PID }),
    open: async (opts) => {
      openedOptions = opts;
    },
    close: async () => {}
  };
}

globalThis.navigator = {
  serial: {
    requestPort: async (opts) => {
      requestedFilters = opts?.filters;
      return createMockSerialPort();
    },
    getPorts: async () => [createMockSerialPort()]
  }
};

assert.strictEqual(Ep2350SerialClient.isSupported(), true, 'isSupported() must detect navigator.serial');
const serialClient = new Ep2350SerialClient(25, 0);
let disconnectedCount = 0;
serialClient.onDisconnect(() => {
  disconnectedCount++;
});

const observedPresetSlots = [];
const observedSampleSlots = [];
serialClient.onPresetSlotChange((slot) => observedPresetSlots.push(slot));
serialClient.onSampleSlotChange((slot) => observedSampleSlots.push(slot));

await serialClient.connect();
assert.strictEqual(serialClient.isConnected, true, 'serialClient must report connected after connect()');
assert.strictEqual(openedOptions.baudRate, 115200, 'Serial port must open at 115200 baud');
assert.strictEqual(requestedFilters[0].usbVendorId, 0x2367, 'requestPort filter must match VID 0x2367');
assert.strictEqual(requestedFilters[0].usbProductId, 0x0620, 'requestPort filter must match PID 0x0620');
assert.ok(sentCommands[0].includes('\x03'), 'Connect must send Ctrl+C interrupt to reach REPL');

// Read /fat/config.json and verify parsed device pack name
const rawDeviceJson = await serialClient.readConfigJson();
assert.ok(
  sentCommands.some((c) => c.includes('"__CFG_" + "START__"') && !c.includes('__CFG_START__')),
  'readConfigJson command must split marker literals so REPL echo never collides with markers'
);
const parsedDevice = parseConfigJson(rawDeviceJson);
assert.ok(parsedDevice.pack, 'Device config.json must parse into a valid PackConfig');
assert.strictEqual(parsedDevice.pack.name, 'TING HARDWARE PACK', 'Parsed pack must preserve the device pack name');

// Hardware button polling: initial state (-1, 0), then physical button press to preset 1 & sample 3, then FX OFF (-1)
await serialClient.pollHardwareSlot();
assert.deepStrictEqual(observedPresetSlots, [-1], 'fx_pos=-1 on boot must emit -1 (FX OFF / bypass state)');
assert.deepStrictEqual(observedSampleSlots, [0], 'Initial poll syncs sam_pos=0');

mockHwFxPos = 1;
mockHwSamPos = 3;
const polledAfterPress = await serialClient.pollHardwareSlot();
assert.deepStrictEqual(polledAfterPress, { fxSlot: 1, samSlot: 3 }, 'pollHardwareSlot must parse fx_pos and sam_pos');
assert.deepStrictEqual(observedPresetSlots, [-1, 1], 'Physical preset button press on mic must notify onPresetSlotChange(1)');
assert.deepStrictEqual(observedSampleSlots, [0, 3], 'Physical sample button press on mic must notify onSampleSlotChange(3)');

mockHwFxPos = -1;
await serialClient.pollHardwareSlot();
assert.deepStrictEqual(observedPresetSlots, [-1, 1, -1], 'Switching off FX on mic (fx_pos=-1) must notify onPresetSlotChange(-1)');

// Preset switching via fx.load_preset(slot) (including -1 FX OFF) and LED sync
await serialClient.loadPreset(2);
assert.ok(
  sentCommands.some((c) => c.includes('fx.load_preset(2)') && c.includes('ui.leds(2,')),
  'loadPreset(2) must send fx.load_preset(2) and update hardware LEDs over REPL'
);
await serialClient.loadPreset(-1);
assert.ok(
  sentCommands.some((c) => c.includes('fx.load_preset(-1)') && c.includes('ui.leds(-1,')),
  'loadPreset(-1) must send fx.load_preset(-1) and turn off all 4 FX LEDs over REPL'
);
await assert.rejects(() => serialClient.loadPreset(-2), /Invalid preset slot/, 'Out-of-range slot -2 must reject');
await assert.rejects(() => serialClient.loadPreset(4), /Invalid preset slot/, 'Out-of-range slot 4 must reject');

// Sample slot switching from web UI updates hardware sam_pos and LEDs
await serialClient.selectSampleSlot(1);
assert.ok(
  sentCommands.some((c) => c.includes('sam_pos = 1') && c.includes(', 1)')),
  'selectSampleSlot(1) must update sam_pos and hardware LEDs over REPL'
);
await assert.rejects(() => serialClient.selectSampleSlot(-1), /Invalid sample slot/, 'Out-of-range sample slot -1 must reject');

// Live parameter updates: percent scaling, BUS guard, and throttling
const beforeParamCount = sentCommands.length;
serialClient.setParam(0, 0, 'BUS', 2, 'DELAY');
assert.strictEqual(sentCommands.length, beforeParamCount, 'setParam must never send BUS over REPL');

serialClient.setParam(0, 0, 'dry-level', 75, 'DELAY');
await new Promise((r) => setTimeout(r, 40));
assert.ok(
  sentCommands.some((c) => c.includes('fx.param(0, 0, "dry-level", 0.75)')),
  'Percent param dry-level=75 on DELAY must be scaled to 0.75'
);

// Rapid updates within throttle window coalesce to trailing value
serialClient.setParam(0, 0, 'time', 0.1, 'DELAY');
serialClient.setParam(0, 0, 'time', 0.2, 'DELAY');
serialClient.setParam(0, 0, 'time', 0.42, 'DELAY');
await new Promise((r) => setTimeout(r, 50));
assert.ok(
  sentCommands.some((c) => c.includes('fx.param(0, 0, "time", 0.42)')),
  'Trailing throttled setParam value 0.42 must be sent'
);
assert.ok(
  !sentCommands.some((c) => c.includes('fx.param(0, 0, "time", 0.2)')),
  'Intermediate throttled value 0.2 must be coalesced'
);

// Chunked save to /fat/config.json with os.sync() and WITHOUT teenage.examine_drive(False)
await serialClient.saveConfigJson('{"name":"SAVED"}\n', 1);
assert.ok(
  sentCommands.some((c) => c.includes('_f = open("/fat/config.json", "w")')),
  'saveConfigJson must open /fat/config.json for writing'
);
assert.ok(
  sentCommands.some((c) => c.includes('import os; os.sync()')),
  'saveConfigJson must call os.sync()'
);
assert.ok(
  !sentCommands.some((c) => c.includes('examine_drive')),
  'saveConfigJson must NOT call teenage.examine_drive(False) which causes OS unsafe-eject errors'
);
assert.ok(
  sentCommands.some((c) => c.includes('fx.load_preset(1)')),
  'saveConfigJson must reload active preset slot after saving'
);

await serialClient.disconnect();
assert.strictEqual(serialClient.isConnected, false, 'serialClient must report disconnected after disconnect()');
assert.strictEqual(disconnectedCount, 1, 'onDisconnect listener must fire on disconnect');

// Auto-connect via navigator.serial.getPorts()
const autoConnected = await serialClient.tryAutoConnect();
assert.strictEqual(autoConnected, true, 'tryAutoConnect() must connect to authorized EP-2350 port via getPorts()');
await serialClient.disconnect();

// Verify TopBanner.tsx and App.tsx include connected-device pack icon & state
const topBannerUpdatedSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/components/TopBanner.tsx'), 'utf8');
const appUpdatedSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/App.tsx'), 'utf8');
assert.ok(
  topBannerUpdatedSrc.includes('data-testid="connected-device-icon"') && topBannerUpdatedSrc.includes('isDevicePack'),
  'TopBanner.tsx must render connected-device-icon when isDevicePack is active'
);
assert.ok(
  appUpdatedSrc.includes('ep2350Serial') && appUpdatedSrc.includes('syncFromConnectedDevice'),
  'App.tsx must integrate ep2350Serial and switch to the device pack on connect'
);

const deviceConnectorSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/components/DeviceConnector.tsx'), 'utf8');
assert.ok(
  deviceConnectorSrc.includes("'Connect the mic'") &&
    deviceConnectorSrc.includes('aria-label="Save to the mic"') &&
    deviceConnectorSrc.includes('aria-label="Eject the mic"') &&
    deviceConnectorSrc.includes('FloppyIcon') &&
    deviceConnectorSrc.includes('EjectIcon'),
  'DeviceConnector must render a "connect the mic" card that splits into SAVE (floppy) and EJECT'
);
assert.ok(
  !topBannerUpdatedSrc.includes('CONNECT DEVICE') &&
    !topBannerUpdatedSrc.includes('onSaveToDevice') &&
    !topBannerUpdatedSrc.includes('onDisconnectDevice') &&
    topBannerUpdatedSrc.includes('deviceConnector') &&
    topBannerUpdatedSrc.includes('onSelectDevicePack'),
  'Pack list must keep the mic pack entry but no connect/save/disconnect actions'
);
assert.ok(
  appUpdatedSrc.includes('<DeviceConnector') && appUpdatedSrc.includes('savedDeviceJson'),
  'App.tsx must render DeviceConnector and track unsaved changes against the mic'
);
console.log('✓ Suite 9: Web Serial Live Hardware Mode (Ep2350SerialClient & UI Integration) verified');

// ============================================================================
// SUITE 10: Pure-TS WAV Codec & Bundled WAV Decoding (src/utils/wavCodec.ts)
// ============================================================================
const synthVocal = generateSyntheticVocalPcm(48000, 1.2, 0.6);
assert.strictEqual(synthVocal.sampleRate, 48000);
assert.strictEqual(synthVocal.left.length, Math.round(48000 * 1.8));
assert.strictEqual(synthVocal.right.length, Math.round(48000 * 1.8));

const encodedWav = encodeWavBuffer(synthVocal);
assert.ok(encodedWav.byteLength > 44, 'Encoded WAV must contain RIFF header + PCM payload');

const decodedWav = decodeWavBuffer(encodedWav, 48000);
assert.strictEqual(decodedWav.sampleRate, 48000);
assert.strictEqual(decodedWav.left.length, synthVocal.left.length);
for (let i = 0; i < 500; i += 17) {
  assert.ok(
    Math.abs(decodedWav.left[i] - synthVocal.left[i]) < 1e-3,
    '16-bit WAV round-trip must preserve sample amplitude within 16-bit quantization'
  );
}

// Verify bundled hardware sample WAV files in src/assets/samples/*.wav decode cleanly
const alertWavBytes = fs.readFileSync(path.join(ROOT_DIR, 'src/assets/samples/alert.wav'));
const decodedAlert = decodeWavBuffer(alertWavBytes, 48000);
assert.strictEqual(decodedAlert.sampleRate, 48000);
assert.ok(decodedAlert.left.length > 1000, 'Bundled alert.wav must decode to non-empty 48kHz PCM');
console.log('✓ Suite 10: Pure-TS WAV Codec round-trip & bundled hardware sample decoding verified');

// ============================================================================
// SUITE 11: MCP Server JSON-RPC 2.0 Tools, Resources & Prompts (mcp/server.mjs)
// ============================================================================
// 11a. initialize
const initRes = await handleMcpJsonRpcRequest({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2024-11-05' }
});
assert.strictEqual(initRes.result.serverInfo.name, 'ep2350-fx-mcp-server');

// 11b. resources/list & resources/read
const resList = await handleMcpJsonRpcRequest({
  jsonrpc: '2.0',
  id: 2,
  method: 'resources/list'
});
assert.strictEqual(resList.result.resources.length, 2);

const schemaRead = await handleMcpJsonRpcRequest({
  jsonrpc: '2.0',
  id: 3,
  method: 'resources/read',
  params: { uri: 'ep2350://schema/effects-registry' }
});
const schemaJson = JSON.parse(schemaRead.result.contents[0].text);
assert.strictEqual(schemaJson.maxEffectsPerPreset, 16);
assert.strictEqual(schemaJson.effects.length, 11);

// 11c. tools/list
const toolsList = await handleMcpJsonRpcRequest({
  jsonrpc: '2.0',
  id: 4,
  method: 'tools/list'
});
assert.deepStrictEqual(
  toolsList.result.tools.map((t) => t.name),
  ['get_effects_reference', 'validate_preset', 'export_pack_config', 'push_to_live_ui'],
  'MCP server exposes exactly the four preset tools: reference, validate, export, review'
);
assert.ok(
  !toolsList.result.tools.some((t) => t.name === 'design_preset_from_description'),
  'The keyword designer was removed: models write presets themselves'
);
assert.ok(toolsList.result.tools.some((t) => t.name === 'get_effects_reference'));

// 11d. A hand-written preset (what a model writes after get_effects_reference) validates
const cyberWalkiePreset = {
  name: 'CYBER WALKIE',
  pos: 0,
  list: [
    { effect: 'HIGHPASS', cutoff: 0.45 },
    { effect: 'DIST', amount: 11, mix: 75, 'lowpass-cutoff': 78, 'highpass-cutoff': 22 },
    { effect: 'DELAY', time: 0.35, echo: 50, 'wet-level': 45, 'dry-level': 90 },
    { effect: 'SSB', frequency: 0 },
    { effect: 'SAMPLE' }
  ],
  handle: { row: 2, param: 'wet-level', depth: 45 },
  shake: { row: 3, param: 'frequency', depth: 900 }
};
const validateCall = await handleMcpJsonRpcRequest({
  jsonrpc: '2.0',
  id: 5,
  method: 'tools/call',
  params: { name: 'validate_preset', arguments: { preset: cyberWalkiePreset } }
});
assert.strictEqual(validateCall.result.isError, false);
const validatePayload = validateCall.result.structuredContent;
assert.strictEqual(validatePayload.isValid, true, 'Hand-written preset must have 0 hardware validation errors');
assert.deepStrictEqual(validatePayload.warnings, [], 'Hand-written preset must lint clean');
const designPayload = { preset: cyberWalkiePreset, ...validatePayload };
assert.ok(designPayload.shareUrl.includes('#preset='), 'validate_preset returns a shareUrl to review the preset');

console.log('✓ Suite 11: MCP Server JSON-RPC 2.0 resources, prompts & tools verified');

// ============================================================================
// SUITE 12: Live Web UI Sync Bridge & Agent Skill Verification (M4)
// ============================================================================
const viteConfigSrc = fs.readFileSync(path.join(ROOT_DIR, 'vite.config.ts'), 'utf8');
const appMcpSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/App.tsx'), 'utf8');
const skillMdSrc = fs.readFileSync(
  path.join(ROOT_DIR, '.agent/skills/ep2350-sound-designer/SKILL.md'),
  'utf8'
);

assert.ok(
  viteConfigSrc.includes('ep2350McpLiveSyncPlugin') && viteConfigSrc.includes('/__mcp_sync'),
  'vite.config.ts must register ep2350McpLiveSyncPlugin at /__mcp_sync'
);
assert.ok(
  appMcpSrc.includes("EventSource('/__mcp_sync')"),
  'App.tsx must subscribe to /__mcp_sync via EventSource for live MCP preset pushes'
);
assert.ok(
  skillMdSrc.includes('name: ep2350-sound-designer') &&
    skillMdSrc.includes('get_effects_reference'),
  'Antigravity SKILL.md must document the ep2350-sound-designer workflow and MCP tools'
);
console.log('✓ Suite 12: Live Web UI Sync Bridge & Antigravity Skill verified');

// ============================================================================
// SUITE 13: Stateless #preset=... & #pack=... Deep-Link Codec & MCP shareUrl
// ============================================================================
// 13a. Base64URL Unicode & ASCII round-trip
const unicodeSample = 'DAFT VOCODER · EP–2350 {"mix":0.75}';
assert.strictEqual(
  decodeBase64Url(encodeBase64Url(unicodeSample)),
  unicodeSample,
  'encodeBase64Url / decodeBase64Url must round-trip UTF-8 strings losslessly'
);

// 13b. Single preset round-trip (both UI-scale 0..100 and hardware-scale 0.0..1.0)
const sharePresetUrl = buildPresetShareUrl(
  'https://ep2350.example.com/',
  designPayload.preset,
  2
);
assert.ok(
  sharePresetUrl.startsWith('https://ep2350.example.com/#preset=') &&
    sharePresetUrl.endsWith('&slot=2'),
  'buildPresetShareUrl must produce a clean #preset=<b64url>&slot=2 URL'
);
const decodedPresetPayload = decodeHashPayload(sharePresetUrl);
assert.ok(decodedPresetPayload && decodedPresetPayload.type === 'preset');
assert.strictEqual(decodedPresetPayload.slot, 2);
assert.strictEqual(decodedPresetPayload.preset.name, 'CYBER WALKIE');
assert.strictEqual(
  decodedPresetPayload.preset.list.length,
  designPayload.preset.list.length,
  'Decoded preset from URL hash must preserve all effects in chain'
);

// 13c. Full pack round-trip (#pack=<b64url>&slot=1)
const dubPackParsed = parseConfigJson(OFFICIAL_TE_PACKS[1].rawJson).pack;
const sharePackUrl = buildPackShareUrl('https://ep2350.example.com', dubPackParsed, 1);
assert.ok(sharePackUrl.includes('#pack=') && sharePackUrl.endsWith('&slot=1'));
const decodedPackPayload = decodeHashPayload(sharePackUrl);
assert.ok(decodedPackPayload && decodedPackPayload.type === 'pack');
assert.strictEqual(decodedPackPayload.slot, 1);
assert.strictEqual(decodedPackPayload.pack.name, dubPackParsed.name);
assert.strictEqual(decodedPackPayload.pack.presets.length, 4);

// 13d. Malformed hash resilience
assert.strictEqual(decodeHashPayload(''), null);
assert.strictEqual(decodeHashPayload('#preset=!!!not_base64!!!'), null);
assert.strictEqual(decodeHashPayload('#unknown=123'), null);

// 13e. MCP tools return shareUrl and shareHash
assert.ok(
  typeof designPayload.shareUrl === 'string' && designPayload.shareUrl.includes('#preset='),
  'validate_preset must return shareUrl with #preset= deep-link'
);
const decodedFromMcpShareUrl = decodeHashPayload(designPayload.shareUrl);
assert.strictEqual(decodedFromMcpShareUrl.preset.name, 'CYBER WALKIE');

// 13f. App.tsx integrates decodeHashPayload and hashchange listener
assert.ok(
  appMcpSrc.includes('decodeHashPayload') && appMcpSrc.includes("addEventListener('hashchange'"),
  'App.tsx must decode #preset= / #pack= hashes on mount and hashchange'
);
console.log('✓ Suite 13: Stateless #preset=... & #pack=... Deep-Link Codec & MCP shareUrl verified');

// ============================================================================
// SUITE 14: Cloudflare Worker + Static Assets Streamable HTTP /mcp Endpoint
// ============================================================================
const wranglerConfig = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'wrangler.jsonc'), 'utf8'));
assert.strictEqual(
  wranglerConfig.name,
  'ep-2350-fx-tool',
  'wrangler.jsonc name must match Cloudflare Worker service ep-2350-fx-tool'
);
assert.ok(
  wranglerConfig.previews && typeof wranglerConfig.previews === 'object',
  'wrangler.jsonc must include previews: {} block for npx wrangler preview'
);

const { buildCloudflareWorker } = await import(
  pathToFileURL(path.join(ROOT_DIR, 'scripts/build-cloudflare-worker.mjs')).href
);
const cfOutDir = path.join(TMP_TEST_BUILD, 'cf-dist');
const { workerPath, routesPath } = await buildCloudflareWorker(cfOutDir);

assert.ok(fs.existsSync(workerPath), 'buildCloudflareWorker must output _worker.js');
assert.ok(fs.existsSync(routesPath), 'buildCloudflareWorker must output _routes.json');
const routesJson = JSON.parse(fs.readFileSync(routesPath, 'utf8'));
assert.deepStrictEqual(
  routesJson.include,
  ['/mcp', '/mcp/*'],
  '_routes.json must route only /mcp to the Worker so static assets remain unlimited'
);

const cfWorkerMod = await import(pathToFileURL(workerPath).href);
const cfWorker = cfWorkerMod.default;

// 14a. OPTIONS /mcp preflight CORS
const optRes = await cfWorker.fetch(
  new Request('https://ep2350-fx.pages.dev/mcp', { method: 'OPTIONS' })
);
assert.strictEqual(optRes.status, 204);
assert.strictEqual(optRes.headers.get('Access-Control-Allow-Origin'), '*');

// 14b. GET /mcp status summary
const getRes = await cfWorker.fetch(
  new Request('https://ep2350-fx.pages.dev/mcp', { method: 'GET' })
);
assert.strictEqual(getRes.status, 200);
const getStatus = await getRes.json();
assert.strictEqual(getStatus.name, 'ep2350-fx-mcp-server');
assert.strictEqual(getStatus.endpoint, 'https://ep2350-fx.pages.dev/mcp');

// 14c. POST /mcp -> tools/call (validate_preset) with same-origin shareUrl
const daftVocoderPreset = {
  name: 'DAFT VOCODER',
  pos: 1,
  list: [
    { effect: 'HARMONY', pitch: 1.0, 'dry-level': 40 },
    { effect: 'RING', frequency: 180, mix: 45 },
    { effect: 'LOWPASS', cutoff: 0.7 },
    { effect: 'SAMPLE' }
  ]
};
const postDesignRes = await cfWorker.fetch(
  new Request('https://ep2350-fx.pages.dev/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 101,
      method: 'tools/call',
      params: { name: 'validate_preset', arguments: { preset: daftVocoderPreset } }
    })
  })
);
assert.strictEqual(postDesignRes.status, 200);
const postDesignRpc = await postDesignRes.json();
const cfDesignOut = { preset: daftVocoderPreset, ...JSON.parse(postDesignRpc.result.content[0].text) };
assert.ok(
  cfDesignOut.shareUrl.startsWith('https://ep2350-fx.pages.dev/#preset=') &&
    cfDesignOut.shareUrl.endsWith('&slot=1'),
  'Cloudflare /mcp must generate shareUrl pointing to the exact same origin as the hosted website'
);
const cfDecoded = decodeHashPayload(cfDesignOut.shareUrl);
assert.strictEqual(cfDecoded.preset.name, 'DAFT VOCODER');
assert.strictEqual(cfDecoded.slot, 1);

// 14d. POST /mcp -> push_to_live_ui on remote Cloudflare edge returns shareUrl deliveryMode
const postPushRes = await cfWorker.fetch(
  new Request('https://ep2350-fx.pages.dev/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 102,
      method: 'tools/call',
      params: {
        name: 'push_to_live_ui',
        arguments: {
          preset: cfDesignOut.preset,
          slot: 1
        }
      }
    })
  })
);
const postPushRpc = await postPushRes.json();
const cfPushOut = JSON.parse(postPushRpc.result.content[0].text);
assert.strictEqual(cfPushOut.pushed, true);
assert.strictEqual(cfPushOut.deliveryMode, 'shareUrl');
assert.strictEqual(cfPushOut.shareUrl, cfDesignOut.shareUrl);

// 14e. Static asset fallback via env.ASSETS.fetch
const assetRes = await cfWorker.fetch(new Request('https://ep2350-fx.pages.dev/index.html'), {
  ASSETS: {
    fetch: async () => new Response('<html>EP-2350</html>', { status: 200 })
  }
});
assert.strictEqual(assetRes.status, 200);
assert.strictEqual(await assetRes.text(), '<html>EP-2350</html>');

console.log('✓ Suite 14: Cloudflare Worker + Static Assets Streamable HTTP /mcp Endpoint verified');

// ============================================================================
// SUITE 15: MCP HTTP Transport Security (file access, Origin, Content-Type, SSRF)
// ============================================================================
const { handleMcpHttpFetch: handleLocalMcpHttpFetch } = await import(
  pathToFileURL(path.join(ROOT_DIR, 'mcp/server.mjs')).href
);
const secOutRel = '.tmp-test-build/security/pwned.json';
const secOutAbs = path.join(ROOT_DIR, secOutRel);
const exportCall = (outputPath) =>
  JSON.stringify({
    jsonrpc: '2.0',
    id: 201,
    method: 'tools/call',
    params: {
      name: 'export_pack_config',
      arguments: { packName: 'PWNED', presets: [], outputPath }
    }
  });

// 15a. Cross-site "simple" POST (text/plain, no preflight) is rejected before any tool runs
const plainRes = await handleLocalMcpHttpFetch(
  new Request('http://localhost:3000/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: exportCall(secOutAbs)
  })
);
assert.strictEqual(plainRes.status, 415, 'POST /mcp without application/json must return 415');
assert.ok(!fs.existsSync(secOutAbs), 'Rejected text/plain POST must not write any file');

// 15b. Local file paths are never honoured over HTTP, even with a valid JSON request
const httpWriteRes = await handleLocalMcpHttpFetch(
  new Request('http://localhost:3000/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: exportCall(secOutAbs)
  })
);
const httpWriteRpc = await httpWriteRes.json();
assert.strictEqual(httpWriteRpc.result.isError, true, 'HTTP outputPath must be reported as an error');
assert.ok(
  JSON.parse(httpWriteRpc.result.content[0].text).error.includes('not available on this transport'),
  'HTTP path arguments must explain that file access is unavailable'
);
assert.ok(!fs.existsSync(secOutAbs), 'HTTP /mcp must never write to the local filesystem');

// 15c. stdio transport keeps local file access
const stdioWrite = await handleMcpJsonRpcRequest(JSON.parse(exportCall(secOutRel)));
assert.strictEqual(stdioWrite.result.isError, false);
assert.ok(fs.existsSync(secOutAbs), 'stdio export_pack_config must still write outputPath');

// 15d. Foreign browser Origins are rejected; loopback Origins are allowed and echoed
const evilRes = await handleLocalMcpHttpFetch(
  new Request('http://localhost:3000/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 202, method: 'ping' })
  })
);
assert.strictEqual(evilRes.status, 403, 'Foreign Origin must be rejected with 403');
assert.strictEqual(evilRes.headers.get('Access-Control-Allow-Origin'), null);
const evilPreflight = await handleLocalMcpHttpFetch(
  new Request('http://localhost:3000/mcp', {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example' }
  })
);
assert.strictEqual(evilPreflight.status, 403, 'Foreign Origin preflight must be rejected');
const loopbackRes = await handleLocalMcpHttpFetch(
  new Request('http://localhost:3000/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:6274' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 203, method: 'ping' })
  })
);
assert.strictEqual(loopbackRes.status, 200);
assert.strictEqual(
  loopbackRes.headers.get('Access-Control-Allow-Origin'),
  'http://localhost:6274',
  'Loopback Origin must be echoed instead of a wildcard'
);

// 15e. Oversized request bodies are rejected
const bigRes = await handleLocalMcpHttpFetch(
  new Request('http://localhost:3000/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 204, method: 'ping', params: { pad: 'x'.repeat(2048) } })
  }),
  { maxRequestBytes: 1024 }
);
assert.strictEqual(bigRes.status, 413, 'Body above maxRequestBytes must return 413');

// 15f. push_to_live_ui never fetches a caller-supplied non-loopback uiUrl (no SSRF)
const realFetch = globalThis.fetch;
let outboundFetches = 0;
globalThis.fetch = async (...fetchArgs) => {
  outboundFetches++;
  return realFetch(...fetchArgs);
};
try {
  const ssrfCall = (id) =>
    JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: {
        name: 'push_to_live_ui',
        arguments: { preset: cfDesignOut.preset, uiUrl: 'http://169.254.169.254/latest' }
      }
    });
  const edgeSsrf = await cfWorker.fetch(
    new Request('https://ep2350-fx.pages.dev/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: ssrfCall(205)
    })
  );
  const edgeSsrfOut = JSON.parse((await edgeSsrf.json()).result.content[0].text);
  assert.strictEqual(edgeSsrfOut.deliveryMode, 'shareUrl', 'Edge must always use shareUrl delivery');

  const localSsrf = await handleMcpJsonRpcRequest(JSON.parse(ssrfCall(206)));
  const localSsrfOut = JSON.parse(localSsrf.result.content[0].text);
  assert.strictEqual(localSsrfOut.pushed, false, 'Non-loopback uiUrl live push must be refused');
  assert.strictEqual(outboundFetches, 0, 'No outbound request may be made to a non-loopback uiUrl');
} finally {
  globalThis.fetch = realFetch;
}

// 15g. Worker stays publicly callable from browser-based MCP clients
const cfCrossOrigin = await cfWorker.fetch(
  new Request('https://ep2350-fx.pages.dev/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://some-mcp-client.example' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 207, method: 'ping' })
  })
);
assert.strictEqual(cfCrossOrigin.status, 200);
assert.strictEqual(cfCrossOrigin.headers.get('Access-Control-Allow-Origin'), '*');
console.log('✓ Suite 15: MCP HTTP transport security (file access, Origin, Content-Type, SSRF) verified');

// ============================================================================
// SUITE 16: MCP Protocol Compliance (version negotiation, errors, HTTP + stdio transport)
// ============================================================================
const { resolveAppVersion } = await import(
  pathToFileURL(path.join(ROOT_DIR, 'scripts/app-version.mjs')).href
);
const rpc = (method, params, id = 300) => handleMcpJsonRpcRequest({ jsonrpc: '2.0', id, method, params });

// 16a. Version negotiation + serverInfo
const initKnown = await rpc('initialize', { protocolVersion: '2025-06-18' });
assert.strictEqual(initKnown.result.protocolVersion, '2025-06-18', 'Supported version must be echoed');
const initUnknown = await rpc('initialize', { protocolVersion: '1999-01-01' });
assert.strictEqual(
  initUnknown.result.protocolVersion,
  '2025-11-25',
  'Unsupported version must be answered with the latest supported version'
);
assert.strictEqual(
  initKnown.result.serverInfo.version,
  resolveAppVersion(ROOT_DIR),
  'serverInfo.version must come from the shared app version (git tag / package.json)'
);
assert.strictEqual(initKnown.result.serverInfo.title, 'EP-2350 FX Tool');
assert.ok(initKnown.result.instructions.includes('get_effects_reference'));

// 16b. Notifications, client responses and malformed messages
assert.strictEqual(
  await handleMcpJsonRpcRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  null,
  'Notifications must not get a response'
);
assert.strictEqual(
  await handleMcpJsonRpcRequest({ jsonrpc: '2.0', id: 5, result: {} }),
  null,
  'Client responses must not get a response'
);
const noJsonrpc = await handleMcpJsonRpcRequest({ id: 301, method: 'ping' });
assert.strictEqual(noJsonrpc.error.code, -32600, 'Missing jsonrpc: "2.0" must be -32600');
assert.strictEqual(noJsonrpc.id, 301);
const nullId = await handleMcpJsonRpcRequest({ jsonrpc: '2.0', id: null, method: 'ping' });
assert.strictEqual(nullId.error.code, -32600, 'Null id must be rejected with -32600');

// 16c. Spec error codes
assert.strictEqual((await rpc('tools/call', { name: 'no_such_tool' })).error.code, -32602);
assert.strictEqual((await rpc('resources/read', { uri: 'ep2350://nope' })).error.code, -32002);
assert.strictEqual(
  (await rpc('prompts/get', { name: 'design-fx-from-description', arguments: {} })).error.code,
  -32602,
  'Missing required prompt argument must be -32602'
);
assert.strictEqual((await rpc('no/such/method')).error.code, -32601);

// 16d. A tool that throws returns isError (model-visible), not a protocol error
const badRow = await rpc('tools/call', {
  name: 'validate_preset',
  arguments: { preset: { list: [null] } }
});
assert.ok(badRow.result, 'Tool failure must be a result, not a JSON-RPC error');
assert.strictEqual(badRow.result.isError, true);

// 16e. Streamable HTTP transport rules
const mcpUrl = 'http://localhost:3000/mcp';
const jsonHeaders = { 'Content-Type': 'application/json' };
const sseGet = await handleLocalMcpHttpFetch(
  new Request(mcpUrl, { method: 'GET', headers: { Accept: 'text/event-stream' } })
);
assert.strictEqual(sseGet.status, 405, 'GET with text/event-stream must be 405 (no SSE stream offered)');
const statusGet = await handleLocalMcpHttpFetch(new Request(mcpUrl, { method: 'GET' }));
assert.strictEqual((await statusGet.json()).version, resolveAppVersion(ROOT_DIR));
const del = await handleLocalMcpHttpFetch(new Request(mcpUrl, { method: 'DELETE' }));
assert.strictEqual(del.status, 405, 'DELETE must be 405 on a stateless server');
const badVersion = await handleLocalMcpHttpFetch(
  new Request(mcpUrl, {
    method: 'POST',
    headers: { ...jsonHeaders, 'MCP-Protocol-Version': '1999-01-01' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 302, method: 'ping' })
  })
);
assert.strictEqual(badVersion.status, 400, 'Unsupported MCP-Protocol-Version must be 400');
const batchBody = JSON.stringify([
  { jsonrpc: '2.0', id: 303, method: 'ping' },
  { jsonrpc: '2.0', id: 304, method: 'ping' }
]);
const modernBatch = await handleLocalMcpHttpFetch(
  new Request(mcpUrl, {
    method: 'POST',
    headers: { ...jsonHeaders, 'MCP-Protocol-Version': '2025-06-18' },
    body: batchBody
  })
);
assert.strictEqual(modernBatch.status, 400, 'Batches must be rejected for protocol >= 2025-06-18');
const legacyBatch = await handleLocalMcpHttpFetch(
  new Request(mcpUrl, { method: 'POST', headers: jsonHeaders, body: batchBody })
);
assert.strictEqual(legacyBatch.status, 200, 'Batches stay allowed for 2025-03-26 (no header)');
assert.strictEqual((await legacyBatch.json()).length, 2);

// 16f. stdio transport: parse errors, batches and normal requests
const { spawn } = await import('node:child_process');
const stdioLines = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--no-warnings', path.join(ROOT_DIR, 'mcp/server.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let out = '';
  const timer = setTimeout(() => {
    child.kill();
    reject(new Error(`stdio server timed out; got: ${out}`));
  }, 30000);
  child.stdout.on('data', (chunk) => {
    out += chunk;
    const lines = out.trim().split('\n').filter(Boolean);
    if (lines.length >= 3) {
      clearTimeout(timer);
      child.kill();
      resolve(lines.map((l) => JSON.parse(l)));
    }
  });
  child.stdin.write('this is not json\n');
  child.stdin.write('[{"jsonrpc":"2.0","id":1,"method":"ping"}]\n');
  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  child.stdin.write('{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
});
assert.strictEqual(stdioLines[0].error.code, -32700, 'stdio invalid JSON must be -32700');
assert.strictEqual(stdioLines[1].error.code, -32600, 'stdio batch must be -32600');
assert.deepStrictEqual(stdioLines[2], { jsonrpc: '2.0', id: 2, result: {} });
console.log('✓ Suite 16: MCP protocol compliance (version negotiation, error codes, HTTP + stdio) verified');

// ============================================================================
// SUITE 17: Typed MCP Tool Schemas, Annotations & structuredContent
// ============================================================================
/** Minimal JSON Schema checker for the keywords our tool schemas use. Returns error paths. */
function checkSchema(schema, value, at = '$') {
  const errs = [];
  const typeOf = (v) =>
    v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v;
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((s) => checkSchema(s, value, at).length === 0).length;
    if (matches !== 1) errs.push(`${at}: matched ${matches} oneOf branches`);
    return errs;
  }
  if ('const' in schema && value !== schema.const) errs.push(`${at}: expected const ${schema.const}`);
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${at}: ${JSON.stringify(value)} not in enum`);
  if (schema.type) {
    const t = typeOf(value);
    const ok = schema.type === t || (schema.type === 'number' && t === 'integer');
    if (!ok) return [...errs, `${at}: expected ${schema.type}, got ${t}`];
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${at}: ${value} < ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${at}: ${value} > ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errs.push(`${at}: too many items`);
    if (schema.items) value.forEach((v, i) => errs.push(...checkSchema(schema.items, v, `${at}[${i}]`)));
  }
  if (typeOf(value) === 'object') {
    for (const req of schema.required || []) {
      if (!(req in value)) errs.push(`${at}: missing required "${req}"`);
    }
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties && k in schema.properties) {
        errs.push(...checkSchema(schema.properties[k], v, `${at}.${k}`));
      } else if (schema.additionalProperties === false) {
        errs.push(`${at}: unexpected property "${k}"`);
      } else if (typeof schema.additionalProperties === 'object') {
        errs.push(...checkSchema(schema.additionalProperties, v, `${at}.${k}`));
      }
    }
  }
  return errs;
}

const PATH_ARG = /Path$/;
const allPropNames = (tool) => Object.keys(tool.inputSchema.properties || {});

// 17a. stdio tool list: titles, annotations, output schemas, path args present
const stdioTools = (await rpc('tools/list')).result.tools;
const stdioByName = Object.fromEntries(stdioTools.map((t) => [t.name, t]));
assert.strictEqual(stdioTools.length, 4);
for (const t of stdioTools) {
  assert.ok(t.title && t.annotations && t.outputSchema, `${t.name} must have title, annotations, outputSchema`);
  assert.strictEqual(t.outputSchema.type, 'object', `${t.name} outputSchema must be an object schema`);
}
assert.ok(allPropNames(stdioByName.export_pack_config).includes('outputPath'));
assert.strictEqual(stdioByName.validate_preset.annotations.readOnlyHint, true);
assert.strictEqual(stdioByName.export_pack_config.annotations.destructiveHint, true);
assert.strictEqual(stdioByName.push_to_live_ui.inputSchema.properties.slot.type, 'integer');
assert.strictEqual(stdioByName.get_effects_reference.annotations.readOnlyHint, true);

// 17b. HTTP tool lists hide path args; annotations reflect the transport
const httpToolsRes = await handleLocalMcpHttpFetch(
  new Request('http://localhost:3000/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 400, method: 'tools/list' })
  })
);
const httpTools = (await httpToolsRes.json()).result.tools;
const httpByName = Object.fromEntries(httpTools.map((t) => [t.name, t]));
for (const t of httpTools) {
  assert.ok(!allPropNames(t).some((n) => PATH_ARG.test(n)), `HTTP ${t.name} must not advertise *Path args`);
}
assert.strictEqual(httpByName.export_pack_config.annotations.readOnlyHint, true);
assert.strictEqual(httpByName.push_to_live_ui.annotations.readOnlyHint, false, 'Local live push changes the UI');
const cfToolsRes = await cfWorker.fetch(
  new Request('https://ep2350-fx.pages.dev/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 401, method: 'tools/list' })
  })
);
const cfByName = Object.fromEntries(
  (await cfToolsRes.json()).result.tools.map((t) => [t.name, t])
);
assert.strictEqual(cfByName.push_to_live_ui.annotations.readOnlyHint, true, 'Edge push only returns a URL');

// 17c. The preset schema accepts every official TE preset (editor scale) and they lint clean
const presetSchema = stdioByName.validate_preset.inputSchema.properties.preset;
// Sanity: the checker itself must reject bad presets
assert.ok(checkSchema(presetSchema, { list: [{ effect: 'LOWPASS', cutof: 50 }] }).length > 0);
assert.ok(checkSchema(presetSchema, { list: [{ effect: 'DIST', amount: 99 }] }).length > 0);
assert.ok(checkSchema(presetSchema, { list: [{ effect: 'NOPE' }] }).length > 0);
assert.ok(checkSchema(presetSchema, { list: [], handle: { row: 99, param: 'mix', depth: 1 } }).length > 0);
let officialPresetsChecked = 0;
for (const officialPack of OFFICIAL_TE_PACKS) {
  for (const p of parseConfigJson(officialPack.rawJson).pack.presets) {
    const cleaned = JSON.parse(JSON.stringify(p));
    officialPresetsChecked++;
    const schemaErrs = checkSchema(presetSchema, cleaned);
    assert.deepStrictEqual(schemaErrs, [], `${officialPack.name} / ${p.name} must match PRESET_SCHEMA`);
    const lint = JSON.parse(
      (await rpc('tools/call', { name: 'validate_preset', arguments: { preset: cleaned } })).result
        .content[0].text
    );
    assert.deepStrictEqual(
      lint.warnings.filter((w) => !/SAMPLE/.test(w.message)),
      [],
      `${officialPack.name} / ${p.name} must lint clean`
    );
  }
}

assert.strictEqual(officialPresetsChecked, 12, 'All 12 official presets must be schema-checked');

// 17d. structuredContent matches the text block and the declared outputSchema
const checkStructured = (toolName, res) => {
  assert.strictEqual(res.result.isError, false, `${toolName} should succeed`);
  assert.deepStrictEqual(res.result.structuredContent, JSON.parse(res.result.content[0].text));
  assert.deepStrictEqual(
    checkSchema(stdioByName[toolName].outputSchema, res.result.structuredContent),
    [],
    `${toolName} structuredContent must match its outputSchema`
  );
  return res.result.structuredContent;
};
const sDesign = { preset: cyberWalkiePreset };
checkStructured('get_effects_reference', await rpc('tools/call', { name: 'get_effects_reference', arguments: {} }));
assert.deepStrictEqual(checkSchema(presetSchema, sDesign.preset), [], 'Hand-written preset must match PRESET_SCHEMA');
checkStructured('validate_preset', await rpc('tools/call', { name: 'validate_preset', arguments: { preset: sDesign.preset } }));
checkStructured(
  'validate_preset',
  await rpc('tools/call', { name: 'validate_preset', arguments: { configJson: OFFICIAL_TE_PACKS[0].rawJson } })
);
checkStructured(
  'export_pack_config',
  await rpc('tools/call', { name: 'export_pack_config', arguments: { presets: [sDesign.preset] } })
);
const edgePush = await (
  await cfWorker.fetch(
    new Request('https://ep2350-fx.pages.dev/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 402,
        method: 'tools/call',
        params: { name: 'push_to_live_ui', arguments: { preset: sDesign.preset } }
      })
    })
  )
).json();
checkStructured('push_to_live_ui', edgePush);

// 17e. Error results carry no structuredContent
const errResult = await rpc('tools/call', { name: 'validate_preset', arguments: {} });
assert.strictEqual(errResult.result.isError, true);
assert.ok(!('structuredContent' in errResult.result), 'isError results must omit structuredContent');

// 17f. Registry lint catches common model mistakes
const lintOf = async (preset) =>
  JSON.parse(
    (await rpc('tools/call', { name: 'validate_preset', arguments: { preset } })).result.content[0].text
  ).warnings.map((w) => w.message);
const badParam = await lintOf({ list: [{ effect: 'LOWPASS', cutof: 50 }, { effect: 'SAMPLE' }] });
assert.ok(badParam.some((m) => m.includes('unknown parameter "cutof"')), 'Typo in param name must warn');
const outOfRange = await lintOf({ list: [{ effect: 'DIST', amount: 99 }, { effect: 'SAMPLE' }] });
assert.ok(outOfRange.some((m) => m.includes('"amount"=99 is outside')), 'Out-of-range value must warn');
const hwScaleRes = (
  await rpc('tools/call', {
    name: 'validate_preset',
    arguments: { preset: { list: [{ effect: 'DELAY', echo: 0.4, 'wet-level': 0.5, 'dry-level': 0.9 }, { effect: 'SAMPLE' }] } }
  })
).result.structuredContent;
assert.strictEqual(hwScaleRes.inputScale, 'config', 'A 0..1 preset is detected as config.json scale');
assert.deepStrictEqual(hwScaleRes.warnings, [], '...and converted instead of warned about');
const badMod = await lintOf({
  list: [{ effect: 'RING', frequency: 400, mix: 50 }, { effect: 'SAMPLE' }],
  handle: { row: 0, param: 'cutoff', depth: 50 }
});
assert.ok(badMod.some((m) => m.includes('has no parameter "cutoff"')), 'Mod param mismatch must warn');
// 17g. get_effects_reference: full list, single effect, unknown effect
const fullRef = (await rpc('tools/call', { name: 'get_effects_reference', arguments: {} })).result.structuredContent;
assert.strictEqual(fullRef.effects.length, 11);
assert.ok(fullRef.rules.some((r) => r.includes('editor scale')), 'Reference must explain the editor scale');
const ringRef = (await rpc('tools/call', { name: 'get_effects_reference', arguments: { effect: 'ring' } })).result.structuredContent;
assert.deepStrictEqual(ringRef.effects.map((e) => e.type), ['RING']);
assert.deepStrictEqual(ringRef.effects[0].params.find((p) => p.name === 'frequency').modDepth, { min: -5000, max: 5000, unit: 'Hz' });
const badRef = await rpc('tools/call', { name: 'get_effects_reference', arguments: { effect: 'FLANGER' } });
assert.strictEqual(badRef.result.isError, true);

// 17h. push_to_live_ui without a reachable dev server delivers the shareUrl and is not an error
const pushNoServer = await rpc('tools/call', {
  name: 'push_to_live_ui',
  arguments: { preset: cyberWalkiePreset, uiUrl: 'http://127.0.0.1:9' }
});
assert.strictEqual(pushNoServer.result.isError, false, 'A shareUrl delivery is a success');
assert.strictEqual(pushNoServer.result.structuredContent.pushed, false);
assert.strictEqual(pushNoServer.result.structuredContent.deliveryMode, 'shareUrl');
assert.ok(pushNoServer.result.structuredContent.shareUrl.includes('#preset='));
assert.deepStrictEqual(checkSchema(stdioByName.push_to_live_ui.outputSchema, pushNoServer.result.structuredContent), []);
console.log('✓ Suite 17: Typed MCP tool schemas, annotations & structuredContent verified');

// ============================================================================
// SUITE 18: Shared rolldown MCP bundle (stdio server + Cloudflare Worker)
// ============================================================================
const { bundleMcp, MCP_CORE_ENTRY } = await import(
  pathToFileURL(path.join(ROOT_DIR, 'scripts/bundle-mcp.mjs')).href
);
const bundleOut = path.join(TMP_TEST_BUILD, 'bundle-check', 'mcp-core.mjs');
const { version: bundledVersion } = await bundleMcp({
  rootDir: ROOT_DIR,
  entry: MCP_CORE_ENTRY,
  outFile: bundleOut,
  version: '9.9.9-test'
});
assert.strictEqual(bundledVersion, '9.9.9-test');
const bundleSrc = fs.readFileSync(bundleOut, 'utf8');
assert.ok(!bundleSrc.includes('__APP_VERSION__'), 'Bundle must not contain the raw __APP_VERSION__ token');
assert.ok(!/from\s+['"][^'"]+\?raw['"]/.test(bundleSrc), 'Bundle must inline ?raw imports');
const bundledCore = await import(pathToFileURL(bundleOut).href);
assert.strictEqual(bundledCore.MCP_SERVER_VERSION, '9.9.9-test', 'Injected version must reach serverInfo');
assert.strictEqual(
  bundledCore.MCP_TOOLS.length,
  4,
  'Bundled core must expose all tools (toolSchemas.ts followed via imports, no file list)'
);
const officialRead = await bundledCore.handleMcpCoreRequest({
  jsonrpc: '2.0',
  id: 500,
  method: 'resources/read',
  params: { uri: 'ep2350://presets/official-packs' }
});
assert.strictEqual(
  JSON.parse(officialRead.result.contents[0].text).length,
  3,
  'Official packs (?raw JSON imports) must be inlined into the bundle'
);

// Unresolved imports fail the build instead of producing a broken bundle
const brokenEntryDir = path.join(TMP_TEST_BUILD, 'bundle-broken');
fs.mkdirSync(brokenEntryDir, { recursive: true });
fs.writeFileSync(path.join(brokenEntryDir, 'entry.ts'), "import { nope } from './missing';\nexport const x: number = nope;\n");
await assert.rejects(
  bundleMcp({
    rootDir: brokenEntryDir,
    entry: 'entry.ts',
    outFile: path.join(brokenEntryDir, 'out.mjs'),
    version: '0.0.0'
  }),
  'bundleMcp must reject when an import cannot be resolved'
);

// No hand-maintained compile lists remain in the MCP entry points
for (const rel of ['mcp/server.mjs', 'scripts/build-cloudflare-worker.mjs']) {
  const src = fs.readFileSync(path.join(ROOT_DIR, rel), 'utf8');
  assert.ok(
    !src.includes('stripTypeScriptTypes') && !src.includes('filesToCompile'),
    `${rel} must use scripts/bundle-mcp.mjs instead of a per-file compile list`
  );
}
console.log('✓ Suite 18: Shared rolldown MCP bundle (stdio server + Cloudflare Worker) verified');

// ============================================================================
// SUITE 19: Multi-Tab Lock Guard & Web Serial Port-In-Use Reporting
// ============================================================================
// 19a. Web Locks mode: primary acquires lock, duplicate blocks, closing primary unlocks duplicate
{
  const createMockLockManager = () => {
    const held = new Map();
    const waiters = new Map();
    return {
      async request(name, optsOrCb, maybeCb) {
        const opts = typeof optsOrCb === 'function' ? {} : optsOrCb;
        const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
        if (held.has(name)) {
          if (opts.ifAvailable) {
            return await cb(null);
          }
          await new Promise((resolve) => {
            if (opts.signal?.aborted) return resolve();
            const q = waiters.get(name) ?? [];
            const entry = () => resolve();
            q.push(entry);
            waiters.set(name, q);
            opts.signal?.addEventListener?.('abort', () => resolve(), { once: true });
          });
          if (opts.signal?.aborted) {
            throw new Error('AbortError');
          }
        }
        held.set(name, true);
        try {
          return await cb({ name });
        } finally {
          held.delete(name);
          const q = waiters.get(name);
          if (q && q.length > 0) {
            const next = q.shift();
            next();
          }
        }
      }
    };
  };

  const mockLocks = createMockLockManager();
  const states1 = [];
  const states2 = [];
  const guard1 = createMultiTabGuard({
    locks: mockLocks,
    createBroadcastChannel: null,
    win: null,
    onBlockedChange: (b) => states1.push(b)
  });
  await guard1.ready;
  assert.deepStrictEqual(states1, [false], 'First tab must acquire active lock without blocking');

  const guard2 = createMultiTabGuard({
    locks: mockLocks,
    createBroadcastChannel: null,
    win: null,
    onBlockedChange: (b) => states2.push(b)
  });
  await guard2.ready;
  assert.deepStrictEqual(states2, [true], 'Second tab must be blocked while first tab holds lock');

  // Closing Tab 1 promotes Tab 2 automatically
  guard1.cleanup();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepStrictEqual(states2, [true, false], 'Closing first tab must unblock waiting second tab');
  guard2.cleanup();

  // React StrictMode double-mount on same LockManager must NOT false-trigger blocked state
  const strictLocks = createMockLockManager();
  const strictStates1 = [];
  const strictStates2 = [];
  const s1 = createMultiTabGuard({
    locks: strictLocks,
    createBroadcastChannel: null,
    win: null,
    onBlockedChange: (b) => strictStates1.push(b)
  });
  s1.cleanup();
  const s2 = createMultiTabGuard({
    locks: strictLocks,
    createBroadcastChannel: null,
    win: null,
    onBlockedChange: (b) => strictStates2.push(b)
  });
  await s2.ready;
  assert.deepStrictEqual(strictStates2, [false], 'React StrictMode remount must acquire lock without flashing blocked');
  s2.cleanup();
}

// 19b. BroadcastChannel fallback mode when navigator.locks is unavailable
{
  const channels = new Map();
  const createMockChannel = (name) => {
    const ch = {
      onmessage: null,
      closed: false,
      postMessage(data) {
        if (this.closed) return;
        const peers = channels.get(name) ?? [];
        for (const peer of peers) {
          if (peer !== this && !peer.closed && peer.onmessage) {
            queueMicrotask(() => peer.onmessage({ data }));
          }
        }
      },
      close() {
        this.closed = true;
        const peers = channels.get(name) ?? [];
        channels.set(name, peers.filter((p) => p !== this));
      }
    };
    const list = channels.get(name) ?? [];
    list.push(ch);
    channels.set(name, list);
    return ch;
  };

  const bcStates1 = [];
  const bcStates2 = [];
  const g1 = createMultiTabGuard({
    locks: null,
    createBroadcastChannel: createMockChannel,
    win: null,
    probeDelayMs: 10,
    onBlockedChange: (b) => bcStates1.push(b)
  });
  await g1.ready;
  assert.deepStrictEqual(bcStates1, [false], 'BroadcastChannel fallback: first tab must become leader');

  const g2 = createMultiTabGuard({
    locks: null,
    createBroadcastChannel: createMockChannel,
    win: null,
    probeDelayMs: 10,
    onBlockedChange: (b) => bcStates2.push(b)
  });
  await g2.ready;
  assert.deepStrictEqual(bcStates2, [true], 'BroadcastChannel fallback: second tab must detect leader and block');

  g1.cleanup();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepStrictEqual(bcStates2, [true, false], 'BroadcastChannel fallback: BYE must unblock second tab');
  g2.cleanup();
}

// 19c. Web Serial InvalidStateError ("already open") produces actionable multi-tab/browser error
{
  const prevNav = globalThis.navigator;
  const fakePort = {
    readable: null,
    writable: null,
    async open() {
      const err = new Error('The port is already open.');
      err.name = 'InvalidStateError';
      throw err;
    },
    async close() {}
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      serial: {
        async requestPort() {
          return fakePort;
        }
      }
    },
    configurable: true
  });
  try {
    const client = new Ep2350SerialClient(10, 100);
    await assert.rejects(
      () => client.connect(),
      /already open in another tab, browser, or application/
    );
  } finally {
    Object.defineProperty(globalThis, 'navigator', { value: prevNav, configurable: true });
  }
}

// 19d. Centered MultiTabBanner & App UI multi-tab guard wiring check
const multiTabBannerSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/components/MultiTabBanner.tsx'), 'utf8');
assert.ok(
  multiTabBannerSrc.includes('EP-2350 FX TOOL IS OPEN IN ANOTHER TAB OR BROWSER') &&
    multiTabBannerSrc.includes('data-testid="multi-tab-warning"') &&
    multiTabBannerSrc.includes('fixed inset-0') &&
    multiTabBannerSrc.includes('items-center justify-center'),
  'MultiTabBanner must render centered TE modular alert overlay when another tab holds the session'
);
assert.ok(
  appSrc.includes('createMultiTabGuard') &&
    appSrc.includes('<MultiTabBanner') &&
    appSrc.includes('opacity-20 pointer-events-none select-none') &&
    appSrc.includes('isMultiTabBlocked'),
  'App must wire createMultiTabGuard, dim/disable the app under MultiTabBanner, and gate serial/storage side effects'
);
console.log('✓ Suite 19: Multi-Tab Lock Guard & Web Serial Port-In-Use Reporting verified');

// ============================================================================
// SUITE 20: Presets accepted in either scale (editor 0..100 or config.json 0..1)
// ============================================================================
{
  const callTool = async (name, args) =>
    (await handleMcpJsonRpcRequest({ jsonrpc: '2.0', id: 700, method: 'tools/call', params: { name, arguments: args } }))
      .result.structuredContent;
  const sortKeys = (v) =>
    Array.isArray(v)
      ? v.map(sortKeys)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
        : v;
  const packsDoc = JSON.parse(
    (await handleMcpJsonRpcRequest({ jsonrpc: '2.0', id: 701, method: 'resources/read', params: { uri: 'ep2350://presets/official-packs' } }))
      .result.contents[0].text
  );

  // Every official TE preset, passed exactly as the resource shows it (config scale), is detected,
  // converted, lints clean and serializes back to the identical hardware JSON.
  let checked = 0;
  for (const pk of packsDoc) {
    for (const hw of pk.config.presets) {
      const v = await callTool('validate_preset', { preset: hw });
      assert.strictEqual(v.inputScale, 'config', `${hw.name}: config scale detected`);
      assert.deepStrictEqual(v.warnings, [], `${hw.name}: no warnings`);
      for (const key of ['list', 'handle', 'shake', 'lfo', 'trigger']) {
        assert.deepStrictEqual(sortKeys(v.normalizedPresetJson[key]), sortKeys(hw[key]), `${hw.name}: ${key} round-trips`);
      }
      checked++;
    }
  }
  assert.strictEqual(checked, 12);

  // Export uses the converted values (SPACE ECHO)
  const spaceEcho = packsDoc[1].config.presets[0];
  const exported = await callTool('export_pack_config', { presets: [spaceEcho] });
  assert.deepStrictEqual(sortKeys(exported.configJson.presets[0].list), sortKeys(spaceEcho.list), 'Export keeps config values');

  // hardwarePresetJson / normalizedPresetJson outputs can be passed straight back in
  const editorPreset = { list: [{ effect: 'DELAY', time: 0.3, echo: 40, 'wet-level': 50 }, { effect: 'SAMPLE' }] };
  const fromEditor = await callTool('validate_preset', { preset: editorPreset });
  assert.strictEqual(fromEditor.inputScale, 'editor');
  assert.deepStrictEqual(fromEditor.normalizedPresetJson.list[0], { effect: 'DELAY', time: 0.3, echo: 0.4, 'wet-level': 0.5 });
  const roundTrip = await callTool('validate_preset', { preset: fromEditor.normalizedPresetJson });
  assert.strictEqual(roundTrip.inputScale, 'config');
  assert.deepStrictEqual(roundTrip.normalizedPresetJson.list, fromEditor.normalizedPresetJson.list);
}
console.log('✓ Suite 20: Presets accepted in either scale (editor 0..100 or config.json 0..1) verified');

console.log('\n=== ALL 20 PRODUCTION TEST SUITES PASSED (100%) ===');
