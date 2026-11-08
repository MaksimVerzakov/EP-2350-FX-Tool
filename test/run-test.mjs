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

    // Handle static asset imports (e.g. speech.mp3 in AudioEngine.ts)
    source = source.replace(
      /import\s+([a-zA-Z0-9_]+)\s+from\s+['"]([^'"]+\.mp3)['"];?/g,
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
const { EFFECTS_REGISTRY, isPercentParam, getModDepthConfig } = await import(
  pathToFileURL(path.join(TMP_TEST_BUILD, 'src/constants/effectsRegistry.mjs')).href
);
const { OFFICIAL_TE_PACKS } = await import(
  pathToFileURL(path.join(TMP_TEST_BUILD, 'src/constants/defaultPresets.mjs')).href
);
const { parseConfigJson } = await import(
  pathToFileURL(path.join(TMP_TEST_BUILD, 'src/utils/parser.mjs')).href
);
const { serializeToConfigJson, validatePackConfig } = await import(
  pathToFileURL(path.join(TMP_TEST_BUILD, 'src/utils/serializer.mjs')).href
);
const {
  PitchShiftKernel,
  computeLfoWave,
  cutoffToHz,
  hann,
  makeDistortionCurve,
  makeSoftClipCurve,
  resolveModDepth
} = await import(
  pathToFileURL(path.join(TMP_TEST_BUILD, 'src/dsp/math.mjs')).href
);
const { DspAudioEngine } = await import(
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

const delayTimeParam = EFFECTS_REGISTRY.DELAY.params.find((p) => p.name === 'time');
assert.strictEqual(delayTimeParam.max, 1.2, 'DELAY.time max must be 1.2s');

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
console.log('✓ Suite 3: Validator constraints & out-of-bounds modulation checks verified');

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
  ',"presets":[{"pos":0,"list":[{"effect":"DIST","mix":0.5,"__proto__":{"polluted":true},"constructor":{"bad":1},"nested":{"drop":true}}],"handle":{"target":"lfo"}}]}';
const secParsed = parseConfigJson(pollutedRaw);
assert.strictEqual(secParsed.error, undefined);
assert.strictEqual(({}).polluted, undefined, 'Object.prototype must not be polluted');
assert.strictEqual(secParsed.pack.samples.length, 64, 'Samples array must be capped at 64 items');
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
console.log('✓ Suite 5: Pure DSP Math functions verified (cutoff, resolveModDepth, LFO shapes, waveshapers)');

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
console.log(
  `✓ Suite 6: PitchShiftKernel verified (220Hz -> 0.5x=${hzHalf.toFixed(1)}Hz, 2.0x=${hz2x.toFixed(1)}Hz at constant speed)`
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
    { ...testPreset.list[5], speed: 1.75, level: 90 }
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

// Verify Handle & Shake modulation on DIST.amount and RING.mix
engine.updateModulation({ handlePos: 1.0, shakeAmount: 0.5 });
assert.strictEqual(distNode.nodeRefs.lastAmount, 40, 'Handle modulation on DIST.amount must clamp at 40x');
assert.strictEqual(ringNode.nodeRefs.wetGain.gain.value, 1.0, 'Shake modulation on RING.mix (75% + 25%) must reach 1.0');

// 8c. Async start() / stop() race protection
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

console.log('✓ Suite 8: DspAudioEngine graph routing, live modulations, safety limiter & async race protection verified');

console.log('\n=== ALL 8 PRODUCTION TEST SUITES PASSED (100%) ===');
