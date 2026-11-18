import { test, expect, type Page } from '@playwright/test';

/** Filter Q is optional (firmware 1.0.9+): it stays out of config.json until the user sets it. */

async function exportConfig(page: Page) {
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /^EXPORT$/i }).click();
  const download = await downloadPromise;
  const chunks: Buffer[] = [];
  for await (const chunk of await download.createReadStream()) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

test('filter Q is left out until set, written once set, and removed again by reset', async ({ page }) => {
  const preset = {
    pos: 0,
    name: 'FILTER Q',
    list: [{ effect: 'HIGHPASS', cutoff: 0.25 }, { effect: 'LOWPASS', cutoff: 0.6, Q: 0.6 }, { effect: 'SAMPLE' }]
  };
  await page.goto(`/#preset=${Buffer.from(JSON.stringify(preset)).toString('base64url')}`);
  await expect(page.getByPlaceholder('PRESET NAME')).toHaveValue('FILTER Q');

  const qKnobs = page.locator('div[title^="Q:"]');
  await expect(qKnobs).toHaveCount(2);
  const hpQ = qKnobs.nth(0);
  const lpQ = qKnobs.nth(1);

  // HIGHPASS has no Q: dimmed, showing the mic default; LOWPASS keeps the value from the link
  await expect(hpQ).toHaveAttribute('data-inactive', 'true');
  await expect(hpQ).toHaveAttribute('title', /not set.*firmware 1\.0\.9/);
  await expect(lpQ).not.toHaveAttribute('data-inactive', 'true');
  await expect(lpQ.locator('input[type="text"]')).toHaveValue('6.0');

  let cfg = await exportConfig(page);
  expect(cfg.presets[0].list[0]).not.toHaveProperty('Q');
  expect(cfg.presets[0].list[1].Q).toBe(0.6);

  // Setting the knob writes Q
  const hpInput = hpQ.locator('input[type="text"]');
  await hpInput.click();
  await hpInput.fill('5.0');
  await hpInput.press('Enter');
  await expect(hpQ).not.toHaveAttribute('data-inactive', 'true');
  cfg = await exportConfig(page);
  expect(cfg.presets[0].list[0].Q).toBe(0.5);

  // Double-click resets an optional knob by removing the value
  await hpQ.locator('.cursor-ns-resize').dblclick();
  await expect(hpQ).toHaveAttribute('data-inactive', 'true');
  cfg = await exportConfig(page);
  expect(cfg.presets[0].list[0]).not.toHaveProperty('Q');
});

test('a newly added LOWPASS does not write Q', async ({ page }) => {
  const preset = { pos: 0, name: 'ADD ROW', list: [{ effect: 'SAMPLE' }] };
  await page.goto(`/#preset=${Buffer.from(JSON.stringify(preset)).toString('base64url')}`);
  await expect(page.getByPlaceholder('PRESET NAME')).toHaveValue('ADD ROW');
  const before = await exportConfig(page);
  const rowsBefore = before.presets[0].list.length;
  await page.getByRole('button', { name: /ADD EFFECT/i }).first().click();
  await page.getByRole('button', { name: /LOWPASS/i }).first().click();
  const cfg = await exportConfig(page);
  const added = cfg.presets[0].list.find((r: any) => r.effect === 'LOWPASS');
  expect(cfg.presets[0].list.length).toBe(rowsBefore + 1);
  expect(added).toBeTruthy();
  expect(added).not.toHaveProperty('Q');
});
