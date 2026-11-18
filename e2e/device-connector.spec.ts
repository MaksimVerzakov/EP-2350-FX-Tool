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
  const w = window as unknown as { __serialLog: string[]; __diskFreeBlocks?: number };
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
        } else if (text.includes('"__DSK_" + "START__"')) {
          // Disk as os.statvfs/os.listdir report it; TE's readme.pdf still on it
          const disk = { b: 4096, t: 250, f: w.__diskFreeBlocks ?? 200, files: [['readme.pdf', 520000], ['config.json', 1400]] };
          rc.enqueue(enc.encode(`\r\n>>> ${text}__DSK_START__${JSON.stringify(disk)}__DSK_END__\r\n>>> `));
        } else if (text.includes('"__LD_" + "OK__:"')) {
          rc.enqueue(enc.encode(`\r\n>>> ${text}__LD_OK__:True\r\n>>> `));
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
    const [saveBox, ejectBox] = [await save.boundingBox(), await eject.boundingBox()];
    expect(Math.abs(saveBox!.width - ejectBox!.width)).toBeLessThanOrEqual(1);
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

function makeWav(secs = 0.3): Buffer {
  const rate = 22050;
  const frames = Math.round(rate * secs);
  const b = Buffer.alloc(44 + frames * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + frames * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) b.writeInt16LE(Math.round(Math.sin(i / 8) * 9000), 44 + i * 2);
  return b;
}

test.describe('Sending samples to the mic', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(installMockSerial);
    await page.goto('/');
    await page.getByRole('button', { name: 'Connect the mic' }).click();
    await expect(page.getByPlaceholder('PACK NAME')).toHaveValue('TING HARDWARE PACK');
    await page.getByRole('button', { name: 'SAMPLES', exact: true }).click();
  });

  test('SAVE sends the WAVs, writes config.json and loads the slots without remounting', async ({ page }) => {
    await page.getByTestId('sample-file-0').setInputFiles({ name: 'Horn.wav', mimeType: 'audio/wav', buffer: makeWav() });
    await expect(page.getByTestId('sample-slot-0')).toHaveAttribute('data-state', 'custom');
    await page.getByRole('button', { name: 'Save to the mic' }).click();
    await expect(page.getByText('1 sample sent and loaded.')).toBeVisible();

    const log = await serialLog(page);
    const at = (needle: string) => log.findIndex((c) => c.includes(needle));
    const writes = log.filter((c) => c.startsWith('_w.write(binascii.a2b_base64('));
    expect(writes.length).toBeGreaterThan(1); // sent in chunks
    expect(at('"__DSK_" + "START__"')).toBeGreaterThanOrEqual(0); // space checked first
    expect(at('"__DSK_" + "START__"')).toBeLessThan(at('_w = open("/fat/horn.wav.part", "wb")'));
    expect(at('os.rename("/fat/horn.wav.part", "/fat/horn.wav")')).toBeGreaterThan(at('_w = open("/fat/horn.wav.part"'));
    expect(at('_f = open("/fat/config.json", "w")')).toBeGreaterThan(at('os.rename("/fat/horn.wav.part"'));
    expect(at('_ep_ld(0, "/fat/horn.wav", "oneshot", 0)')).toBeGreaterThan(at('_f = open("/fat/config.json", "w")'));
    for (const pos of [1, 2, 3]) expect(at(`spl.rom(${pos})`)).toBeGreaterThan(0);
    expect(log.some((c) => c.includes('examine_drive'))).toBe(false);
  });

  test('a mic without enough free space is refused before anything is written', async ({ page }) => {
    await page.evaluate(() => ((window as unknown as { __diskFreeBlocks: number }).__diskFreeBlocks = 2));
    await page.getByTestId('sample-file-0').setInputFiles({ name: 'big.wav', mimeType: 'audio/wav', buffer: makeWav(2) });
    await expect(page.getByTestId('sample-slot-0')).toHaveAttribute('data-state', 'custom');
    await page.getByRole('button', { name: 'Save to the mic' }).click();
    await expect(page.getByText('Not enough space on the mic').first()).toBeVisible();
    await expect(page.getByText(/readme\.pdf \(508 KB\)/).first()).toBeVisible();
    const log = await serialLog(page);
    expect(log.some((c) => c.includes('_w = open('))).toBe(false);
    expect(log.some((c) => c.includes('_f = open("/fat/config.json", "w")'))).toBe(false);
  });
});
