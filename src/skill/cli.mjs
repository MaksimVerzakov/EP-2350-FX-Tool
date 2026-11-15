/**
 * EP-2350 preset validator CLI, shipped inside the sound designer skill as scripts/ep2350.mjs
 * (bundled into one dependency-free file by scripts/build-skill.mjs). Needs Node.js 18+.
 *
 *   node ep2350.mjs validate <config.json | preset.json | -> [--out <file>] [--json] [--app-url <url>]
 *
 * Exit code: 0 valid, 1 invalid, 2 usage or I/O error.
 */
import fs from 'node:fs';
import { SHARE_APP_URL, TOOLS_VERSION as VERSION, validatePresetInput } from './presetTools';

const USAGE = `EP-2350 preset validator ${VERSION}

Usage:
  node ep2350.mjs validate <file | ->  [--out <file>] [--json] [--app-url <url>]

  <file>      config.json (a pack: { "name", "presets": [...] }) or a single preset
              ({ "name", "list": [...] }). Use - to read from stdin.
  --out       Write the normalized config.json here when there are no errors.
  --json      Print the full result as JSON instead of text.
  --app-url   Base URL for the share link (default ${SHARE_APP_URL}).
`;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--out' || arg === '--app-url') {
      const value = argv[++i];
      if (value === undefined) fail(`${arg} needs a value.\n\n${USAGE}`);
      opts[arg === '--out' ? 'out' : 'appUrl'] = value;
    } else if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg === '--version') opts.version = true;
    else if (arg.startsWith('--')) fail(`Unknown option ${arg}.\n\n${USAGE}`);
    else opts.positional.push(arg);
  }
  return opts;
}

/** Validate the text of a config.json pack or of a single preset. */
export function validateText(text, appUrl = SHARE_APP_URL) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Let the pack validator report the JSON syntax error with its fix hint.
    return validatePresetInput({ configJson: text }, appUrl);
  }
  const isSinglePreset =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.list) && !('presets' in parsed);
  return isSinglePreset
    ? validatePresetInput({ preset: parsed }, appUrl)
    : validatePresetInput({ configJson: text }, appUrl);
}

function formatIssue(issue) {
  return `  ${issue.path}: ${issue.message}\n    fix: ${issue.fix}`;
}

export function formatResult(result) {
  const lines = [];
  const { errors = [], warnings = [], summary = [] } = result;
  lines.push(
    result.isValid
      ? `VALID (${warnings.length} warning${warnings.length === 1 ? '' : 's'})`
      : `INVALID: ${errors.length} error${errors.length === 1 ? '' : 's'}, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`
  );
  if (errors.length) lines.push('', 'Errors:', ...errors.map(formatIssue));
  if (warnings.length) lines.push('', 'Warnings:', ...warnings.map(formatIssue));
  if (summary.length) lines.push('', 'What it does:', ...summary.map((l) => `  ${l}`));
  if (result.isValid && result.shareUrl) lines.push('', 'Open in the web app:', `  ${result.shareUrl}`);
  return lines.join('\n');
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.version) return process.stdout.write(`${VERSION}\n`);
  const [command, file] = opts.positional;
  if (opts.help || !command) return process.stdout.write(USAGE);
  if (command !== 'validate') fail(`Unknown command "${command}".\n\n${USAGE}`);
  if (!file) fail(`validate needs a file (or - for stdin).\n\n${USAGE}`);

  let text;
  try {
    text = fs.readFileSync(file === '-' ? 0 : file, 'utf8');
  } catch (err) {
    fail(`Cannot read ${file}: ${err.message}`);
  }

  const appUrl = (opts.appUrl || SHARE_APP_URL).replace(/\/+$/, '');
  const result = validateText(text, appUrl);

  let written;
  if (opts.out && result.isValid) {
    // A single preset is written as a pack holding it in its slot, so the file can go straight
    // onto the mic.
    const config =
      result.normalizedConfigJson ??
      validatePresetInput(
        { configJson: JSON.stringify({ name: 'AI FX PACK', presets: [result.normalizedPresetJson] }) },
        appUrl
      ).normalizedConfigJson;
    try {
      fs.writeFileSync(opts.out, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
      written = opts.out;
    } catch (err) {
      fail(`Cannot write ${opts.out}: ${err.message}`);
    }
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ...result, ...(written ? { writtenPath: written } : {}) }, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatResult(result)}\n`);
    if (written) process.stdout.write(`\nWrote ${written}\n`);
    else if (opts.out) process.stdout.write(`\nNothing written to ${opts.out}: fix the errors first.\n`);
  }
  process.exitCode = result.isValid ? 0 : 1;
}

main(process.argv.slice(2));
