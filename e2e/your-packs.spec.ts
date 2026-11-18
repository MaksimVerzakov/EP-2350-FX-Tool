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

  test('SHARE copies a link that opens the pack in a fresh browser', async ({ page, context, browser }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/');

    // Official packs can't be shared from here
    await expect(page.getByTestId('share-pack-button')).toHaveCount(0);

    await openPackList(page);
    await newPackButton(page).click();
    await page.getByPlaceholder('PACK NAME').fill('SHARE ME');
    await page.getByPlaceholder('PRESET NAME').fill('MY TAKE');

    await page.getByRole('button', { name: 'Share this pack' }).click();
    await expect(page.getByText('Link copied')).toBeVisible();
    const link = await page.evaluate(() => navigator.clipboard.readText());
    expect(link).toContain('/#pack=');

    const fresh = await browser.newContext();
    const other = await fresh.newPage();
    await other.goto(link);
    await expect(other.getByPlaceholder('PACK NAME')).toHaveValue('SHARE ME');
    await expect(other.getByPlaceholder('PRESET NAME')).toHaveValue('MY TAKE');
    await fresh.close();
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

  test.describe('same-name pack from a link', () => {
    const linkFor = (presetName: string) =>
      `/#pack=${Buffer.from(sharedPackJson.replace('SHARED ONE', presetName)).toString('base64url')}`;
    const dialog = (page: Page) => page.getByTestId('pack-conflict-dialog');

    test.beforeEach(async ({ page }) => {
      await page.goto(linkFor('BROKEN TAKE'));
      await expect(page.getByPlaceholder('PRESET NAME')).toHaveValue('BROKEN TAKE');
      await expect.poll(() => storedPacks(page)).toContain('BROKEN TAKE');
    });

    test('REPLACE swaps the stored pack for the new one', async ({ page }) => {
      await page.goto(linkFor('FIXED TAKE'));
      await expect(dialog(page)).toContainText('MCP SHARED PACK');
      await dialog(page).getByRole('button', { name: 'REPLACE' }).click();
      await expect(dialog(page)).toHaveCount(0);
      await expect(page.getByPlaceholder('PRESET NAME')).toHaveValue('FIXED TAKE');
      await openPackList(page);
      await expect(yourPacks(page).getByRole('button', { name: 'MCP SHARED PACK', exact: true })).toHaveCount(1);
      await expect.poll(() => storedPacks(page)).not.toContain('BROKEN TAKE');
    });

    test('SAVE AS COPY keeps both packs', async ({ page }) => {
      await page.goto(linkFor('FIXED TAKE'));
      await dialog(page).getByRole('button', { name: 'SAVE AS COPY' }).click();
      await expect(page.getByPlaceholder('PACK NAME')).toHaveValue('MCP SHARED PACK 2');
      await expect(page.getByPlaceholder('PRESET NAME')).toHaveValue('FIXED TAKE');
      await openPackList(page);
      await yourPacks(page).getByRole('button', { name: 'MCP SHARED PACK', exact: true }).click();
      await expect(page.getByPlaceholder('PRESET NAME')).toHaveValue('BROKEN TAKE');
    });

    test('CANCEL leaves YOUR PACKS untouched', async ({ page }) => {
      await page.goto(linkFor('FIXED TAKE'));
      await dialog(page).getByRole('button', { name: 'CANCEL' }).click();
      await expect(dialog(page)).toHaveCount(0);
      await expect.poll(() => storedPacks(page)).toContain('BROKEN TAKE');
      await expect.poll(() => storedPacks(page)).not.toContain('FIXED TAKE');
    });

    test('a re-sent preset link with the same name asks too', async ({ page }) => {
      const presetLink = (fx: string) =>
        `/#preset=${Buffer.from(JSON.stringify({ name: 'ROBOT', list: [{ effect: fx }, { effect: 'SAMPLE' }] })).toString('base64url')}`;
      await page.goto(presetLink('DELAY'));
      await expect(page.getByPlaceholder('PACK NAME')).toHaveValue('ROBOT');
      await expect.poll(() => storedPacks(page)).toContain('ROBOT');
      await page.goto(presetLink('REVERB'));
      await expect(dialog(page)).toContainText('ROBOT');
    });
  });
});
