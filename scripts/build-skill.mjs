#!/usr/bin/env node
/**
 * Builds the EP-2350 sound designer skill, a folder any LLM agent can load:
 *
 *   <outDir>/ep2350-sound-designer/SKILL.md            instructions + effect reference
 *   <outDir>/ep2350-sound-designer/scripts/ep2350.mjs  dependency-free validator (Node 18+)
 *   <outDir>/ep2350-sound-designer/examples/*.json     official Teenage Engineering packs
 *   <outDir>/ep2350-sound-designer.zip                 the same folder, ready to install
 *
 * SKILL.md is rendered from EFFECTS_REGISTRY (src/skill/skillDoc.ts) and the validator is the
 * same code the web app's checks are built on, so neither can drift from the editor.
 * `npm run build` writes it to dist/skill/, which is published with the web app.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bundleTs } from './bundle-ts.mjs';
import { resolveAppVersion } from './app-version.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(__filename), '..');

export const SKILL_DIR_NAME = 'ep2350-sound-designer';
export const DEFAULT_APP_URL = 'https://maksimverzakov.github.io/EP-2350-FX-Tool';

const EXAMPLE_PACKS = {
  'broken_radio.json': 'packs/ep-2350_preset_pack-broken_radio/config.json',
  'dub.json': 'packs/ep-2350_preset_pack-dub/config.json',
  'mysterious.json': 'packs/ep-2350_preset_pack-mysterious/config.json'
};

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Minimal deflate zip writer (no dependency). Entries get a fixed timestamp so the same
 * sources always produce the same archive.
 */
export function createZip(entries) {
  const DOS_TIME = 0;
  const DOS_DATE = ((2025 - 1980) << 9) | (1 << 5) | 1;
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file, rw-r--r--
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

export async function buildSkill({
  outDir = path.join(ROOT_DIR, 'dist', 'skill'),
  appUrl = process.env.EP2350_UI_URL || DEFAULT_APP_URL,
  version = resolveAppVersion(ROOT_DIR)
} = {}) {
  const cleanAppUrl = appUrl.replace(/\/+$/, '');
  const skillDir = path.join(outDir, SKILL_DIR_NAME);
  fs.rmSync(skillDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(skillDir, 'examples'), { recursive: true });

  // SKILL.md: bundle the renderer (TypeScript, reads EFFECTS_REGISTRY) and run it.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ep2350-skill-'));
  try {
    const { outFile } = await bundleTs({
      rootDir: ROOT_DIR,
      entry: 'src/skill/skillDoc.ts',
      outFile: path.join(tmpDir, 'skill-doc.mjs'),
      version
    });
    const { renderSkillMarkdown } = await import(pathToFileURL(outFile).href);
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      renderSkillMarkdown({
        appUrl: cleanAppUrl,
        skillUrl: `${cleanAppUrl}/skill/${SKILL_DIR_NAME}`,
        version
      }),
      'utf8'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // Validator: one self-contained file.
  const cliPath = path.join(skillDir, 'scripts', 'ep2350.mjs');
  await bundleTs({
    rootDir: ROOT_DIR,
    entry: 'src/skill/cli.mjs',
    outFile: cliPath,
    version,
    define: { __EP2350_APP_URL__: cleanAppUrl }
  });
  fs.writeFileSync(cliPath, `#!/usr/bin/env node\n${fs.readFileSync(cliPath, 'utf8')}`, 'utf8');

  for (const [name, src] of Object.entries(EXAMPLE_PACKS)) {
    fs.copyFileSync(path.join(ROOT_DIR, src), path.join(skillDir, 'examples', name));
  }

  const files = ['SKILL.md', 'scripts/ep2350.mjs', ...Object.keys(EXAMPLE_PACKS).map((n) => `examples/${n}`)];
  const zipPath = path.join(outDir, `${SKILL_DIR_NAME}.zip`);
  fs.writeFileSync(
    zipPath,
    createZip(
      files.map((rel) => ({
        name: `${SKILL_DIR_NAME}/${rel}`,
        data: fs.readFileSync(path.join(skillDir, rel))
      }))
    )
  );

  return { skillDir, zipPath, files, version };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const { skillDir, zipPath } = await buildSkill();
  const rel = (p) => path.relative(ROOT_DIR, p);
  console.log(`✓ Built skill: ${rel(skillDir)}/ + ${rel(zipPath)}`);
}
