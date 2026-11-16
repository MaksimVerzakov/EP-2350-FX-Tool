import { validatePresetInput } from './presetTools';

/**
 * Text-in, text-out validation shared by the skill's validator CLI (src/skill/cli.mjs) and the
 * MCP server (src/mcp/mcpServer.ts), so both report problems the same way.
 */

interface Issue {
  path: string;
  message: string;
  fix: string;
}

/** Validate the text of a config.json pack or of a single preset ({ "name", "list": [...] }). */
export function validateText(text: string, appUrl: string): Record<string, any> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Let the pack validator report the JSON syntax error with its fix hint.
    return validatePresetInput({ configJson: text }, appUrl);
  }
  const isSinglePreset =
    !!parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    Array.isArray((parsed as Record<string, unknown>).list) &&
    !('presets' in (parsed as Record<string, unknown>));
  return isSinglePreset
    ? validatePresetInput({ preset: parsed }, appUrl)
    : validatePresetInput({ configJson: text }, appUrl);
}

function formatIssue(issue: Issue): string {
  return `  ${issue.path}: ${issue.message}\n    fix: ${issue.fix}`;
}

/** Plain-text report: verdict, errors and warnings with fixes, what each preset does, share link. */
export function formatResult(result: Record<string, any>): string {
  const lines: string[] = [];
  const errors: Issue[] = result.errors ?? [];
  const warnings: Issue[] = result.warnings ?? [];
  const summary: string[] = result.summary ?? [];
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  lines.push(
    result.isValid
      ? `VALID (${plural(warnings.length, 'warning')})`
      : `INVALID: ${plural(errors.length, 'error')}, ${plural(warnings.length, 'warning')}`
  );
  if (errors.length) lines.push('', 'Errors:', ...errors.map(formatIssue));
  if (warnings.length) lines.push('', 'Warnings:', ...warnings.map(formatIssue));
  if (summary.length) lines.push('', 'What it does:', ...summary.map((l) => `  ${l}`));
  if (result.isValid && result.shareUrl) lines.push('', 'Open in the web app:', `  ${result.shareUrl}`);
  return lines.join('\n');
}
