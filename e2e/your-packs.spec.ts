import { test, expect, type Page } from '@playwright/test';

const yourPacks = (page: Page) => page.getByTestId('your-packs');
const openPackList = (page: Page) => page.getByLabel('Select default pack').click();
const storedPacks = (page: Page) => page.evaluate(() => localStorage.getItem('ep2350_user_packs') ?? '');
const newPackButton = (page: Page) => page.getByRole('button', { name: /START AN EMPTY/ });

const sharedPackJson = JSON.stringify({
  name: 'MCP SHARED PACK',
  presets: [
    { pos: 0, name: 'SHARED ONE', list: [{ effect: 'DELAY', time: 0.3, echo: 0.4 }, { effect: 'SAMPLE' }] },
    { pos: 1, name: 'SHARED TWO', list: [{ effect: 'REVERB', time: 0.6 }, { effect: 'SAMPLE' }] },
    { pos: 2, name: 'SHARED THREE', list: [{ effect: 'DIST', amount: 8, mix: 0.4 }, { effect: 'SAMPLE' }] },
    { pos: 3, name: 'SHARED FOUR', list: [{ effect: 'RING', frequency: 440, mix: 0.5 }, { effect: 'SAMPLE' }] }
  ]
});
const packHash = `#pack=${Buffer.from(sharedPackJson).toString('base64url')}`;

test.describe('YOUR PACKS', () => {
  test('NEW PACK adds packs that persist across reloads', async ({ page }) => {
    await page.goto('/');
    const packName = page.getByPlaceholder('PACK NAME');

    await openPackList(page);
    await expect(yourPacks(page)).toContainText('NO PACKS YET');
    await newPackButton(page).click();
    await packName.fill('FIRST MINE');

    await openPackList(page);
    await newPackButton(page).click();
    await packName.fill('SECOND MINE');

    await openPackList(page);
    await expect(yourPacks(page).getByRole('button', { name: 'FIRST MINE', exact: true })).toBeVisible();
    await expect(yourPacks(page).getByRole('button', { name: 'SECOND MINE', exact: true })).toBeVisible();

    await expect.poll(() => storedPacks(page)).toContain('SECOND MINE');
    await page.reload();
    await expect(packName).toHaveValue('SECOND MINE');
    await openPackList(page);
    await yourPacks(page).getByRole('button', { name: 'FIRST MINE', exact: true }).click();
    await expect(packName).toHaveValue('FIRST MINE');
  });

  test('a pack link lands in YOUR PACKS once, even after reloading', async ({ page }) => {
    await page.goto(`/${packHash}`);
    await expect(page.getByPlaceholder('PACK NAME')).toHaveValue('MCP SHARED PACK');
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('');
    await expect.poll(() => storedPacks(page)).toContain('MCP SHARED PACK');

    await page.reload();
    await page.goto(`/${packHash}`);
    await openPackList(page);
    await expect(yourPacks(page).getByRole('button', { name: 'MCP SHARED PACK', exact: true })).toHaveCount(1);
  });

  test('a preset link becomes its own pack named after the preset', async ({ page }) => {
    const preset = { pos: 2, name: 'LINKED PRESET', list: [{ effect: 'DELAY', time: 0.1 }, { effect: 'SAMPLE' }] };
    await page.goto(`/#preset=${Buffer.from(JSON.stringify(preset)).toString('base64url')}&slot=2`);
    await expect(page.getByPlaceholder('PACK NAME')).toHaveValue('LINKED PRESET');
    await expect(page.getByPlaceholder('PRESET NAME')).toHaveValue('LINKED PRESET');
    await openPackList(page);
    await expect(yourPacks(page).getByRole('button', { name: 'LINKED PRESET', exact: true })).toBeVisible();
  });

  test('edits to an official pack are not kept when switching packs', async ({ page }) => {
    await page.goto('/');
    const presetName = page.getByPlaceholder('PRESET NAME');
    const original = await presetName.inputValue();
    await presetName.fill('THROWAWAY EDIT');

    await openPackList(page);
    await page.getByRole('button', { name: /DUB PACK/ }).click();
    await openPackList(page);
    await page.getByRole('button', { name: /BROKEN RADIO PACK/ }).click();
    await expect(presetName).toHaveValue(original);
    await openPackList(page);
    await expect(yourPacks(page)).toContainText('NO PACKS YET');
  });

  test('exporting an edited official pack keeps a copy in YOUR PACKS', async ({ page }) => {
    await page.goto('/');
    await page.getByPlaceholder('PACK NAME').fill('MY RADIO');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: /^EXPORT$/i }).click();
    await download;

    await openPackList(page);
    await expect(yourPacks(page).getByRole('button', { name: 'MY RADIO', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /BROKEN RADIO PACK/ })).toBeVisible();
  });

  test('a pack can be deleted', async ({ page }) => {
    await page.goto('/');
    await openPackList(page);
    await newPackButton(page).click();
    await page.getByPlaceholder('PACK NAME').fill('DOOMED');

    await openPackList(page);
    await page.getByRole('button', { name: 'Delete DOOMED' }).click();
    await page.getByRole('button', { name: 'Confirm delete DOOMED' }).click();
    await expect(yourPacks(page)).toContainText('NO PACKS YET');
    await expect(page.getByPlaceholder('PACK NAME')).toHaveValue('BROKEN RADIO PACK');
  });

  test('the pack saved by an older version becomes the first of YOUR PACKS', async ({ page }) => {
    await page.addInitScript((cfg) => {
      if (!localStorage.getItem('ep2350_user_packs')) localStorage.setItem('ep2350_pack_config', cfg);
    }, sharedPackJson.replace('MCP SHARED PACK', 'OLD SAVED PACK'));
    await page.goto('/');
    await expect(page.getByPlaceholder('PACK NAME')).toHaveValue('OLD SAVED PACK');
    await openPackList(page);
    await expect(yourPacks(page).getByRole('button', { name: 'OLD SAVED PACK', exact: true })).toBeVisible();
  });
});
