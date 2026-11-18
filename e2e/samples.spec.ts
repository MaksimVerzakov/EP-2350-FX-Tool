import { test, expect, type Page } from '@playwright/test';

/** A mono/stereo 16-bit PCM WAV with a short decaying tone. */
function makeWav({ rate = 44100, channels = 1, secs = 0.5 } = {}): Buffer {
  const frames = Math.round(rate * secs);
  const dataLen = frames * channels * 2;
  const b = Buffer.alloc(44 + dataLen);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + dataLen, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * channels * 2, 28);
  b.writeUInt16LE(channels * 2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < frames; i++) {
    const s = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000 * (1 - i / frames));
    for (let c = 0; c < channels; c++) b.writeInt16LE(s, 44 + (i * channels + c) * 2);
  }
  return b;
}

/** Read a stored (uncompressed) zip into { name: bytes }. */
function readZip(zip: Buffer): Record<string, Buffer> {
  const eocd = zip.length - 22;
  expect(zip.readUInt32LE(eocd)).toBe(0x06054b50);
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const files: Record<string, Buffer> = {};
  for (let i = 0; i < count; i++) {
    const nameLen = zip.readUInt16LE(p + 28);
    const size = zip.readUInt32LE(p + 24);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    files[name] = zip.subarray(start, start + size);
    p += 46 + nameLen;
  }
  return files;
}

async function exportDownload(page: Page) {
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /^EXPORT$/i }).click();
  const download = await downloadPromise;
  const chunks: Buffer[] = [];
  for await (const chunk of await download.createReadStream()) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return { name: download.suggestedFilename(), bytes: Buffer.concat(chunks) };
}

async function openSamples(page: Page) {
  await page.goto('/');
  await page.getByLabel('Select default pack').click();
  await page.getByRole('button', { name: /START AN EMPTY/ }).click();
  await page.getByRole('button', { name: 'SAMPLES', exact: true }).click();
  await expect(page.getByTestId('samples-panel')).toBeVisible();
}

test('SAMPLES tab matches the FX board size, with a DISK strip like the bus selector', async ({ page }) => {
  await page.goto('/');
  const ledger = await page.locator('.te-ledger-card').first().boundingBox();
  const busStrip = await page.getByRole('group', { name: 'Bus selector' }).locator('..').boundingBox();
  await page.getByRole('button', { name: 'SAMPLES', exact: true }).click();
  await expect(page.getByRole('button', { name: 'SAMPLES', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const panel = await page.getByTestId('samples-panel').boundingBox();
  expect(Math.round(panel!.width)).toBe(Math.round(ledger!.width));
  expect(Math.round(panel!.height)).toBe(Math.round(ledger!.height));
  const disk = await page.getByTestId('sample-disk').boundingBox();
  expect(Math.round(disk!.height)).toBe(Math.round(busStrip!.height));
  const meter = page.getByRole('meter', { name: 'Disk space used' });
  await expect(meter.locator(':scope > div')).toHaveCount(2);
  await expect(meter.locator(':scope > div').first().locator('span')).toHaveCount(12);
  await expect(meter).toHaveAttribute('data-lit', '1'); // config.json alone lights the first LED
  await expect(page.getByTestId('sample-disk-total')).toContainText('/ 1 MB');

  for (let pos = 0; pos < 4; pos++) {
    const slot = page.getByTestId(`sample-slot-${pos}`);
    await expect(slot).toHaveAttribute('data-state', 'factory');
    await expect(slot.getByTestId('sample-name')).toHaveText('Factory sound');
    // Factory sounds take no settings: playmode and duck are shown but disabled
    await expect(slot.getByRole('button', { name: 'Next playmode' })).toBeDisabled();
    await expect(slot.locator('div[title^="DUCK MIC:"]')).toHaveAttribute('aria-disabled', 'true');
    await expect(slot.getByRole('button', { name: 'FACTORY', exact: true })).toHaveCount(0);
  }
});

test('a loaded WAV gets its slot, settings and a place in the exported zip', async ({ page }) => {
  await openSamples(page);
  const wav = makeWav({ channels: 2, secs: 0.6 });
  const slot = page.getByTestId('sample-slot-0');
  const loadBtn = slot.getByRole('button', { name: 'LOAD WAV' });
  const playBtn = slot.getByRole('button', { name: 'Play slot 1' });
  const before = [await loadBtn.boundingBox(), await playBtn.boundingBox()];

  await page.getByTestId('sample-file-0').setInputFiles({ name: 'Big Horn!.WAV', mimeType: 'audio/wav', buffer: wav });
  await expect(slot).toHaveAttribute('data-state', 'custom');
  await expect(slot.getByTestId('sample-name')).toHaveText('big-horn.wav');
  await expect(slot.getByTestId('sample-size')).toHaveText('103 KB');
  await expect(page.getByRole('meter', { name: 'Disk space used' })).toHaveAttribute('data-lit', '2');

  // FACTORY appears in the free space; LOAD WAV (same label) and PLAY stay where they were
  await expect(slot.getByRole('button', { name: 'FACTORY', exact: true })).toBeVisible();
  await expect(loadBtn).toHaveText(/LOAD WAV/);
  const after = [await loadBtn.boundingBox(), await playBtn.boundingBox()];
  for (let i = 0; i < 2; i++) {
    expect(Math.round(after[i]!.x)).toBe(Math.round(before[i]!.x));
    expect(Math.round(after[i]!.y)).toBe(Math.round(before[i]!.y));
  }

  await expect(slot.getByTestId('sample-playmode')).toHaveText('ONESHOT');
  await slot.getByRole('button', { name: 'Next playmode' }).click();
  await expect(slot.getByTestId('sample-playmode')).toHaveText('HOLD');
  await slot.getByRole('button', { name: 'Previous playmode' }).click();
  await slot.getByRole('button', { name: 'Previous playmode' }).click();
  await expect(slot.getByTestId('sample-playmode')).toHaveText('START/STOP');
  await slot.getByRole('button', { name: 'Next playmode' }).click();
  await slot.getByRole('button', { name: 'Next playmode' }).click();
  await expect(slot.getByTestId('sample-playmode')).toHaveText('HOLD');

  const duck = slot.locator('div[title^="DUCK MIC:"]');
  await expect(duck).toHaveAttribute('data-inactive', 'true');
  const duckInput = duck.locator('input[type="text"]');
  await duckInput.click();
  await duckInput.fill('50%');
  await duckInput.press('Enter');
  await expect(duck).not.toHaveAttribute('data-inactive', 'true');

  // Pressing PLAY selects the slot and plays it without errors
  await slot.getByRole('button', { name: 'Play slot 1' }).click();

  const zipped = await exportDownload(page);
  expect(zipped.name).toMatch(/\.zip$/);
  const files = readZip(zipped.bytes);
  expect(Object.keys(files).sort()).toEqual(['big-horn.wav', 'config.json']);
  expect(files['big-horn.wav'].equals(wav)).toBe(true);
  const cfg = JSON.parse(files['config.json'].toString('utf8'));
  expect(cfg.samples).toEqual([{ pos: 0, file: 'big-horn.wav', playmode: 'hold', duck: 0.5 }]);

  // Back to the factory sound: plain config.json without a samples block
  await slot.getByRole('button', { name: 'FACTORY', exact: true }).click();
  await expect(slot).toHaveAttribute('data-state', 'factory');
  const plain = await exportDownload(page);
  expect(plain.name).toBe('config.json');
  expect(JSON.parse(plain.bytes.toString('utf8'))).not.toHaveProperty('samples');
});

test('non-WAV files are refused; WAVs the mic cannot play are converted automatically', async ({ page }) => {
  await openSamples(page);
  await page.getByTestId('sample-file-1').setInputFiles({ name: 'song.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('ID3 not a wav') });
  await expect(page.getByText('Not a WAV file').first()).toBeVisible();
  await expect(page.getByTestId('sample-slot-1')).toHaveAttribute('data-state', 'factory');

  // 192 kHz is over the mic's 96 kHz: it is re-saved as 16-bit PCM at the browser's rate, with no warning
  await page.getByTestId('sample-file-2').setInputFiles({ name: 'hires.wav', mimeType: 'audio/wav', buffer: makeWav({ rate: 192000, secs: 0.2 }) });
  const slot = page.getByTestId('sample-slot-2');
  await expect(slot).toHaveAttribute('data-state', 'custom');
  await expect(page.getByText('Converted for the mic').first()).toBeVisible();
  await expect(slot.getByRole('alert')).toHaveCount(0);
  const zipped = await exportDownload(page);
  const wav = readZip(zipped.bytes)['hires.wav'];
  const rate = wav.readUInt32LE(24);
  expect(rate).toBeLessThanOrEqual(96000);
  expect([wav.readUInt16LE(20), wav.readUInt16LE(22), wav.readUInt16LE(34)]).toEqual([1, 1, 16]);
  expect(wav.readUInt32LE(40) / 2 / rate).toBeCloseTo(0.2, 2); // same length
});

test('the DISK LED screen is centred in its strip on desktop and phone', async ({ page }) => {
  for (const viewport of [{ width: 1280, height: 900 }, { width: 375, height: 812 }]) {
    await page.setViewportSize(viewport);
    await openSamples(page);
    if (viewport.width < 400) {
      // Labels of different widths must not push the screen off centre
      // A long size label (about 1 MB used) must not push the screen off centre either
      await page.getByTestId('sample-file-0').setInputFiles({ name: 'a.wav', mimeType: 'audio/wav', buffer: makeWav({ channels: 2, secs: 5.8 }) });
      await expect(page.getByTestId('sample-slot-0')).toHaveAttribute('data-state', 'custom');
    }
    const strip = await page.getByTestId('sample-disk').boundingBox();
    const meter = await page.getByRole('meter', { name: 'Disk space used' }).boundingBox();
    expect(Math.abs(meter!.x + meter!.width / 2 - (strip!.x + strip!.width / 2))).toBeLessThanOrEqual(1);
    const total = await page.getByTestId('sample-disk-total').boundingBox();
    expect(total!.x + total!.width).toBeLessThanOrEqual(strip!.x + strip!.width); // still inside the strip
  }
});

const storedSampleNames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const req = indexedDB.open('ep2350_samples', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('files');
        req.onsuccess = () => {
          const keys = req.result.transaction('files', 'readonly').objectStore('files').getAllKeys();
          keys.onsuccess = () => resolve(keys.result.map(String).sort());
        };
      })
  );

test.describe('loaded WAVs are kept across reloads', () => {
  test('a WAV survives a reload, plays and exports', async ({ page }) => {
    await openSamples(page);
    const wav = makeWav({ secs: 0.4 });
    await page.getByTestId('sample-file-1').setInputFiles({ name: 'keep me.wav', mimeType: 'audio/wav', buffer: wav });
    await expect(page.getByTestId('sample-slot-1')).toHaveAttribute('data-state', 'custom');
    await expect.poll(() => storedSampleNames(page)).toEqual(['keep-me.wav']);

    await page.reload();
    await page.getByRole('button', { name: 'SAMPLES', exact: true }).click();
    const slot = page.getByTestId('sample-slot-1');
    await expect(slot).toHaveAttribute('data-state', 'custom');
    await expect(slot.getByTestId('sample-name')).toHaveText('keep-me.wav');
    await expect(slot.getByTestId('sample-size')).toHaveText('34 KB');
    await expect(slot.getByTestId('sample-missing')).toHaveCount(0);
    await slot.getByRole('button', { name: 'Play slot 2' }).click();

    const files = readZip((await exportDownload(page)).bytes);
    expect(files['keep-me.wav'].equals(wav)).toBe(true);
  });

  test("the same file name in another pack does not replace the first pack's sound", async ({ page }) => {
    await openSamples(page);
    const first = makeWav({ secs: 0.3 });
    await page.getByTestId('sample-file-0').setInputFiles({ name: 'horn.wav', mimeType: 'audio/wav', buffer: first });
    await expect(page.getByTestId('sample-slot-0').getByTestId('sample-name')).toHaveText('horn.wav');

    // A second pack loads a different horn.wav
    await page.getByLabel('Select default pack').click();
    await page.getByRole('button', { name: /START AN EMPTY/ }).click();
    await page.getByTestId('sample-file-0').setInputFiles({ name: 'horn.wav', mimeType: 'audio/wav', buffer: makeWav({ secs: 0.6 }) });
    await expect(page.getByTestId('sample-slot-0').getByTestId('sample-name')).toHaveText('horn-2.wav');
    await expect.poll(() => storedSampleNames(page)).toEqual(['horn-2.wav', 'horn.wav']);
  });

  test('WAVs no pack uses are deleted from storage on the next start', async ({ page }) => {
    await openSamples(page);
    await page.getByTestId('sample-file-0').setInputFiles({ name: 'gone.wav', mimeType: 'audio/wav', buffer: makeWav() });
    await page.getByTestId('sample-file-1').setInputFiles({ name: 'stay.wav', mimeType: 'audio/wav', buffer: makeWav() });
    await expect.poll(() => storedSampleNames(page)).toEqual(['gone.wav', 'stay.wav']);
    await page.getByTestId('sample-slot-0').getByRole('button', { name: 'FACTORY', exact: true }).click();
    await expect(page.getByTestId('sample-slot-0')).toHaveAttribute('data-state', 'factory');

    await page.reload();
    await expect.poll(() => storedSampleNames(page)).toEqual(['stay.wav']);
  });
});

test.describe('fitting the disk', () => {
  test('WAVs over 1 MB are made smaller to fit, and get their quality back when room frees up', async ({ page }) => {
    await openSamples(page);
    const a = makeWav({ channels: 2, secs: 3.5 }); // ~617 KB each, ~1.2 MB together
    const b = makeWav({ channels: 2, secs: 3.5 });
    await page.getByTestId('sample-file-0').setInputFiles({ name: 'a.wav', mimeType: 'audio/wav', buffer: a });
    await expect(page.getByTestId('sample-slot-0').getByTestId('sample-size')).toHaveText('603 KB');
    await page.getByTestId('sample-file-1').setInputFiles({ name: 'b.wav', mimeType: 'audio/wav', buffer: b });

    await expect(page.getByText('Fitted into 1 MB').first()).toBeVisible();
    const meter = page.getByRole('meter', { name: 'Disk space used' });
    await expect(meter).not.toHaveAttribute('data-over', 'true');
    // One file gave something; the hover title says what
    await expect(page.locator('[data-testid="sample-size"][data-fitted="true"]').first()).toHaveAttribute('title', /Made smaller to fit the disk: /);

    // The export holds the fitted files: valid WAVs that fit with config.json
    const files = readZip((await exportDownload(page)).bytes);
    // As on the mic's FAT disk: 250 clusters of 4 KB, every file in whole clusters
    const onDisk = Object.values(files).reduce((n, f) => n + Math.ceil(f.length / 4096) * 4096, 0);
    expect(onDisk).toBeLessThanOrEqual(250 * 4096);
    for (const name of ['a.wav', 'b.wav']) {
      expect(files[name].toString('ascii', 0, 4)).toBe('RIFF');
      expect([8, 16]).toContain(files[name].readUInt16LE(34));
    }

    // Fitted files are kept across a reload, without fitting again
    await page.reload();
    await page.getByRole('button', { name: 'SAMPLES', exact: true }).click();
    await expect(page.locator('[data-testid="sample-size"][data-fitted="true"]')).not.toHaveCount(0);
    await expect(meter).not.toHaveAttribute('data-over', 'true');

    // Free a slot: the other file goes back to its original
    await page.getByTestId('sample-slot-1').getByRole('button', { name: 'FACTORY', exact: true }).click();
    await expect(page.getByText('back to its original quality').first()).toBeVisible();
    await expect(page.getByTestId('sample-slot-0').getByTestId('sample-size')).toHaveText('603 KB');
    await expect(page.locator('[data-testid="sample-size"][data-fitted="true"]')).toHaveCount(0);
    const restored = readZip((await exportDownload(page)).bytes);
    expect(restored['a.wav'].equals(a)).toBe(true);
  });
});
