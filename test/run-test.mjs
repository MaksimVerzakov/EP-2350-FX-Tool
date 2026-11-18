import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
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
    'src/utils/userPacks.ts',
    'src/utils/webSerial.ts',
    'src/utils/tabGuard.ts',
    'src/utils/wavCodec.ts',
    'src/utils/busRouting.ts',
    'src/utils/samples.ts',
    'src/utils/zip.ts',
    'src/dsp/math.ts',
    'src/dsp/synthSamples.ts',
    'src/dsp/AudioEngine.ts',
    'src/validation/presetCheck.ts',
    'src/validation/presetTools.ts'
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
const { DspAudioEngine, BUNDLED_SAMPLES, samplePlaybackRate } = await import(
  pathToFileURL(path.join(TMP_TEST_BUILD, 'src/dsp/AudioEngine.mjs')).href
);
const { decodeWavBuffer, encodeWavBuffer, generateSyntheticVocalPcm } = await import(
  pathToFileURL(path.join(TMP_TEST_BUILD, 'src/utils/wavCodec.mjs')).href
);
const { validatePresetInput } = await import(
  pathToFileURL(path.join(TMP_TEST_BUILD, 'src/validation/presetTools.mjs')).href
);
const samplesLib = await import(pathToFileURL(path.join(TMP_TEST_BUILD, 'src/utils/samples.mjs')).href);
const { createZip, crc32 } = await import(pathToFileURL(path.join(TMP_TEST_BUILD, 'src/utils/zip.mjs')).href);

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

// Verify 16-row hardware limit, and that EQUALISER gets no compatibility warning
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
  !oversizedIssues.some((i) => /EQUALISER|firmware/i.test(i.message) && i.type === 'warning'),
  'EQUALISER is a documented effect: no compatibility warning'
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
  (topBannerSrc.match(/w-\[251px\] h-\[76px\]/g) || []).length,
  2,
  'Both left and right TopBanner blocks must share identical 10x3-cell (251x76) modular dimensions'
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
    },
    setValueAtTime(val) {
      this.value = val;
    },
    cancelScheduledValues() {}
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
assert.ok(inputGate.connections.includes(engine.getDuckGain()), 'inputNoiseGate must feed into the duck gain');
assert.ok(engine.getDuckGain().connections.includes(engine.sourceHub), 'duck gain must feed into sourceHub');

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
assert.strictEqual(sampleNode2.nodeRefs.lastRate, 2.0, 'SAMPLE +12 semitones must double the playback rate (tape-style)');
assert.strictEqual(sampleNode2.nodeRefs.pitchShifter, undefined, 'SAMPLE pitch must not use a time-preserving pitch shifter');
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

// 8z. BUS lanes: rows without BUS after the bus rows process the mix of both buses
{
  const { busLanes } = await import(pathToFileURL(path.join(TMP_TEST_BUILD, 'src/utils/busRouting.mjs')).href);
  assert.deepStrictEqual(busLanes([{}, {}, {}]), [1, 1, 1], 'No BUS anywhere: a plain series chain');
  assert.deepStrictEqual(busLanes([{}, { BUS: 2 }, {}]), [1, 2, 'mix'], 'A row without BUS after the bus rows is a mix row');
  assert.deepStrictEqual(busLanes([{ BUS: 2 }, { BUS: 1 }, { BUS: 1 }, {}, {}]), [2, 1, 1, 'mix', 'mix']);
  assert.deepStrictEqual(busLanes([{}, { BUS: 1 }, { BUS: 2 }]), [1, 1, 2], 'Rows without BUS before the bus rows stay on bus 1');

  const reach = (from) => {
    const seen = new Set();
    const stack = [from];
    while (stack.length) {
      const n = stack.pop();
      if (!n || seen.has(n)) continue;
      seen.add(n);
      (n.connections || []).forEach((c) => stack.push(c));
    }
    return seen;
  };
  const busEngine = new DspAudioEngine();
  await busEngine.init();
  const dualMono = {
    id: 'dm', pos: 0, name: 'DUAL MONO', comment: '',
    list: [
      { id: 'b0', effect: 'BALANCE', balance: 1, BUS: 2 },
      { id: 'b1', effect: 'SAMPLE', BUS: 1 },
      { id: 'b2', effect: 'DELAY', time: 0.35, echo: 40, BUS: 1 },
      { id: 'b3', effect: 'BALANCE', balance: 0, BUS: 1 },
      { id: 'b4', effect: 'BALANCE', balance: 0.8 }
    ],
    handle: { row: 4, param: 'balance', depth: -20 },
    trigger: { row: 1 }
  };
  busEngine.updatePreset(dualMono);
  await busEngine.start();
  const balRow = (row) => busEngine.activeNodes.find((n) => n.effectType === 'BALANCE' && n.nodeRefs.rowIdx === row).nodeRefs;
  const mixIn = balRow(4).panner;
  assert.ok(reach(balRow(0).chopperGain).has(mixIn), 'Bus 2 output feeds the mix row');
  assert.ok(reach(balRow(3).chopperGain).has(mixIn), 'Bus 1 output feeds the mix row');
  assert.ok(reach(balRow(4).chopperGain).has(busEngine.gainMaster), 'The mix row feeds the master gain');
  assert.ok(!reach(balRow(0).chopperGain).has(balRow(3).panner), 'Bus 2 does not run through bus 1');

  // Rebuilding cuts the old chain, mix rows included, from the master gain
  const oldMixOut = balRow(4).chopperGain;
  busEngine.updatePreset({ ...dualMono, list: dualMono.list.slice(0, 4) });
  assert.ok(!reach(oldMixOut).has(busEngine.gainMaster), 'Old mix rows are disconnected on rebuild');
  busEngine.stop();

  // The summary names mix rows, and the editor marks them and keeps moved rows on Bus 1
  const dmSummary = validatePresetInput({ preset: dualMono }).summary;
  assert.ok(dmSummary[0].includes('BALANCE (bus 1) → BALANCE (mix)'), dmSummary[0]);
  assert.ok(dmSummary.some((l) => l.includes('row 4 (no BUS, after the bus rows) processes that mix')), JSON.stringify(dmSummary));
  const ledgerSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/components/PresetLedger.tsx'), 'utf8');
  assert.ok(ledgerSrc.includes("lanes[globalIdx] === 'mix'") && ledgerSrc.includes('processes the mix of Bus 1 and Bus 2'), 'Editor shows a MIX badge with a tooltip');
  assert.ok(ledgerSrc.includes('if (othersUseBus) updated.BUS = 1;'), 'Moving a row to Bus 1 writes BUS 1 while other rows use BUS');
}

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
// SUITE 11: Preset validation entry point (src/validation/presetTools.ts)
// ============================================================================
// 11a. A hand-written editor-scale preset validates and yields a share link
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
  shake: { row: 3, param: 'frequency', depth: 900 },
  trigger: { row: 4 }
};
const validatePayload = validatePresetInput({ preset: cyberWalkiePreset });
assert.strictEqual(validatePayload.isValid, true, 'Hand-written preset must have 0 hardware validation errors');
assert.deepStrictEqual(validatePayload.warnings, [], 'Hand-written preset must lint clean');
const designPayload = { preset: cyberWalkiePreset, ...validatePayload };
assert.ok(designPayload.shareUrl.includes('#preset='), 'Validation returns a shareUrl to review the preset');
assert.strictEqual(decodeHashPayload(designPayload.shareUrl).preset.name, 'CYBER WALKIE');

// 11b. Neither a preset nor a config.json
assert.ok(typeof validatePresetInput({}).error === 'string');

// 11c. Common model mistakes are errors pointing at the exact field (details in Suite 15)
const errorsOf = (preset) => validatePresetInput({ preset }).errors;
const badParam = errorsOf({ list: [{ effect: 'LOWPASS', cutof: 50 }, { effect: 'SAMPLE' }] });
assert.ok(badParam.some((e) => e.path === 'list[0].cutof' && e.code === 'unknown_param' && e.fix.includes('"cutoff"')));
const outOfRange = errorsOf({ list: [{ effect: 'DIST', amount: 99 }, { effect: 'SAMPLE' }] });
assert.ok(outOfRange.some((e) => e.path === 'list[0].amount' && e.code === 'out_of_range' && e.message.includes('0..40')));
const hwScaleRes = validatePresetInput({
  preset: { list: [{ effect: 'DELAY', echo: 0.4, 'wet-level': 0.5, 'dry-level': 0.9 }, { effect: 'SAMPLE' }] }
});
assert.strictEqual(hwScaleRes.inputScale, 'config', 'A 0..1 preset is detected as config.json scale');
assert.deepStrictEqual(hwScaleRes.errors, [], '...and accepted without errors');
const badMod = errorsOf({
  list: [{ effect: 'RING', frequency: 400, mix: 50 }, { effect: 'SAMPLE' }],
  handle: { row: 0, param: 'cutoff', depth: 50 }
});
assert.ok(badMod.some((e) => e.path === 'handle.param' && e.fix.includes('frequency, mix')));
console.log('✓ Suite 11: Preset validation entry point verified');

// ============================================================================
// SUITE 12: Stateless #preset=... & #pack=... Deep-Link Codec
// ============================================================================
// 12a. Base64URL Unicode & ASCII round-trip
const unicodeSample = 'DAFT VOCODER · EP–2350 {"mix":0.75}';
assert.strictEqual(
  decodeBase64Url(encodeBase64Url(unicodeSample)),
  unicodeSample,
  'encodeBase64Url / decodeBase64Url must round-trip UTF-8 strings losslessly'
);

// 12b. Single preset round-trip (both UI-scale 0..100 and hardware-scale 0.0..1.0)
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

// 12c. Full pack round-trip (#pack=<b64url>&slot=1)
const dubPackParsed = parseConfigJson(OFFICIAL_TE_PACKS[1].rawJson).pack;
const sharePackUrl = buildPackShareUrl('https://ep2350.example.com', dubPackParsed, 1);
assert.ok(sharePackUrl.includes('#pack=') && sharePackUrl.endsWith('&slot=1'));
const decodedPackPayload = decodeHashPayload(sharePackUrl);
assert.ok(decodedPackPayload && decodedPackPayload.type === 'pack');
assert.strictEqual(decodedPackPayload.slot, 1);
assert.strictEqual(decodedPackPayload.pack.name, dubPackParsed.name);
assert.strictEqual(decodedPackPayload.pack.presets.length, 4);

// 12d. Malformed hash resilience
assert.strictEqual(decodeHashPayload(''), null);
assert.strictEqual(decodeHashPayload('#preset=!!!not_base64!!!'), null);
assert.strictEqual(decodeHashPayload('#unknown=123'), null);

// 12e. App.tsx integrates decodeHashPayload and hashchange listener
assert.ok(
  appSrc.includes('decodeHashPayload') && appSrc.includes("addEventListener('hashchange'"),
  'App.tsx must decode #preset= / #pack= hashes on mount and hashchange'
);
console.log('✓ Suite 12: Stateless #preset=... & #pack=... Deep-Link Codec verified');

// ============================================================================
// SUITE 13: Multi-Tab Lock Guard & Web Serial Port-In-Use Reporting
// ============================================================================
// 13a. Web Locks mode: primary acquires lock, duplicate blocks, closing primary unlocks duplicate
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

// 13b. BroadcastChannel fallback mode when navigator.locks is unavailable
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

// 13c. Web Serial InvalidStateError ("already open") produces actionable multi-tab/browser error
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

// 13d. Centered MultiTabBanner & App UI multi-tab guard wiring check
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
console.log('✓ Suite 13: Multi-Tab Lock Guard & Web Serial Port-In-Use Reporting verified');

// ============================================================================
// SUITE 14: Presets accepted in either scale (editor 0..100 or config.json 0..1)
// ============================================================================
{
  const sortKeys = (v) =>
    Array.isArray(v)
      ? v.map(sortKeys)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
        : v;
  const packsDoc = OFFICIAL_TE_PACKS.map((p) => ({ config: JSON.parse(p.rawJson) }));

  // Every official TE preset, passed exactly as config.json has it (config scale), is detected,
  // converted, lints clean and serializes back to the identical hardware JSON.
  let checked = 0;
  for (const pk of packsDoc) {
    for (const hw of pk.config.presets) {
      const v = validatePresetInput({ preset: hw });
      assert.strictEqual(v.inputScale, 'config', `${hw.name}: config scale detected`);
      assert.deepStrictEqual(v.warnings, [], `${hw.name}: no warnings`);
      for (const key of ['list', 'handle', 'shake', 'lfo', 'trigger']) {
        assert.deepStrictEqual(sortKeys(v.normalizedPresetJson[key]), sortKeys(hw[key]), `${hw.name}: ${key} round-trips`);
      }
      checked++;
    }
  }
  assert.strictEqual(checked, 12);

  // normalizedPresetJson output can be passed straight back in
  const editorPreset = { list: [{ effect: 'DELAY', time: 0.3, echo: 40, 'wet-level': 50 }, { effect: 'SAMPLE' }] };
  const fromEditor = validatePresetInput({ preset: editorPreset });
  assert.strictEqual(fromEditor.inputScale, 'editor');
  assert.deepStrictEqual(fromEditor.normalizedPresetJson.list[0], { effect: 'DELAY', time: 0.3, echo: 0.4, 'wet-level': 0.5 });
  const roundTrip = validatePresetInput({ preset: fromEditor.normalizedPresetJson });
  assert.strictEqual(roundTrip.inputScale, 'config');
  assert.deepStrictEqual(roundTrip.normalizedPresetJson.list, fromEditor.normalizedPresetJson.list);
}
console.log('✓ Suite 14: Presets accepted in either scale (editor 0..100 or config.json 0..1) verified');

// ============================================================================
// SUITE 15: Verbose validation (exact path, message, fix) and plain-language summary
// ============================================================================
{
  const validate = async (args) => validatePresetInput(args);
  const find = (res, path, code) => res.errors.concat(res.warnings).find((i) => i.path === path && (!code || i.code === code));

  // Every issue carries type, code, path, message and fix
  const broken = await validate({
    preset: {
      name: 'BROKEN',
      colour: 'red',
      list: [
        { effect: 'LOWPAS', cutoff: 0.5 },
        { effect: 'DELAY', tme: 0.3, echo: 140, 'wet-level': 50 },
        { effect: 'DELAY', time: 2 },
        { effect: 'ECHO' },
        { effect: 'DIST', amount: 'loud', BUS: 3 },
        { effect: 'SAMPLE' }
      ],
      handle: { row: 9, param: 'cutoff', depth: 40 },
      shake: { row: 1, param: 'wet-levl', depth: 30 },
      lfo: { row: 1, param: 'time', depth: 5, shape: 'triangle', speed: 0 },
      trigger: { row: 1 }
    }
  });
  assert.strictEqual(broken.isValid, false);
  for (const i of broken.errors.concat(broken.warnings)) {
    assert.ok(i.type && i.code && i.path && i.message && i.fix, `Issue must be complete: ${JSON.stringify(i)}`);
  }
  assert.ok(find(broken, 'colour', 'unknown_preset_key'), 'Unknown preset field');
  assert.ok(find(broken, 'list[0].effect', 'unknown_effect').fix.includes('"LOWPASS"'), 'Typo suggests LOWPASS');
  assert.ok(find(broken, 'list[3].effect', 'unknown_effect').fix.includes('"DELAY"'), 'Alias ECHO suggests DELAY');
  assert.ok(find(broken, 'list[1].tme', 'unknown_param').fix.includes('"time"'), 'Param typo suggests time');
  assert.ok(find(broken, 'list[1].echo', 'out_of_range').message.includes('0..100 %'), 'Range is stated');
  assert.ok(find(broken, 'list[2].time', 'out_of_range').fix.includes('between 0 and 1.1'));
  assert.ok(find(broken, 'list[2].effect', 'duplicate_effect').message.includes('rows 1, 2'));
  assert.ok(find(broken, 'list[4].amount', 'param_not_number'));
  assert.ok(find(broken, 'list[4].BUS', 'bad_bus'));
  assert.ok(find(broken, 'handle.row', 'bad_row').fix.includes('0=LOWPAS'), 'Row fix lists the rows');
  assert.ok(find(broken, 'shake.param', 'bad_param').fix.includes('"wet-level"'), 'Mod param typo suggests wet-level');
  assert.ok(find(broken, 'lfo.depth', 'depth_out_of_range').message.includes('-1.1..1.1 s'));
  assert.ok(find(broken, 'lfo.shape', 'bad_shape'));
  assert.ok(find(broken, 'lfo.speed', 'bad_speed'));
  assert.ok(find(broken, 'trigger.row', 'trigger_not_sample').fix.includes('Set trigger.row to 5'));
  assert.strictEqual(broken.summary.length, 0, 'No summary while the preset cannot be read');

  // Structural problems never crash and never produce a share link
  for (const [label, preset, code, path] of [
    ['not an object', 'DELAY', 'preset_not_object', '(preset)'],
    ['no list', { name: 'X' }, 'missing_list', 'list'],
    ['row null', { list: [null] }, 'row_not_object', 'list[0]'],
    ['row without effect', { list: [{ time: 0.3 }] }, 'missing_effect', 'list[0].effect']
  ]) {
    const res = await validate({ preset });
    assert.strictEqual(res.isValid, false, label);
    assert.ok(find(res, path, code), `${label}: ${code} at ${path}`);
    assert.strictEqual(res.shareUrl, undefined, `${label}: no shareUrl`);
  }

  // Too many rows, silent rows, extreme filters, zero depth, missing SAMPLE
  const tooMany = await validate({ preset: { list: Array.from({ length: 16 }, () => ({ effect: 'LOWPASS', cutoff: 0.5 })) } });
  assert.ok(find(tooMany, 'list', 'too_many_rows').message.includes('17 rows'), 'Counts the SAMPLE row export adds');
  const quiet = await validate({
    preset: {
      list: [
        { effect: 'LOWPASS', cutoff: 0.05 },
        { effect: 'REVERB', 'wet-level': 0, 'dry-level': 0 },
        { effect: 'EQUALISER', CUTOFF: 0.5 }
      ],
      handle: { row: 0, param: 'cutoff', depth: 0 }
    }
  });
  assert.strictEqual(quiet.isValid, true, 'Warnings alone do not invalidate a preset');
  for (const code of ['filter_extreme', 'silent_row', 'zero_depth', 'missing_sample']) {
    assert.ok(quiet.warnings.some((w) => w.code === code), `warning ${code}`);
  }
  assert.ok(!quiet.warnings.some((w) => w.code === 'firmware_support'), 'No firmware warning for EQUALISER');
  assert.ok(!JSON.stringify(quiet).toLowerCase().includes('firmware'), 'Validation output never mentions firmware');

  // A normalized 0..1 knob reports its range without a misleading unit: REVERB time is 0..1 (0-6 s), not 0..1 s
  const reverbTime = await validate({ preset: { list: [{ effect: 'REVERB', time: 2.5 }, { effect: 'SAMPLE' }] } });
  const reverbMsg = find(reverbTime, 'list[0].time', 'out_of_range').message;
  assert.ok(!reverbMsg.includes('0..1 s'), `REVERB time range must not read as 0..1 seconds: ${reverbMsg}`);
  assert.ok(/0\.\.1 \(0\.0s to 6\.0s\)/.test(reverbMsg), `REVERB time range must say what 0..1 means: ${reverbMsg}`);

  // Config scale ranges and messages use the 0..1 scale
  const cfgRange = await validate({ preset: { list: [{ effect: 'DELAY', echo: 0.4, 'wet-level': 1.5 }, { effect: 'SAMPLE' }] } });
  assert.strictEqual(cfgRange.inputScale, 'editor', 'A value above 1 means editor scale');
  const cfgOk = await validate({ preset: { list: [{ effect: 'DELAY', echo: 0.4, 'wet-level': 0.5 }, { effect: 'SAMPLE' }], handle: { row: 0, param: 'wet-level', depth: 2 } } });
  assert.strictEqual(cfgOk.inputScale, 'editor', 'A depth of 2 (2%) keeps editor scale');

  // configJson: strict JSON errors with position, pack-level checks, per-preset paths
  const badJson = await validate({ configJson: '{"name":"X","presets":[{"pos":0,}]}' });
  assert.strictEqual(badJson.errors[0].code, 'invalid_json');
  assert.ok(/position|column/.test(badJson.errors[0].message), 'JSON error gives the position');
  const dupPos = await validate({
    configJson: JSON.stringify({ name: 'P', presets: [{ pos: 0, list: [{ effect: 'SAMPLE' }] }, { pos: 0, list: [{ effect: 'SAMPLE' }] }] })
  });
  assert.ok(find(dupPos, 'presets[1].pos', 'duplicate_pos'));
  const packParam = await validate({
    configJson: JSON.stringify({ name: 'P', presets: [{ pos: 0, list: [{ effect: 'DIST', amount: 5, mix: 2 }, { effect: 'SAMPLE' }] }] })
  });
  assert.ok(find(packParam, 'presets[0].list[0].mix', 'out_of_range').message.includes('0..1'), 'config.json is checked in 0..1 scale');

  // Summary: what the preset does, in plain words, from the settings
  const good = await validate({
    preset: {
      name: 'DUB RADIO',
      list: [
        { effect: 'HIGHPASS', cutoff: 0.35 },
        { effect: 'LOWPASS', cutoff: 0.55 },
        { effect: 'DELAY', time: 0.35, echo: 50, 'wet-level': 45 },
        { effect: 'HARMONY', pitch: 1.5, 'dry-level': 30 },
        { effect: 'SAMPLE' }
      ],
      handle: { row: 1, param: 'cutoff', depth: 40 },
      shake: { row: 2, param: 'wet-level', depth: 40 },
      lfo: { row: 2, param: 'time', depth: 0.02, shape: 'sine', speed: 0.3 },
      trigger: { row: 4 }
    }
  });
  assert.strictEqual(good.isValid, true);
  assert.deepStrictEqual(good.errors, []);
  assert.deepStrictEqual(good.warnings, []);
  const text = good.summary.join('\n');
  assert.ok(text.includes('Signal chain: voice → HIGHPASS → LOWPASS → DELAY → HARMONY → SAMPLE'));
  assert.ok(text.includes('HIGHPASS at ≈224 Hz'));
  assert.ok(text.includes('LOWPASS at ≈893 Hz: muffled, dark'));
  assert.ok(text.includes('echo every 350 ms, feedback 50% (repeats fade out over ≈3.5 s)'));
  assert.ok(text.includes('+7.0 semitones'));
  assert.ok(text.includes('handle moves row 1 LOWPASS cutoff from ≈893 Hz to ≈14 kHz'));
  assert.ok(text.includes('Shaking briefly pushes row 2 DELAY wet-level from 45% to 85%'));
  assert.ok(text.includes('LFO (sine, 0.3 Hz) swings row 2 DELAY time between 330 ms and 370 ms'));
  const noMods = await validate({ preset: { list: [{ effect: 'RING', frequency: 200, mix: 60 }, { effect: 'SAMPLE' }] } });
  assert.ok(noMods.summary.includes('Handle: not used (squeezing does nothing).'));

  // SAMPLE must not go on BUS 2; BUS 1 or no BUS is fine
  const onBus2 = await validate({ preset: { list: [{ effect: 'DELAY', BUS: 1 }, { effect: 'SAMPLE', BUS: 2 }], trigger: { row: 1 } } });
  assert.strictEqual(onBus2.isValid, false);
  assert.ok(find(onBus2, 'list[1].BUS', 'sample_on_bus2'), 'SAMPLE on BUS 2 is an error');
  const onBus1 = await validate({ preset: { list: [{ effect: 'DELAY', BUS: 2 }, { effect: 'SAMPLE', BUS: 1 }], trigger: { row: 1 } } });
  assert.ok(!find(onBus1, 'list[1].BUS', 'sample_on_bus2'), 'SAMPLE on BUS 1 is allowed');

  // A missing trigger is a warning naming the SAMPLE row, and export points the trigger at it
  const noTrigger = await validate({ preset: { list: [{ effect: 'SAMPLE' }, { effect: 'DELAY' }] } });
  const trigWarn = find(noTrigger, 'trigger', 'missing_trigger');
  assert.ok(trigWarn && trigWarn.type === 'warning' && trigWarn.fix.includes('"row": 0'), 'missing_trigger warning with the SAMPLE row');
  assert.deepStrictEqual(noTrigger.normalizedPresetJson.trigger, { row: 0 }, 'Export adds trigger at the SAMPLE row');
  const withTrigger = await validate({ preset: { list: [{ effect: 'SAMPLE' }], trigger: { row: 0 } } });
  assert.ok(!find(withTrigger, 'trigger', 'missing_trigger'));

  // A samples block is a warning: WAV files cannot travel with the pack
  const withSamples = validatePresetInput({
    configJson: JSON.stringify({ name: 'S', samples: [{ file: 'drum.wav', playmode: 'oneshot' }], presets: [{ pos: 0, name: 'A', list: [{ effect: 'SAMPLE' }], trigger: { row: 0 } }] })
  });
  assert.strictEqual(withSamples.isValid, true, 'samples block alone does not invalidate');
  assert.ok(find(withSamples, 'samples', 'samples_block'), 'samples block warning');
}
console.log('✓ Suite 15: Verbose validation (exact path, message, fix) and plain-language summary verified');

// ============================================================================
// SUITE 16: Format guide (generated from EFFECTS_REGISTRY), build and MCP panel
// ============================================================================
{
  const { bundleTs } = await import(pathToFileURL(path.join(ROOT_DIR, 'scripts/bundle-ts.mjs')).href);
  const { outFile: guideFile } = await bundleTs({
    rootDir: ROOT_DIR,
    entry: 'src/mcp/formatGuide.ts',
    outFile: path.join(TMP_TEST_BUILD, 'format-guide.mjs'),
    version: '9.9.9-test'
  });
  const { renderFormatGuide } = await import(pathToFileURL(guideFile).href);

  // 16a. The guide documents every effect and parameter, in config.json scale, and points at the MCP tools
  const guide = renderFormatGuide({ appUrl: 'https://example.test/app' });
  assert.ok(guide.startsWith('# EP-2350 format guide\n'), 'No skill frontmatter');
  assert.ok(!guide.includes('9.9.9-test') && !/^Version /m.test(guide), 'Guide prints no app version (models mistake it for a firmware version)');
  assert.ok(!guide.includes('https://example.test/app'), 'Guide does not print the web app URL; validate_pack returns the share link');
  assert.ok(!/firmware/i.test(guide), 'Guide makes no firmware claims');
  for (const tool of ['validate_pack', 'get_example_pack']) assert.ok(guide.includes(`\`${tool}\``), `Guide must point at ${tool}`);
  assert.ok(!/skill|scripts\/ep2350|node .*validate|Checking by hand/i.test(guide), 'No skill, CLI or by-hand instructions left');
  for (const meta of Object.values(EFFECTS_REGISTRY)) {
    assert.ok(guide.includes(`### ${meta.type}\n`), `Guide must document ${meta.type}`);
    const section = guide.split(`### ${meta.type}\n`)[1].split('\n### ')[0];
    for (const p of meta.params) {
      assert.ok(section.includes(`| \`${p.name}\` |`), `Guide must list ${meta.type}.${p.name}`);
    }
  }
  // Percent knobs are documented in config.json scale (0..1), never as 0..100
  assert.ok(/\| `echo` \| [^|]+ \| 0 \.\. 1 \| 0\.4 \| -1 \.\. 1 \|/.test(guide), 'Percent parameters must be shown as 0..1');
  assert.ok(guide.includes('| `frequency` | carrier freq | 0 .. 20000 Hz | 440 | -5000 .. 5000 Hz |'));

  // Rules come first, before the examples and the effect tables, and cover what assistants get wrong
  const at = (h) => guide.indexOf(`\n## ${h}\n`);
  assert.ok(at('Rules') > 0 && at('Rules') < at('Examples') && at('Examples') < at('Effects'), 'Rules, then Examples, then Effects');
  const rules = guide.slice(at('Rules'), at('Examples'));
  for (const needle of ['Strict JSON', 'case-sensitive', '`EQUALISER` (spelled with an S)', '`CUTOFF`, `Q`, `GAIN`', 'SAMPLE never goes on BUS 2', '`trigger.row` is the SAMPLE row', 'counted from 0', 'not percentages', '`samples`']) {
    assert.ok(rules.includes(needle), `Rules must mention ${needle}`);
  }
  assert.ok(guide.includes('https://teenage.engineering/guides/ep-2350'), 'Guide links the official TE guide');
  for (const h of ['Values', 'Buses', 'Modulation', 'Sound design']) assert.ok(at(h) > 0, `Guide has a ${h} section`);
  assert.ok(!/resonant/i.test(guide), 'Filters have no resonance parameter, so the guide does not call them resonant');

  // Every JSON example in the guide passes validate_pack with no errors and no warnings
  const examples = [...guide.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.ok(examples.length >= 1, 'Guide has JSON examples');
  for (const ex of examples) {
    const res = validatePresetInput({ configJson: ex });
    assert.strictEqual(res.isValid, true, `Guide example must be valid: ${JSON.stringify(res.errors)}`);
    assert.deepStrictEqual(res.warnings, [], `Guide example must have no warnings: ${JSON.stringify(res.warnings)}`);
  }
  const exText = JSON.stringify(JSON.parse(examples[0]));
  for (const needle of ['"BAD RECEPTION"', '"EQUALISER","CUTOFF"', '"BUS":2', '"lfo"']) assert.ok(exText.includes(needle), `Examples show ${needle}`);

  // 16b. The skill is retired: no build script, CLI, dev route or published files
  for (const gone of ['scripts/build-skill.mjs', 'src/skill']) {
    assert.ok(!fs.existsSync(path.join(ROOT_DIR, gone)), `${gone} was removed with the skill`);
  }
  const viteSrc = fs.readFileSync(path.join(ROOT_DIR, 'vite.config.ts'), 'utf8');
  assert.ok(!viteSrc.includes('skill'), 'vite dev no longer serves skill files');
  const deployYml = fs.readFileSync(path.join(ROOT_DIR, '.github/workflows/deploy.yml'), 'utf8');
  assert.ok(!deployYml.includes('include-hidden-files'), 'No .well-known/agent-skills to publish');

  // 16c. Unresolved imports fail the bundle instead of producing a broken Worker
  const brokenEntryDir = path.join(TMP_TEST_BUILD, 'bundle-broken');
  fs.mkdirSync(brokenEntryDir, { recursive: true });
  fs.writeFileSync(path.join(brokenEntryDir, 'entry.ts'), "import { nope } from './missing';\nexport const x: number = nope;\n");
  await assert.rejects(
    bundleTs({ rootDir: brokenEntryDir, entry: 'entry.ts', outFile: path.join(brokenEntryDir, 'out.mjs'), version: '0.0.0' }),
    'bundleTs must reject when an import cannot be resolved'
  );

  // 16d. The production build builds the web app and the Worker, nothing else
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  assert.ok(!('skill' in pkg.scripts) && !pkg.scripts.build.includes('skill'), 'No skill build step');
  assert.ok(pkg.scripts.build.includes('scripts/build-worker.mjs'), 'npm run build must build the Cloudflare Worker');
  assert.ok(!fs.readFileSync(path.join(ROOT_DIR, 'vite.config.ts'), 'utf8').includes('__mcp_sync'));
  assert.ok(!appSrc.includes('__mcp_sync'), 'App.tsx has no MCP live-push bridge');

  // 16e. UI exposes the FX CHAIN / MCP switch and the connect guide
  assert.ok(appSrc.includes('FX CHAIN') && appSrc.includes("label: 'MCP'"), 'App.tsx must provide the FX CHAIN | MCP switch');
  assert.ok(appSrc.includes('McpPanel'), 'App.tsx must render McpPanel when switched to MCP');
  const mcpPanelSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/components/McpPanel.tsx'), 'utf8');
  for (const needle of ['h-[626px]', 'HOW IT WORKS', 'HOW TO CONNECT', 'DEFAULT_MCP_URL', '/mcp']) {
    assert.ok(mcpPanelSrc.includes(needle), `McpPanel.tsx must contain ${needle}`);
  }
}
console.log('✓ Suite 16: Format guide, build and MCP panel verified');

// ============================================================================
// SUITE 17: Remote MCP server (Streamable HTTP) and its Cloudflare Worker
// ============================================================================
{
  const { bundleTs } = await import(pathToFileURL(path.join(ROOT_DIR, 'scripts/bundle-ts.mjs')).href);
  const mcpDir = path.join(TMP_TEST_BUILD, 'mcp');
  const { outFile: workerFile } = await bundleTs({
    rootDir: ROOT_DIR,
    entry: 'src/mcp/worker.ts',
    outFile: path.join(mcpDir, 'worker.mjs'),
    platform: 'neutral',
    version: '9.9.9'
  });
  const worker = (await import(pathToFileURL(workerFile).href)).default;
  const ORIGIN = 'https://ep.example.workers.dev';
  // The Worker logs one JSON line per MCP message: collect them instead of printing them.
  const mcpLogs = [];
  const realConsoleLog = console.log;
  console.log = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('{"event":"mcp"')) mcpLogs.push(JSON.parse(args[0]));
    else realConsoleLog(...args);
  };
  const assetsHits = [];
  const env = { ASSETS: { fetch: async (req) => (assetsHits.push(new URL(req.url).pathname), new Response('asset')) } };
  let nextId = 1;
  const rpc = async (method, params, { id = nextId++ } = {}) => {
    const res = await worker.fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify(id === null ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params })
      }),
      env
    );
    return { status: res.status, headers: res.headers, body: res.status === 202 ? null : await res.json() };
  };

  // 17a. initialize: protocol negotiation, server info, workflow instructions
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.strictEqual(init.status, 200);
  assert.strictEqual(init.headers.get('access-control-allow-origin'), '*', 'Public endpoint: browser-based clients may call it');
  assert.strictEqual(init.body.result.protocolVersion, '2025-06-18');
  assert.strictEqual(init.body.result.serverInfo.version, '9.9.9');
  assert.ok(init.body.result.capabilities.tools);
  assert.ok(/validate_pack/.test(init.body.result.instructions) && /share link/.test(init.body.result.instructions));
  const oldInit = await rpc('initialize', { protocolVersion: '1999-01-01' });
  assert.strictEqual(oldInit.body.result.protocolVersion, '2025-11-25', 'Unknown versions get the latest supported one');

  // 17b. notifications get 202 with no body; ping; unknown methods error
  assert.strictEqual((await rpc('notifications/initialized', {}, { id: null })).status, 202);
  assert.deepStrictEqual((await rpc('ping', {})).body.result, {});
  assert.strictEqual((await rpc('nope/method', {})).body.error.code, -32601);

  // 17c. tools/list
  const tools = (await rpc('tools/list', {})).body.result.tools;
  assert.deepStrictEqual(tools.map((t) => t.name), ['get_format_guide', 'validate_pack', 'get_example_pack']);
  for (const t of tools) assert.strictEqual(t.inputSchema.type, 'object', `${t.name} needs an object input schema`);

  // 17d. get_format_guide returns the format guide, without app version, app URL or firmware claims
  const guide = (await rpc('tools/call', { name: 'get_format_guide', arguments: {} })).body.result.content[0].text;
  assert.ok(guide.startsWith('# EP-2350 format guide'));
  assert.ok(!/^Version /m.test(guide) && !guide.includes('Web app:') && !/firmware/i.test(guide));
  for (const fx of Object.keys(EFFECTS_REGISTRY)) assert.ok(guide.includes(`### ${fx}`), `Guide documents ${fx}`);

  // 17e. validate_pack: a valid official pack gets a share link on the Worker's own domain
  const dubText = fs.readFileSync(path.join(ROOT_DIR, 'packs/ep-2350_preset_pack-dub/config.json'), 'utf8');
  for (const config of [dubText, JSON.parse(dubText)]) {
    const r = (await rpc('tools/call', { name: 'validate_pack', arguments: { config } })).body.result;
    assert.ok(!r.isError);
    assert.ok(r.content[0].text.startsWith('VALID'), r.content[0].text);
    assert.strictEqual(r.structuredContent.isValid, true);
    assert.ok(r.structuredContent.shareUrl.startsWith(`${ORIGIN}/#`), r.structuredContent.shareUrl);
    const decoded = decodeHashPayload(r.structuredContent.shareUrl);
    assert.ok(decoded, 'The share link decodes in the web app');
    assert.strictEqual(decoded.pack.presets.length, 4, 'The share link carries the whole pack');
    assert.ok(!('config' in r.structuredContent), 'No echo of the config the assistant sent');
  }

  // 17f. validate_pack: errors carry the field and the fix; no link for an invalid pack
  const bad = await rpc('tools/call', {
    name: 'validate_pack',
    arguments: { config: { name: 'X', presets: [{ pos: 0, name: 'A', list: [{ effect: 'NOPE' }] }] } }
  });
  const badResult = bad.body.result;
  assert.strictEqual(badResult.structuredContent.isValid, false);
  assert.ok(badResult.structuredContent.errors.length > 0);
  assert.ok(badResult.content[0].text.startsWith('INVALID') && badResult.content[0].text.includes('fix:'));
  assert.ok(!('shareUrl' in badResult.structuredContent));
  const validate = async (config) => (await rpc('tools/call', { name: 'validate_pack', arguments: { config } })).body.result;
  const multi = await validate({
    name: 'T',
    presets: [
      {
        pos: 0,
        name: 'X',
        list: [{ effect: 'ECHO' }, { effect: 'LOWPASS', cutof: 50 }, { effect: 'REVERB' }, { effect: 'REVERB' }],
        handle: { row: 7, param: 'cutoff', depth: 0.5 }
      }
    ]
  });
  const multiText = multi.content[0].text;
  assert.ok(multiText.startsWith('INVALID: 4 errors'), multiText);
  assert.ok(multiText.includes('presets[0].list[1].cutof:') && multiText.includes('Did you mean "cutoff"?'));
  assert.ok(multiText.includes('presets[0].handle.row:') && !multiText.includes('Open in the web app'));
  // A value on the 0..100 scale is rejected in a config.json
  const percent = await validate({ name: 'T', presets: [{ pos: 0, name: 'X', list: [{ effect: 'DELAY', echo: 60 }, { effect: 'SAMPLE' }] }] });
  assert.strictEqual(percent.structuredContent.errors[0].path, 'presets[0].list[0].echo');
  // Issues are lean: code, path, message, fix (no type or presetPos; the list and the path say both)
  assert.deepStrictEqual(Object.keys(percent.structuredContent.errors[0]).sort(), ['code', 'fix', 'message', 'path']);
  // The summary covers only the presets that were sent, not the placeholder slots the pack is padded with
  const onePreset = await validate({ name: 'ONE', presets: [{ pos: 0, name: 'SOLO', list: [{ effect: 'LOWPASS', cutoff: 0.5 }, { effect: 'SAMPLE' }], trigger: { row: 1 } }] });
  assert.strictEqual(onePreset.structuredContent.isValid, true);
  const oneSummary = onePreset.structuredContent.summary.join('\n');
  assert.ok(oneSummary.includes('Preset 0 "SOLO"') && !/PRESET [234]|Preset [123] /.test(oneSummary), oneSummary);
  assert.ok(!onePreset.content[0].text.includes('PRESET 2'), 'Text result has no placeholder slots either');
  // A single preset is accepted and gets a #preset= link
  const single = await validate({ name: 'ROBOT', list: [{ effect: 'RING', frequency: 80, mix: 0.7 }, { effect: 'SAMPLE' }], trigger: { row: 1 } });
  assert.strictEqual(single.structuredContent.isValid, true, single.content[0].text);
  assert.ok(single.structuredContent.shareUrl.startsWith(`${ORIGIN}/#preset=`));
  const singleRow = decodeHashPayload(single.structuredContent.shareUrl).preset.list[0];
  assert.deepStrictEqual([singleRow.effect, singleRow.frequency, singleRow.mix], ['RING', 80, 70], 'The link opens the preset as sent (editor scale)');
  // Every official pack is valid
  for (const name of ['broken_radio', 'mysterious']) {
    const packText = fs.readFileSync(path.join(ROOT_DIR, `packs/ep-2350_preset_pack-${name}/config.json`), 'utf8');
    assert.strictEqual((await validate(packText)).structuredContent.isValid, true, `${name} must validate`);
  }
  const broken = (await rpc('tools/call', { name: 'validate_pack', arguments: { config: '{"name": ' } })).body.result;
  assert.ok(broken.content[0].text.startsWith('INVALID'), 'Broken JSON text is reported, not thrown');
  assert.strictEqual((await rpc('tools/call', { name: 'validate_pack', arguments: {} })).body.result.isError, true);

  // 17g. get_example_pack
  const ex = (await rpc('tools/call', { name: 'get_example_pack', arguments: { name: 'mysterious' } })).body.result;
  assert.strictEqual(JSON.parse(ex.content[0].text).presets.length, 4);
  assert.strictEqual((await rpc('tools/call', { name: 'get_example_pack', arguments: { name: 'x' } })).body.result.isError, true);
  assert.strictEqual((await rpc('tools/call', { name: 'nope', arguments: {} })).body.error.code, -32602);

  // 17h. transport: batches, parse errors, GET 405, CORS preflight, other paths go to static assets
  const batchRes = await worker.fetch(
    new Request(`${ORIGIN}/mcp/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ jsonrpc: '2.0', id: 'a', method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }])
    }),
    env
  );
  assert.deepStrictEqual(await batchRes.json(), [{ jsonrpc: '2.0', id: 'a', result: {} }]);
  const parseRes = await worker.fetch(new Request(`${ORIGIN}/mcp`, { method: 'POST', body: '{oops' }), env);
  assert.strictEqual(parseRes.status, 400);
  assert.strictEqual((await parseRes.json()).error.code, -32700);
  assert.strictEqual((await worker.fetch(new Request(`${ORIGIN}/mcp`), env)).status, 405);
  assert.strictEqual((await worker.fetch(new Request(`${ORIGIN}/mcp`, { method: 'OPTIONS' }), env)).status, 204);
  assert.strictEqual(await (await worker.fetch(new Request(`${ORIGIN}/assets/app.js`), env)).text(), 'asset');
  assert.deepStrictEqual(assetsHits, ['/assets/app.js'], 'Only non-/mcp paths reach the static assets');

  // 17i. EP2350_UI_URL overrides where share links point
  const pinned = await worker.fetch(
    new Request(`${ORIGIN}/mcp`, {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'validate_pack', arguments: { config: dubText } } })
    }),
    { ...env, EP2350_UI_URL: 'https://maksimverzakov.github.io/EP-2350-FX-Tool/' }
  );
  assert.ok((await pinned.json()).result.structuredContent.shareUrl.startsWith('https://maksimverzakov.github.io/EP-2350-FX-Tool/#'));

  // 17j. Hosting config: Worker runs only for /mcp; the bundle stays out of the public assets
  const wrangler = fs.readFileSync(path.join(ROOT_DIR, 'wrangler.jsonc'), 'utf8');
  assert.ok(wrangler.includes('"main": "dist/_worker.js"'));
  assert.ok(wrangler.includes('"run_worker_first": ["/mcp", "/mcp/*"]'));
  const { buildWorker } = await import(pathToFileURL(path.join(ROOT_DIR, 'scripts/build-worker.mjs')).href);
  const builtDir = path.join(mcpDir, 'dist');
  await buildWorker(builtDir);
  assert.ok(fs.existsSync(path.join(builtDir, '_worker.js')));
  assert.strictEqual(fs.readFileSync(path.join(builtDir, '.assetsignore'), 'utf8').trim(), '_worker.js');
  {
  // 17z. Logging: one JSON line per message with client, tool, verdict, issue codes and the submitted config
  const logged = async (method, params, opts) => {
    const before = mcpLogs.length;
    const res = await rpc(method, params, opts);
    return { res, entries: mcpLogs.slice(before) };
  };
  const { entries: initLogs } = await logged('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'openai-mcp', version: '1.0.0' } });
  assert.strictEqual(initLogs.length, 1);
  assert.deepStrictEqual(initLogs[0].client, { name: 'openai-mcp', version: '1.0.0' });
  assert.strictEqual(initLogs[0].protocolVersion, '2025-06-18');
  assert.strictEqual(initLogs[0].ok, true);
  assert.ok(!('ip' in initLogs[0]) && !JSON.stringify(initLogs[0]).includes('cf-connecting-ip'), 'No IP address is logged');

  const badPack = { name: 'X', presets: [{ pos: 0, name: 'A', list: [{ effect: 'EQUALISER', gain: 0.5 }, { effect: 'SAMPLE' }], trigger: { row: 1 } }] };
  const { entries: badLogs } = await logged('tools/call', { name: 'validate_pack', arguments: { config: badPack } });
  assert.strictEqual(badLogs.length, 1);
  const bad = badLogs[0];
  assert.strictEqual(bad.method, 'tools/call');
  assert.strictEqual(bad.tool, 'validate_pack');
  assert.strictEqual(bad.isValid, false);
  assert.ok(bad.errors.includes('unknown_param presets[0].list[0].gain'), JSON.stringify(bad.errors));
  assert.deepStrictEqual(JSON.parse(bad.config), badPack, 'The submitted config is logged as sent');
  assert.strictEqual(bad.status, 200);
  assert.ok(typeof bad.ms === 'number');

  const big = JSON.stringify({ name: 'BIG', presets: [], pad: 'x'.repeat(20000) });
  const { entries: bigLogs } = await logged('tools/call', { name: 'validate_pack', arguments: { config: big } });
  assert.strictEqual(bigLogs[0].configTruncated, true);
  assert.strictEqual(bigLogs[0].config.length, 8000);
  assert.strictEqual(bigLogs[0].configChars, big.length);

  const { entries: exLogs } = await logged('tools/call', { name: 'get_example_pack', arguments: { name: 'dub' } });
  assert.strictEqual(exLogs[0].example, 'dub');
  const { entries: errLogs } = await logged('nope/method', {});
  assert.strictEqual(errLogs[0].ok, false);
  assert.strictEqual(errLogs[0].rpcError.code, -32601);
  const { entries: noteLogs } = await logged('notifications/initialized', {}, { id: null });
  assert.strictEqual(noteLogs[0].status, 202);

  const parseErr = await worker.fetch(new Request(`${ORIGIN}/mcp`, { method: 'POST', headers: { 'cf-ray': 'abc123-AMS', 'user-agent': 'ua-test' }, body: '{oops' }), env);
  assert.strictEqual(parseErr.status, 400);
  const parseLog = mcpLogs[mcpLogs.length - 1];
  assert.deepStrictEqual([parseLog.method, parseLog.status, parseLog.rpcError.code, parseLog.ray, parseLog.userAgent], [null, 400, -32700, 'abc123-AMS', 'ua-test']);

  // Static assets are not logged
  const assetLogsBefore = mcpLogs.length;
  await worker.fetch(new Request(`${ORIGIN}/index.html`), env);
  assert.strictEqual(mcpLogs.length, assetLogsBefore);

  const wrangler = fs.readFileSync(path.join(ROOT_DIR, 'wrangler.jsonc'), 'utf8');
  assert.ok(/"observability":\s*\{\s*"enabled":\s*true/.test(wrangler), 'Workers Logs enabled');
  console.log = realConsoleLog;
  }
}
console.log('✓ Suite 17: Remote MCP server (Streamable HTTP) and Cloudflare Worker verified');

// ============================================================================
// SUITE 18: Design system: type scale and font roles
// ============================================================================
{
  const listTsx = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
      d.isDirectory() ? listTsx(path.join(dir, d.name)) : d.name.endsWith('.tsx') ? [path.join(dir, d.name)] : []
    );
  const tsxFiles = listTsx(path.join(ROOT_DIR, 'src'));

  // 18a. Only the four te-* sizes from tailwind.config.js (plus the 44px EP logo)
  const twConfig = fs.readFileSync(path.join(ROOT_DIR, 'tailwind.config.js'), 'utf8');
  for (const [name, px] of [['te-xs', '9px'], ['te-sm', '10.5px'], ['te-md', '12px'], ['te-lg', '14px']]) {
    assert.ok(twConfig.includes(`'${name}': '${px}'`), `tailwind.config.js must define ${name} = ${px}`);
  }
  for (const file of tsxFiles) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT_DIR, file);
    const arbitrary = (src.match(/\btext-\[\d+(?:\.\d+)?px\]/g) || []).filter((c) => c !== 'text-[44px]');
    assert.deepStrictEqual(arbitrary, [], `${rel} must use the text-te-* scale, found ${arbitrary.join(', ')}`);
    const stock = src.match(/(?<![\w-])text-(xs|sm|base|lg|[2-9]?xl)\b/g) || [];
    assert.deepStrictEqual(stock, [], `${rel} must use the text-te-* scale, found ${stock.join(', ')}`);
    // 18b. TechnoType Regular has no bold face: bold text must use the Medium or Bold face, not faux bold
    assert.ok(!/font-te-regular[^"`]*font-bold|font-bold[^"`]*font-te-regular/.test(src), `${rel} must not fake bold on TechnoType Regular`);
  }

  // 18c. Card and empty-state titles share one style
  const titleStyle = 'font-te-bold text-te-md uppercase tracking-tight';
  const ledgerSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/components/PresetLedger.tsx'), 'utf8');
  assert.ok(ledgerSrc.split(titleStyle).length - 1 >= 6, 'effect, modulation and empty-state titles must use the shared title style');
  assert.ok(fs.readFileSync(path.join(ROOT_DIR, 'src/components/McpPanel.tsx'), 'utf8').includes(titleStyle), 'MCP card titles must use the shared title style');

  // 18d. Only the web fonts that are used: IBM Plex Mono 400, 700 and 400 italic; no Inter
  const indexHtml = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
  assert.ok(!indexHtml.includes('family=Inter'), 'index.html must not load Inter');
  assert.ok(indexHtml.includes('IBM+Plex+Mono:ital,wght@0,400;0,700;1,400'), 'index.html must load only the used Plex Mono weights');
}
console.log('✓ Suite 18: Design system (type scale and font roles) verified');

// ============================================================================
// SUITE 19: Design system: colour tokens
// ============================================================================
{
  const tokensSrc = fs.readFileSync(path.join(ROOT_DIR, 'src/theme/tokens.ts'), 'utf8');
  const tokens = [...tokensSrc.matchAll(/^\s*'?([a-z-]+)'?: \{ ting: '(#[0-9a-f]{6})', fx: '(#[0-9a-f]{6})' \}/gm)].map((m) => ({ name: m[1], ting: m[2], fx: m[3] }));
  assert.ok(tokens.length >= 20, `expected the colour token table in tokens.ts, found ${tokens.length}`);

  // 19a. Teenage Engineering orange is the accent in both themes
  const accent = tokens.find((t) => t.name === 'accent');
  assert.ok(accent && accent.ting === '#f15a22' && accent.fx === '#f15a22', 'accent must be #f15a22 in both themes');

  // 19b. CSS variables (both themes) and Tailwind colours match tokens.ts
  const css = fs.readFileSync(path.join(ROOT_DIR, 'src/styles/te-theme.css'), 'utf8');
  const block = (selector) => {
    // the theme selector appears more than once; the token block is the one that defines --te-*
    for (let i = css.indexOf(selector + ' {'); i >= 0; i = css.indexOf(selector + ' {', i + 1)) {
      const body = css.slice(i, css.indexOf('}', i));
      if (body.includes('--te-')) return body;
    }
    assert.fail(`te-theme.css must have a ${selector} block with the --te-* tokens`);
  };
  const fxBlock = block(":root,\nhtml[data-theme='fx']");
  const tingBlock = block("html[data-theme='ting']");
  const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(' ');
  const twConfig = fs.readFileSync(path.join(ROOT_DIR, 'tailwind.config.js'), 'utf8');
  for (const t of tokens) {
    assert.ok(fxBlock.includes(`--te-${t.name}: ${channels(t.fx)};`), `FX theme must define --te-${t.name} as ${t.fx}`);
    assert.ok(tingBlock.includes(`--te-${t.name}: ${channels(t.ting)};`), `TING theme must define --te-${t.name} as ${t.ting}`);
    assert.ok(twConfig.includes(`'${t.name}': 'rgb(var(--te-${t.name}) / <alpha-value>)'`), `tailwind.config.js must map te-${t.name}`);
  }

  // 19c. UI components pick colours with tokens, not TING/FX ternaries over raw colours
  // (MicDevice is a drawing of the hardware and keeps its own illustration colours)
  const ternary = /isTing\s*\?\s*(['`])((?:(?!\1).)*?)\1\s*:\s*\1((?:(?!\1).)*?)\1/gs;
  for (const name of ['App.tsx', 'components/PresetLedger.tsx', 'components/TopBanner.tsx', 'components/McpPanel.tsx', 'components/DeviceConnector.tsx', 'components/AudioPlayerCompact.tsx', 'components/MultiTabBanner.tsx']) {
    const src = fs.readFileSync(path.join(ROOT_DIR, 'src', name), 'utf8');
    const colourTernaries = [...src.matchAll(ternary)].filter((m) => /#[0-9a-fA-F]{6}/.test(m[2] + m[3])).map((m) => m[0].replace(/\s+/g, ' ').slice(0, 80));
    assert.deepStrictEqual(colourTernaries, [], `${name} must use colour tokens instead of TING/FX ternaries`);
  }
}
console.log('✓ Suite 19: Design system (colour tokens) verified');

// ==========================================
// Suite 20: In-app messages and tooltips
// ==========================================
{
  const srcDir = path.join(ROOT_DIR, 'src');
  const files = [];
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((d) => {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) walk(full);
    else if (/\.(tsx?|jsx?)$/.test(d.name)) files.push(full);
  });
  walk(srcDir);

  // 20a. No blocking browser dialogs: messages go through the TE toast instead
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(!/(^|[^\w.])(window\.)?(alert|confirm|prompt)\s*\(/m.test(src), `${path.relative(ROOT_DIR, f)} must not call alert/confirm/prompt; use the in-app Toast`);
  }
  const app = fs.readFileSync(path.join(srcDir, 'App.tsx'), 'utf8');
  assert.ok(app.includes('<Toast toast={toast} onDismiss={dismissToast} />'), 'App must render the Toast');
  assert.strictEqual((app.match(/showToast\('error'/g) || []).length, 6, 'Connect, save, import and sample-load failures (not a WAV, cannot convert, no preview) must show an error toast');
  assert.strictEqual((app.match(/showToast\('success'/g) || []).length, 4, 'Import, copying an edited official pack on save/export, and converting a WAV for the mic must show a confirmation toast');
  const toast = fs.readFileSync(path.join(srcDir, 'components/Toast.tsx'), 'utf8');
  assert.ok(toast.includes("role={isError ? 'alert' : 'status'}"), 'Errors must be announced as alerts and confirmations as status');

  // 20b. Every icon-only button in an effect row has a tooltip and an accessible name
  const ledger = fs.readFileSync(path.join(srcDir, 'components/PresetLedger.tsx'), 'utf8');
  for (const icon of ['ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight', 'Trash2']) {
    const at = ledger.indexOf(`<${icon} className`);
    assert.ok(at > 0, `PresetLedger must render the ${icon} button`);
    const before = ledger.slice(Math.max(0, at - 900), at);
    const wrap = before.lastIndexOf('<Tooltip label=');
    assert.ok(wrap > before.lastIndexOf('</Tooltip>'), `The ${icon} button must be wrapped in a Tooltip`);
    assert.ok(before.slice(before.lastIndexOf('<button')).includes('aria-label='), `The ${icon} button must have an aria-label`);
  }
  assert.ok(ledger.includes("'SAMPLE stays on Bus 1'"), 'The disabled move-to-Bus-2 arrow must explain why');
}
console.log('✓ Suite 20: In-app messages and tooltips verified');

// ==========================================
// Suite 21: YOUR PACKS storage (localStorage)
// ==========================================
{
  const up = await import(pathToFileURL(path.join(TMP_TEST_BUILD, 'src/utils/userPacks.mjs')).href);
  const memStore = (init = {}) => {
    const data = { ...init };
    return { data, getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); } };
  };
  const official = OFFICIAL_TE_PACKS.map((o) => o.pack);
  const mine = { ...createEmptyPack(), name: 'MINE' };

  // 21a. add / dedupe / update / remove
  let { packs, id } = up.addUserPack([], mine);
  assert.strictEqual(packs.length, 1);
  const again = up.addUserPack(packs, { ...mine }, { dedupe: true });
  assert.strictEqual(again.id, id, 'An identical pack (e.g. the same link opened twice) must not be added twice');
  assert.strictEqual(again.packs.length, 1);
  assert.strictEqual(up.addUserPack(packs, { ...mine }).packs.length, 2, 'NEW PACK always adds');
  packs = up.updateUserPack(packs, id, { ...mine, name: 'RENAMED' });
  assert.strictEqual(packs[0].pack.name, 'RENAMED');
  assert.strictEqual(up.removeUserPack(packs, id).length, 0);

  // 21b. save / load round-trip, tolerant of junk
  const store = memStore();
  up.saveUserPacks(store, packs);
  const loaded = up.loadUserPacks(store);
  assert.strictEqual(loaded.length, 1);
  assert.strictEqual(loaded[0].id, id);
  assert.strictEqual(loaded[0].pack.name, 'RENAMED');
  assert.deepStrictEqual(up.loadUserPacks(memStore({ [up.USER_PACKS_KEY]: '{not json' })), []);
  assert.deepStrictEqual(up.loadUserPacks(memStore({ [up.USER_PACKS_KEY]: '[{"id":1}]' })), []);

  // 21c. selection round-trip
  up.saveSelection(store, { kind: 'user', id });
  assert.deepStrictEqual(up.loadSelection(store), { kind: 'user', id });
  up.saveSelection(store, { kind: 'official', id: 'dub' });
  assert.deepStrictEqual(up.loadSelection(store), { kind: 'official', id: 'dub' });
  assert.strictEqual(up.loadSelection(memStore({ [up.ACTIVE_PACK_KEY]: '{"kind":"evil"}' })), null);

  // 21d. migration of the legacy single saved pack
  const legacyStore = memStore({ [up.LEGACY_PACK_KEY]: serializeToConfigJson(mine) });
  const migrated = up.migrateLegacyPack(legacyStore, official);
  assert.ok(migrated.migratedId, 'An edited legacy pack becomes the first user pack');
  assert.strictEqual(migrated.packs[0].pack.name, 'MINE');
  const second = up.migrateLegacyPack(legacyStore, official);
  assert.strictEqual(second.migratedId, null, 'Migration runs once');
  assert.strictEqual(second.packs.length, 1);
  const untouched = up.migrateLegacyPack(memStore({ [up.LEGACY_PACK_KEY]: serializeToConfigJson(official[0]) }), official);
  assert.strictEqual(untouched.packs.length, 0, 'An untouched official pack is not copied into YOUR PACKS');

  // 21e. incoming packs (links / imports): identical → open, same name → ask, new → add
  const stored = up.addUserPack([], { ...createEmptyPack(), name: 'ROBOT VOICE' }).packs;
  assert.deepStrictEqual(up.planIncomingPack(stored, { ...stored[0].pack }), { action: 'open', id: stored[0].id });
  const fixed = { ...stored[0].pack, name: 'robot voice ', presets: stored[0].pack.presets.map((p, i) => (i === 0 ? { ...p, name: 'FIXED' } : p)) };
  const plan = up.planIncomingPack(stored, fixed);
  assert.strictEqual(plan.action, 'ask', 'Same name (case/space-insensitive) but different contents must ask');
  assert.strictEqual(plan.existingId, stored[0].id);
  assert.strictEqual(plan.copyName, 'ROBOT VOICE 2');
  assert.strictEqual(up.planIncomingPack(stored, { ...fixed, name: 'OTHER' }).action, 'add');
  const withCopy = up.addUserPack(stored, { ...fixed, name: 'ROBOT VOICE 2' }).packs;
  assert.strictEqual(up.uniqueCopyName(withCopy, 'ROBOT VOICE'), 'ROBOT VOICE 3');
  const longName = 'A'.repeat(24);
  const longCopy = up.uniqueCopyName(up.addUserPack([], { ...createEmptyPack(), name: longName }).packs, longName);
  assert.ok(longCopy.length <= 24 && longCopy.endsWith(' 2'), 'Copy names stay within the 24-character limit');
}
console.log('✓ Suite 21: YOUR PACKS storage (add, dedupe, persist, migrate, same-name conflicts) verified');

// -----------------------------------------------------------------------------
// SUITE 22: Firmware 1.0.9+ fields: optional filter Q and sample duck
// -----------------------------------------------------------------------------
{
  // 22a. Registry: Q is optional on LOWPASS/HIGHPASS and needs firmware 1.0.9
  for (const type of ['LOWPASS', 'HIGHPASS']) {
    const q = EFFECTS_REGISTRY[type].params.find((p) => p.name === 'Q');
    assert.ok(q, `${type} must define Q`);
    assert.strictEqual(q.optional, true, `${type}.Q must be optional`);
    assert.strictEqual(q.minFirmware, '1.0.9', `${type}.Q needs firmware 1.0.9`);
    assert.deepStrictEqual([q.min, q.max], [0, 1]);
  }
  assert.ok(
    Object.values(EFFECTS_REGISTRY).every((m) => m.params.filter((p) => p.optional).every((p) => p.name === 'Q')),
    'Only filter Q is optional for now'
  );

  // 22b. Round trip: Q and duck survive import/export; leaving them out writes nothing
  const cfg = {
    name: 'FW TEST',
    samples: [
      { pos: 0, file: '1.wav', playmode: 'oneshot', duck: 0.75 },
      { pos: 1, file: '2.wav', playmode: 'hold' }
    ],
    presets: [
      {
        pos: 0,
        name: 'Q',
        list: [
          { effect: 'LOWPASS', cutoff: 0.5, Q: 0.6 },
          { effect: 'HIGHPASS', cutoff: 0.2 },
          { effect: 'SAMPLE' }
        ]
      }
    ]
  };
  const parsedFw = parseConfigJson(JSON.stringify(cfg));
  assert.ok(!parsedFw.error, parsedFw.error);
  assert.strictEqual(parsedFw.pack.samples[0].duck, 0.75, 'duck must be imported');
  assert.strictEqual(parsedFw.pack.samples[1].duck, undefined, 'missing duck stays missing');
  const outFw = JSON.parse(serializeToConfigJson(parsedFw.pack));
  assert.strictEqual(outFw.samples[0].duck, 0.75, 'duck must be exported');
  assert.ok(!('duck' in outFw.samples[1]), 'duck is not written when unset');
  assert.strictEqual(outFw.presets[0].list[0].Q, 0.6, 'LOWPASS Q must be exported');
  assert.ok(!('Q' in outFw.presets[0].list[1]), 'Q is not written when unset');
  const clamped = parseConfigJson(JSON.stringify({ ...cfg, samples: [{ pos: 0, file: '1.wav', duck: 3 }] }));
  assert.strictEqual(clamped.pack.samples[0].duck, 1, 'imported duck is clamped to 0..1');

  // 22c. Validator: firmware warnings, duck checks, clearer number error
  const res = validatePresetInput({ configJson: JSON.stringify(cfg) });
  assert.strictEqual(res.isValid, true, JSON.stringify(res.errors));
  const fwPaths = res.warnings.filter((w) => w.code === 'needs_firmware').map((w) => w.path);
  assert.ok(fwPaths.includes('presets[0].list[0].Q'), 'Q gets a firmware warning');
  assert.ok(fwPaths.includes('samples[0].duck'), 'duck gets a firmware warning');
  const badDuck = validatePresetInput({
    configJson: JSON.stringify({ ...cfg, samples: [{ pos: 0, file: '1.wav', duck: 'yes' }, { pos: 1, file: '2.wav', duck: 1.5 }] })
  });
  assert.strictEqual(badDuck.isValid, false);
  assert.ok(badDuck.errors.some((e) => e.code === 'duck_not_number' && e.path === 'samples[0].duck'));
  assert.ok(badDuck.errors.some((e) => e.code === 'out_of_range' && e.path === 'samples[1].duck'));
  const badNum = validatePresetInput({
    configJson: JSON.stringify({ ...cfg, presets: [{ pos: 0, list: [{ effect: 'LOWPASS', cutoff: '0.5' }, { effect: 'SAMPLE' }] }] })
  });
  const numErr = badNum.errors.find((e) => e.code === 'param_not_number');
  assert.ok(numErr && /stops config\.json from loading/.test(numErr.message), 'number error explains the firmware consequence');

  // 22d. Engine: filter Q follows the row (and its default when unset)
  const fwEngine = new DspAudioEngine();
  await fwEngine.init();
  fwEngine.updatePreset({
    id: 'fw',
    pos: 0,
    list: [
      { id: 'a', effect: 'LOWPASS', cutoff: 0.5, Q: 0.6 },
      { id: 'b', effect: 'HIGHPASS', cutoff: 0.1 },
      { id: 'c', effect: 'SAMPLE' }
    ],
    handle: { row: 0, param: 'Q', depth: 30 }
  });
  fwEngine.updateModulation({ handlePos: 0 });
  await fwEngine.start();
  const [lp, hp] = fwEngine.activeNodes.filter((n) => n.effectType === 'LOWPASS' || n.effectType === 'HIGHPASS');
  assert.ok(Math.abs(lp.nodeRefs.filter.Q.value - 6) < 1e-6, 'LOWPASS Q 0.6 -> biquad Q 6');
  assert.ok(Math.abs(hp.nodeRefs.filter.Q.value - 2) < 1e-6, 'Unset Q keeps the previous fixed resonance (2.0)');
  fwEngine.updateModulation({ handlePos: 1 });
  assert.ok(Math.abs(lp.nodeRefs.filter.Q.value - 9) < 1e-6, 'The handle can modulate filter Q');

  // 22e. Engine: duck turns the mic down while the sample plays, and back up when it stops
  const duck = fwEngine.getDuckGain();
  assert.strictEqual(duck.gain.value, 1, 'Mic is not ducked at rest');
  await fwEngine.triggerSample(true, 'hold', 0.75);
  assert.ok(Math.abs(duck.gain.value - 0.25) < 1e-6, 'duck 0.75 leaves the mic at 25%');
  assert.ok(!duck.connections.includes(fwEngine.sampleSourceNode), 'The sample itself bypasses the duck');
  await fwEngine.triggerSample(false, 'hold');
  assert.strictEqual(duck.gain.value, 1, 'Releasing a hold sample restores the mic');
  await fwEngine.triggerSample(true, 'oneshot');
  assert.strictEqual(duck.gain.value, 1, 'A sample without duck leaves the mic alone');
  fwEngine.stop();

  // 22f. SAMPLE pitch is tape-style (confirmed on the device: it changes the sample's length)
  assert.strictEqual(samplePlaybackRate(1, 12), 2, '+12 st doubles the rate');
  assert.strictEqual(samplePlaybackRate(1, -12), 0.5, '-12 st halves the rate');
  assert.ok(Math.abs(samplePlaybackRate(1.5, 7) - 1.5 * Math.pow(2, 7 / 12)) < 1e-12, 'speed and pitch multiply');
  assert.strictEqual(samplePlaybackRate(4, 24), 16, 'rate is clamped at 16x');
  const tapeEngine = new DspAudioEngine();
  await tapeEngine.init();
  tapeEngine.updatePreset({ id: 't', pos: 0, list: [{ id: 's', effect: 'SAMPLE', speed: 1, pitch: 12 }], shake: { row: 0, param: 'pitch', depth: -12 } });
  await tapeEngine.triggerSample(true, 'hold');
  assert.strictEqual(tapeEngine.sampleSourceNode.playbackRate.value, 2, 'Triggered sample plays at speed x 2^(pitch/12)');
  tapeEngine.updateModulation({ shakeAmount: 1 });
  assert.strictEqual(tapeEngine.sampleSourceNode.playbackRate.value, 1, 'Modulating pitch changes the playback rate live');
  tapeEngine.stop();
}
console.log('✓ Suite 22: Firmware 1.0.9+ fields (optional filter Q, sample duck) and tape-style SAMPLE pitch verified');

// -----------------------------------------------------------------------------
// SUITE 23: Custom samples (WAV checks, slots, disk budget, zip export, engine slots)
// -----------------------------------------------------------------------------
{
  const S = samplesLib;
  /** A minimal WAV: `frames` of silence with the given format (formatTag 1 = PCM, 3 = float). */
  const makeWav = ({ channels = 1, rate = 44100, bits = 16, formatTag = 1, frames = 441, extraChunk = false } = {}) => {
    const dataLen = frames * channels * (bits / 8);
    const extra = extraChunk ? 8 + 5 + 1 : 0; // odd-sized LIST chunk with its pad byte
    const buf = new Uint8Array(44 + extra + dataLen);
    const v = new DataView(buf.buffer);
    const str = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); v.setUint32(4, buf.length - 8, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, formatTag, true); v.setUint16(22, channels, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * channels * (bits / 8), true);
    v.setUint16(32, channels * (bits / 8), true); v.setUint16(34, bits, true);
    let o = 36;
    if (extraChunk) { str(o, 'LIST'); v.setUint32(o + 4, 5, true); o += 8 + 5 + 1; }
    str(o, 'data'); v.setUint32(o + 4, dataLen, true);
    return buf;
  };

  // 23a. WAV inspection and the mic's limits
  const mono = S.inspectWav(makeWav({ frames: 44100 }));
  assert.deepStrictEqual(
    [mono.channels, mono.sampleRate, mono.bitsPerSample, mono.isFloat, mono.frames, mono.durationSec],
    [1, 44100, 16, false, 44100, 1]
  );
  assert.strictEqual(S.describeWav(mono), '44.1 kHz · 16-bit · mono · 1.00 s');
  assert.deepStrictEqual(S.wavDeviceIssues(mono), []);
  assert.strictEqual(S.inspectWav(makeWav({ extraChunk: true })).frames, 441, 'Chunks before data (odd size + pad) are skipped');
  for (const ok of [{ bits: 8 }, { bits: 24, channels: 2 }, { bits: 32, formatTag: 3, rate: 96000 }]) {
    assert.deepStrictEqual(S.wavDeviceIssues(S.inspectWav(makeWav(ok))), [], JSON.stringify(ok));
  }
  const bad = (opts) => S.wavDeviceIssues(S.inspectWav(makeWav(opts))).join(' ');
  assert.match(bad({ rate: 192000 }), /96 kHz/);
  assert.match(bad({ channels: 4 }), /mono or stereo/);
  assert.match(bad({ bits: 32 }), /8, 16 or 24-bit/, '32-bit integer PCM is not supported');
  assert.match(bad({ bits: 64, formatTag: 3 }), /32-bit float only/);
  assert.match(bad({ formatTag: 2 }), /Compressed WAV/);
  assert.match(bad({ frames: 0 }), /no audio/);
  assert.throws(() => S.inspectWav(new TextEncoder().encode('ID3 not a wav file')), /Not a WAV/);

  // 23a2. Auto-fix encoder: 16-bit PCM, mono/stereo kept, 3+ channels mixed to mono
  const tone = Float32Array.from({ length: 480 }, (_, i) => Math.sin(i / 10) * 0.5);
  const enc = S.inspectWav(S.encodeWav16([tone], 48000));
  assert.deepStrictEqual([enc.channels, enc.sampleRate, enc.bitsPerSample, enc.formatTag, enc.frames], [1, 48000, 16, 1, 480]);
  assert.deepStrictEqual(S.wavDeviceIssues(enc), [], 'Converted WAVs are always playable');
  assert.strictEqual(S.inspectWav(S.encodeWav16([tone, tone], 44100)).channels, 2, 'Stereo stays stereo');
  const quad = S.deviceChannels([tone, tone, tone, tone]);
  assert.strictEqual(quad.length, 1, '4 channels are mixed to mono');
  assert.ok(Math.abs(quad[0][7] - tone[7]) < 1e-6, 'Mixdown averages the channels');
  assert.strictEqual(S.deviceChannels([tone, tone]).length, 2);
  const clip = new DataView(S.encodeWav16([Float32Array.of(2, -2)], 8000).buffer);
  assert.deepStrictEqual([clip.getInt16(44, true), clip.getInt16(46, true)], [32767, -32768], 'Samples are clipped to 16-bit');

  // 23b. Disk-safe, unique file names
  assert.strictEqual(S.sanitizeSampleFileName('My Shout!.WAV'), 'my-shout.wav');
  assert.strictEqual(S.sanitizeSampleFileName('Café Ölé.wav'), 'cafe-ole.wav');
  assert.strictEqual(S.sanitizeSampleFileName('???.wav'), 'sample.wav');
  assert.strictEqual(S.sanitizeSampleFileName('horn.wav', ['HORN.wav', 'horn-2.wav']), 'horn-3.wav');
  assert.ok(S.sanitizeSampleFileName('x'.repeat(80) + '.wav').length <= 28);

  // 23c. Slots: a slot is custom only when samples lists it
  const base = createEmptyPack();
  assert.strictEqual(base.useBuiltInSamples, true);
  assert.deepStrictEqual(S.customSampleSlots(base), [], 'Factory packs have no custom slots');
  let p = S.assignSampleFile(base, 2, 'horn.wav');
  assert.strictEqual(p.useBuiltInSamples, false);
  assert.deepStrictEqual(S.customSampleSlots(p).map((s) => [s.pos, s.file, s.playmode]), [[2, 'horn.wav', 'oneshot']], 'The default slot list is dropped');
  p = S.updateSampleSlot(p, 2, { playmode: 'hold', duck: 0.5 });
  p = S.assignSampleFile(p, 0, 'kick.wav');
  p = S.assignSampleFile(p, 2, 'horn-2.wav');
  assert.deepStrictEqual(S.customSampleSlots(p).map((s) => [s.pos, s.file, s.playmode, s.duck]), [[0, 'kick.wav', 'oneshot', undefined], [2, 'horn-2.wav', 'hold', 0.5]], 'Replacing a file keeps playmode and duck');
  assert.strictEqual(S.updateSampleSlot(p, 1, { playmode: 'hold' }), p, 'Factory slots have no settings');
  const noDuck = S.updateSampleSlot(p, 2, { duck: undefined });
  assert.ok(!('duck' in S.customSampleAt(noDuck, 2)), 'duck: undefined removes duck');
  const exported = JSON.parse(serializeToConfigJson(p));
  assert.deepStrictEqual(exported.samples, [{ pos: 0, file: 'kick.wav', playmode: 'oneshot' }, { pos: 2, file: 'horn-2.wav', playmode: 'hold', duck: 0.5 }]);
  const reparsed = parseConfigJson(serializeToConfigJson(p)).pack;
  assert.deepStrictEqual(S.customSampleSlots(reparsed).map((s) => s.file), ['kick.wav', 'horn-2.wav'], 'Custom slots survive a round trip');
  p = S.clearSampleSlot(p, 0);
  assert.deepStrictEqual(S.customSampleSlots(p).map((s) => s.pos), [2]);
  p = S.clearSampleSlot(p, 2);
  assert.strictEqual(p.useBuiltInSamples, true, 'No custom slot left: back to factory sounds');
  assert.ok(!('samples' in JSON.parse(serializeToConfigJson(p))), 'Factory packs write no samples block');

  // 23c2. Names across packs: WAVs are stored by name, so a new one avoids other packs' files
  const packA = S.assignSampleFile(S.assignSampleFile(base, 0, 'horn.wav'), 1, 'kick.wav');
  const packB = S.assignSampleFile(base, 3, 'snare.wav');
  assert.deepStrictEqual([...S.referencedSampleFiles([packA, packB, base])].sort(), ['horn.wav', 'kick.wav', 'snare.wav']);
  assert.deepStrictEqual(S.referencedSampleFiles([{ ...packA, useBuiltInSamples: true }]).size, 0, 'Factory packs use no files');
  const taken = S.takenSampleNames(packB, 3, [packA]);
  assert.deepStrictEqual(taken.sort(), ['horn.wav', 'kick.wav'], "A slot's own file is free to reuse, other packs' are not");
  assert.strictEqual(S.sanitizeSampleFileName('Horn.wav', taken), 'horn-2.wav');
  assert.deepStrictEqual(S.takenSampleNames(packA, 0, []), ['kick.wav']);

  // 23d. Disk budget: config.json plus the WAVs the pack names
  const withTwo = S.assignSampleFile(S.assignSampleFile(base, 0, 'a.wav'), 1, 'b.wav');
  const u = S.diskUsage(withTwo, { 'a.wav': 600_000, 'unused.wav': 999_999 });
  assert.strictEqual(u.configBytes, new TextEncoder().encode(serializeToConfigJson(withTwo)).byteLength);
  assert.strictEqual(u.sampleBytes, 600_000, 'Only files the pack names count');
  assert.deepStrictEqual(u.missingFiles, ['b.wav']);
  assert.strictEqual(u.fits, true);
  assert.strictEqual(S.diskUsage(withTwo, { 'a.wav': 600_000, 'b.wav': 600_000 }).fits, false, 'Over 1 MB does not fit');
  assert.strictEqual(S.DISK_BUDGET_BYTES, 1048576);

  // 23e. Zip: stored entries a standard unzip can read
  assert.strictEqual(crc32(new TextEncoder().encode('123456789')), 0xcbf43926, 'CRC-32 check value');
  const wav = makeWav({ frames: 100 });
  const cfgBytes = new TextEncoder().encode('{"name":"Z"}');
  const zip = createZip([{ name: 'config.json', data: cfgBytes }, { name: 'a.wav', data: wav }], new Date(2026, 10, 18, 12, 30, 10));
  const zv = new DataView(zip.buffer);
  const eocd = zip.length - 22;
  assert.strictEqual(zv.getUint32(eocd, true), 0x06054b50);
  assert.strictEqual(zv.getUint16(eocd + 10, true), 2);
  let cd = zv.getUint32(eocd + 16, true);
  const read = [];
  for (let i = 0; i < 2; i++) {
    assert.strictEqual(zv.getUint32(cd, true), 0x02014b50);
    const nameLen = zv.getUint16(cd + 28, true);
    const name = new TextDecoder().decode(zip.subarray(cd + 46, cd + 46 + nameLen));
    const local = zv.getUint32(cd + 42, true);
    const size = zv.getUint32(cd + 24, true);
    assert.strictEqual(zv.getUint32(local, true), 0x04034b50);
    const dataStart = local + 30 + zv.getUint16(local + 26, true);
    const data = zip.subarray(dataStart, dataStart + size);
    assert.strictEqual(crc32(data), zv.getUint32(cd + 16, true));
    read.push([name, data]);
    cd += 46 + nameLen;
  }
  assert.deepStrictEqual(read.map(([n]) => n), ['config.json', 'a.wav']);
  assert.deepStrictEqual([...read[1][1]], [...wav], 'WAV bytes are stored unchanged');

  // 23f. Engine: a custom WAV plays from its slot, clearing it brings back the demo sound
  const smpEngine = new DspAudioEngine();
  await smpEngine.init();
  smpEngine.updatePreset({ id: 's', pos: 0, list: [{ id: 'x', effect: 'SAMPLE' }] });
  const customBuf = smpEngine.ctx.createBuffer(1, 10, 48000);
  smpEngine.setCustomSample(1, customBuf);
  assert.strictEqual(smpEngine.hasCustomSample(1), true);
  smpEngine.setActiveSampleSlot(1);
  await smpEngine.triggerSample(true, 'oneshot');
  assert.strictEqual(smpEngine.sampleSourceNode.buffer, customBuf, 'The slot plays the custom WAV');
  smpEngine.setCustomSample(1, null);
  assert.strictEqual(smpEngine.isSamplePlaying, false, 'Changing the playing slot stops it');
  await smpEngine.triggerSample(true, 'oneshot');
  assert.notStrictEqual(smpEngine.sampleSourceNode.buffer, customBuf, 'Cleared slot plays its demo sound again');
  smpEngine.stop();
}
console.log('✓ Suite 23: Custom samples (WAV checks, slots, disk budget, zip export, engine slots) verified');

console.log('\n=== ALL 23 PRODUCTION TEST SUITES PASSED (100%) ===');
