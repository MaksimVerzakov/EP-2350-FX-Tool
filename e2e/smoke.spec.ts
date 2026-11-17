import { test, expect } from '@playwright/test';

test.describe('EP-2350 FX Tool Smoke Tests', () => {
  test('loads application and displays initial official pack', async ({ page }) => {
    await page.goto('/');

    // Check title and top banner branding
    await expect(page).toHaveTitle(/EP–2350 fx tool/i);
    await expect(page.getByText('EP', { exact: true })).toBeVisible();
    await expect(page.getByText('TOOL', { exact: true })).toBeVisible();

    // Default pack name should be BROKEN RADIO PACK
    const packInput = page.getByPlaceholder('PACK NAME');
    await expect(packInput).toHaveValue('BROKEN RADIO PACK');
  });

  test('can switch between official Teenage Engineering packs', async ({ page }) => {
    await page.goto('/');

    const packInput = page.getByPlaceholder('PACK NAME');
    const dropdownToggle = page.getByLabel('Select default pack');

    // Open dropdown
    await dropdownToggle.click();
    await expect(page.getByText('OFFICIAL TE PRESET PACKS')).toBeVisible();

    // Select DUB PACK
    await page.getByRole('button', { name: /DUB PACK/i }).click();
    await expect(packInput).toHaveValue('DUB PACK');

    // Preset 1 in DUB PACK should be SPACE ECHO
    await expect(page.getByPlaceholder('PRESET NAME')).toHaveValue('SPACE ECHO');

    // Switch to MYSTERIOUS PACK
    await dropdownToggle.click();
    await page.getByRole('button', { name: /MYSTERIOUS PACK/i }).click();
    await expect(packInput).toHaveValue('MYSTERIOUS PACK');

    // Preset 1 in MYSTERIOUS PACK should be MANUAL PITCHER
    await expect(page.getByPlaceholder('PRESET NAME')).toHaveValue('MANUAL PITCHER');

    // Start an empty pack via + NEW PACK
    await dropdownToggle.click();
    await page.getByRole('button', { name: /NEW PACK/i }).click();
    await expect(packInput).toHaveValue('NEW PACK');
    await expect(page.getByPlaceholder('PRESET NAME')).toHaveValue('PRESET 1');
  });

  test('can switch between FX and TING themes', async ({ page }) => {
    await page.goto('/');

    const tingButton = page.getByRole('button', { name: 'TING', exact: true });
    const fxButton = page.getByRole('button', { name: 'FX', exact: true });

    await tingButton.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'ting');

    await fxButton.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'fx');
  });

  test('exports valid config.json that matches official structure', async ({ page }) => {
    await page.goto('/');

    // Set up download listener
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: /^EXPORT$/i }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toBe('config.json');

    // Read exported json and verify structure
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const content = Buffer.concat(chunks).toString('utf8');
    const parsed = JSON.parse(content);

    expect(parsed).toHaveProperty('name', 'BROKEN RADIO PACK');
    expect(parsed).toHaveProperty('presets');
    expect(parsed.presets).toHaveLength(4);
    expect(parsed.presets[0]).toHaveProperty('pos', 0);
    expect(parsed.presets[0]).toHaveProperty('name', 'WALKIE TALKIE');
  });

  test('edits knob numeric inputs accurately (including 1% and clamping) and resets on double-click', async ({ page }) => {
    await page.goto('/');

    // In WALKIE TALKIE (Preset 1), DIST has WET MIX (default 50%)
    const mixKnobGroup = page.locator('div[title^="WET MIX:"]').first();
    const mixInput = mixKnobGroup.locator('input[type="text"]');
    await expect(mixInput).toHaveValue('50%');

    // Type 1 and press Enter -> must become 1% (not 100%)
    await mixInput.click();
    await mixInput.fill('1');
    await mixInput.press('Enter');
    await expect(mixInput).toHaveValue('1%');

    // Type 999 and press Enter -> must clamp to 100%
    await mixInput.click();
    await mixInput.fill('999');
    await mixInput.press('Enter');
    await expect(mixInput).toHaveValue('100%');

    // Double-click dial cap to reset to default (50%)
    const dialCap = mixKnobGroup.locator('.cursor-ns-resize');
    await dialCap.dblclick();
    await expect(mixInput).toHaveValue('50%');
  });

  test('switches between FX CHAIN and MCP views with matching block size and a live MCP endpoint', async ({ page, request }) => {
    await page.goto('/');

    const fxChainBtn = page.getByRole('button', { name: 'FX CHAIN' });
    const mcpBtn = page.getByRole('button', { name: 'MCP', exact: true });

    await expect(fxChainBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(mcpBtn).toHaveAttribute('aria-pressed', 'false');

    const ledgerBox = await page.locator('.te-ledger-card').first().boundingBox();
    expect(ledgerBox).not.toBeNull();
    const fxHeaderBox = await page.locator('.te-ledger-card').first().locator(':scope > div').first().boundingBox();
    expect(fxHeaderBox).not.toBeNull();

    await mcpBtn.click();
    await expect(mcpBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(fxChainBtn).toHaveAttribute('aria-pressed', 'false');

    const mcpPanel = page.getByTestId('mcp-panel');
    await expect(mcpPanel).toBeVisible();
    await expect(mcpPanel).toContainText('HOW IT WORKS');
    await expect(mcpPanel).toContainText('HOW TO CONNECT');

    // The header tab matches the FX board header exactly
    const mcpHeaderBox = await page.getByTestId('mcp-header').boundingBox();
    expect(Math.round(mcpHeaderBox!.height)).toBe(Math.round(fxHeaderBox!.height));

    const mcpBox = await mcpPanel.boundingBox();
    expect(mcpBox).not.toBeNull();
    expect(Math.round(mcpBox!.width)).toBe(Math.round(ledgerBox!.width));
    expect(Math.round(mcpBox!.height)).toBe(Math.round(ledgerBox!.height));

    // The panel shows this server's own /mcp, and that endpoint answers MCP
    const mcpUrl = (await mcpPanel.getByTestId('mcp-url').locator('code').textContent())!.trim();
    expect(mcpUrl).toMatch(/^http:\/\/[^/]+\/mcp$/);
    const initRes = await request.post(mcpUrl, {
      data: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }
    });
    expect(initRes.status()).toBe(200);
    expect((await initRes.json()).result.serverInfo.name).toBe('ep2350-sound-designer');

    // Switch back to FX CHAIN
    await fxChainBtn.click();
    await expect(mcpPanel).toHaveCount(0);
    await expect(page.getByPlaceholder('PRESET NAME')).toHaveValue('WALKIE TALKIE');
  });

  test('switches between BUS 1 and BUS 2 using the 3D bus switcher with FX counts underneath', async ({ page }) => {
    await page.goto('/');

    const busGroup = page.getByRole('group', { name: 'Bus selector' });
    const bus1Btn = busGroup.getByRole('button', { name: 'BUS 1', exact: true });
    const bus2Btn = busGroup.getByRole('button', { name: 'BUS 2', exact: true });
    await expect(bus1Btn).toHaveAttribute('aria-pressed', 'true');
    await expect(bus2Btn).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('[id^="effect-card-"].te-card-3d').first()).toBeVisible();

    await bus2Btn.click();
    await expect(bus2Btn).toHaveAttribute('aria-pressed', 'true');
    await expect(bus1Btn).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByText('NO EFFECTS IN BUS 2')).toBeVisible();
  });

  test('phone layout: top blocks joined at FX card width, connector last, stacked header, tall FX board, tabs docked on the card', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');

    // No version number in the banner
    await expect(page.getByText(/^V \d+\.\d+/)).toHaveCount(0);

    // Logo, Export/Import and connector blocks stretch to the FX card's width and stack joined in that
    // order: each face starts on the bottom border of the one above (1px shared border, no gap)
    const faces = await page.evaluate(() =>
      [
        document.querySelector('[aria-label="Theme selector"]')!.closest('.h-\\[76px\\]')!,
        document.querySelector('[aria-label="Export and Import actions"]')!.closest('.h-\\[76px\\]')!,
        document.querySelector('[data-testid="device-connector"] > div.border')!
      ].map((el) => {
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      })
    );
    const cardBox = await page.locator('.te-ledger-card').first().boundingBox();
    for (const f of faces) {
      expect(f.x).toBe(Math.round(cardBox!.x));
      expect(f.w).toBe(Math.round(cardBox!.width));
    }
    expect(faces[1].y).toBe(faces[0].y + faces[0].h - 1);
    expect(faces[2].y).toBe(faces[1].y + faces[1].h - 1);

    // Header: full-width preset selector with the notes field on its own row below
    const selector = await page.getByRole('group', { name: 'Preset selector' }).boundingBox();
    const notes = await page.getByPlaceholder('PRESET NOTES / COMMENT...').boundingBox();
    const card = await page.locator('.te-ledger-card').first().boundingBox();
    expect(selector!.width).toBeGreaterThan(card!.width - 40);
    expect(notes!.y).toBeGreaterThan(selector!.y + selector!.height);

    // The FX board grows with its effects instead of the fixed 626px desktop height
    expect(card!.height).toBeGreaterThan(900);

    // FX CHAIN / MCP switch is docked on the card: the pressed tab shares the card's top border
    // (1px overlap) and the card is stacked above it, so the tabs never draw over the header
    const fxTab = await page.getByRole('button', { name: 'FX CHAIN', exact: true }).boundingBox();
    expect(Math.round(fxTab!.y + fxTab!.height - card!.y)).toBe(1);
    const topAtTabFoot = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('.te-ledger-card') !== null, [fxTab!.x + 10, card!.y + 2]);
    expect(topAtTabFoot).toBe(true);
  });

  test('effect arrows show tooltips, and imports report through the in-app toast instead of alert()', async ({ page }) => {
    const dialogs: string[] = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });
    await page.goto('/');

    const later = page.getByRole('button', { name: 'Move later in signal path' }).first();
    await later.hover();
    const tip = page.getByRole('tooltip');
    await expect(tip).toHaveText('Move later in chain');
    const [tipBox, btnBox] = [await tip.boundingBox(), await later.boundingBox()];
    expect(tipBox!.y + tipBox!.height).toBeLessThanOrEqual(btnBox!.y);
    await page.mouse.move(0, 0);
    await expect(tip).toHaveCount(0);

    const input = page.locator('input[type="file"]');
    await input.setInputFiles({ name: 'config.json', mimeType: 'application/json', buffer: Buffer.from('{ not json') });
    const toast = page.getByTestId('toast');
    await expect(toast).toHaveAttribute('data-kind', 'error');
    await expect(toast).toContainText('IMPORT FAILED', { ignoreCase: true });
    await page.getByRole('button', { name: 'Close message' }).click();
    await expect(toast).toHaveCount(0);
    expect(dialogs).toEqual([]);
  });
});
