import { test, expect, type Page } from '@playwright/test';

/**
 * Fake EP-2350 Web Serial port speaking the same REPL protocol as the real mic
 * (config.json read, slot polling, chunked writes). Commands are logged on window.__serialLog.
 */
function installMockSerial() {
  const cfg = JSON.stringify({
    name: 'TING HARDWARE PACK',
    presets: [
      { pos: 0, name: 'HW DELAY', list: [{ effect: 'DELAY', time: 0.25, echo: 0.5 }, { effect: 'SAMPLE' }] },
      { pos: 1, name: 'HW REVERB', list: [{ effect: 'REVERB', time: 0.4 }, { effect: 'SAMPLE' }] },
      { pos: 2, name: 'HW DIST', list: [{ effect: 'DIST', amount: 12, mix: 0.5 }, { effect: 'SAMPLE' }] },
      { pos: 3, name: 'HW RING', list: [{ effect: 'RING', frequency: 220, mix: 0.8 }, { effect: 'SAMPLE' }] }
    ]
  });
  const w = window as unknown as { __serialLog: string[] };
  w.__serialLog = [];
  const makePort = () => {
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    let rc: ReadableStreamDefaultController<Uint8Array>;
    const readable = new ReadableStream<Uint8Array>({ start(c) { rc = c; } });
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        const text = dec.decode(chunk);
        w.__serialLog.push(text);
        if (text.includes('/fat/config.json') && text.includes('read()')) {
          rc.enqueue(enc.encode(`\r\n>>> ${text}__CFG_START__${cfg}__CFG_END__\r\n>>> `));
        } else if (text.includes('"__EP_" + "SLOT__:"')) {
          rc.enqueue(enc.encode(`\r\n>>> ${text}__EP_SLOT__:0:0\r\n>>> `));
        } else {
          rc.enqueue(enc.encode(`\r\n${text}>>> `));
        }
      }
    });
    return {
      readable,
      writable,
      getInfo: () => ({ usbVendorId: 0x2367, usbProductId: 0x0620 }),
      open: async () => {},
      close: async () => {}
    };
  };
  Object.defineProperty(navigator, 'serial', {
    configurable: true,
    value: {
      requestPort: async () => makePort(),
      getPorts: async () => [],
      addEventListener() {},
      removeEventListener() {}
    }
  });
}

const serialLog = (page: Page) =>
  page.evaluate(() => (window as unknown as { __serialLog: string[] }).__serialLog);

test.describe('Device connector block', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(installMockSerial);
    await page.goto('/');
  });

  test('shows a clickable "connect the mic" card while disconnected', async ({ page }) => {
    const card = page.getByRole('button', { name: 'Connect the mic' });
    await expect(card).toBeVisible();
    await expect(card).toBeEnabled();
    await expect(card).toHaveCSS('cursor', 'pointer');
    await expect(card).toContainText(/connect the mic/i);

    // The cable rests until hovered, then animates into the mic
    const cable = page.getByTestId('usb-cable');
    await expect(cable).toHaveAttribute('data-mode', 'out');
    await card.hover();
    await expect(cable).toHaveAttribute('data-mode', 'loop');
    await expect(page.getByRole('button', { name: 'Save to the mic' })).toHaveCount(0);

    // Device actions no longer live in the pack list
    await page.getByLabel('Select default pack').click();
    await expect(page.getByRole('button', { name: /CONNECT DEVICE/i })).toHaveCount(0);
  });

  test('connect → edit → save → eject', async ({ page }) => {
    await page.getByRole('button', { name: 'Connect the mic' }).click();

    // Splits into SAVE + EJECT and loads the mic's pack
    const save = page.getByRole('button', { name: 'Save to the mic' });
    const eject = page.getByRole('button', { name: 'Eject the mic' });
    await expect(save).toBeVisible();
    await expect(eject).toBeVisible();
    await expect(page.getByPlaceholder('PACK NAME')).toHaveValue('TING HARDWARE PACK');

    // The pack list still offers the mic's pack, without save/disconnect links
    await page.getByLabel('Select default pack').click();
    await expect(page.getByText('ON THE MIC')).toBeVisible();
    await expect(page.getByRole('button', { name: /TING HARDWARE PACK/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^SAVE$/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /DISCONNECT/ })).toHaveCount(0);
    await page.getByLabel('Select default pack').click();

    // SAVE is disabled until the current preset changes
    await expect(save).toBeDisabled();
    await page.getByPlaceholder('PRESET NAME').fill('MY NEW TAKE');
    await expect(save).toBeEnabled();

    // Saving writes config.json to the mic, shows a check, then disables SAVE again
    await save.click();
    await expect(page.getByTestId('saved-indicator')).toBeVisible();
    await expect(save).toBeDisabled();
    const log = await serialLog(page);
    expect(log.some((l) => l.includes('open("/fat/config.json", "w")'))).toBe(true);
    expect(log.some((l) => l.includes('_f.write') && l.includes('MY NEW TAKE'))).toBe(true);

    // Eject returns to the single connect card
    await eject.click();
    await expect(page.getByRole('button', { name: 'Connect the mic' })).toBeVisible();
  });

  test('a new pack from scratch can be saved to the mic', async ({ page }) => {
    await page.getByRole('button', { name: 'Connect the mic' }).click();
    await expect(page.getByRole('button', { name: 'Save to the mic' })).toBeVisible();

    await page.getByLabel('Select default pack').click();
    await page.getByRole('button', { name: /NEW PACK/i }).click();
    await expect(page.getByPlaceholder('PACK NAME')).toHaveValue('NEW PACK');
    const save = page.getByRole('button', { name: 'Save to the mic' });
    await expect(save).toBeEnabled();

    await save.click();
    await expect(page.getByTestId('saved-indicator')).toBeVisible();
    const log = await serialLog(page);
    expect(log.some((l) => l.includes('_f.write') && l.includes('NEW PACK'))).toBe(true);
  });

  test('a pack from a link stays in YOUR PACKS after the mic connects', async ({ page }) => {
    const shared = JSON.stringify({
      name: 'MCP SHARED PACK',
      presets: [{ pos: 0, name: 'SHARED ONE', list: [{ effect: 'DELAY', time: 0.3 }, { effect: 'SAMPLE' }] }]
    });
    await page.goto(`/#pack=${Buffer.from(shared).toString('base64url')}`);
    const packName = page.getByPlaceholder('PACK NAME');
    await expect(packName).toHaveValue('MCP SHARED PACK');

    // Connecting opens the mic's pack...
    await page.getByRole('button', { name: 'Connect the mic' }).click();
    await expect(packName).toHaveValue('TING HARDWARE PACK');

    // ...and the linked pack is still one click away, ready to save to the mic
    await page.getByLabel('Select default pack').click();
    await page.getByTestId('your-packs').getByRole('button', { name: 'MCP SHARED PACK', exact: true }).click();
    await expect(packName).toHaveValue('MCP SHARED PACK');
    const save = page.getByRole('button', { name: 'Save to the mic' });
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByTestId('saved-indicator')).toBeVisible();
    const log = await serialLog(page);
    expect(log.some((l) => l.includes('_f.write') && l.includes('MCP SHARED PACK'))).toBe(true);
  });

  test('saving an edited official pack to the mic keeps a copy in YOUR PACKS', async ({ page }) => {
    await page.getByRole('button', { name: 'Connect the mic' }).click();
    await expect(page.getByRole('button', { name: 'Save to the mic' })).toBeVisible();

    await page.getByLabel('Select default pack').click();
    await page.getByRole('button', { name: /DUB PACK/ }).click();
    await page.getByPlaceholder('PACK NAME').fill('MY DUB');
    await page.getByRole('button', { name: 'Save to the mic' }).click();
    await expect(page.getByTestId('saved-indicator')).toBeVisible();

    await page.getByLabel('Select default pack').click();
    await expect(page.getByTestId('your-packs').getByRole('button', { name: 'MY DUB', exact: true })).toBeVisible();
  });
});
