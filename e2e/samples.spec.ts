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

test('SAMPLES tab matches the FX board size', async ({ page }) => {
  await page.goto('/');
  const ledger = await page.locator('.te-ledger-card').first().boundingBox();
  await page.getByRole('button', { name: 'SAMPLES', exact: true }).click();
  await expect(page.getByRole('button', { name: 'SAMPLES', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const panel = await page.getByTestId('samples-panel').boundingBox();
  expect(Math.round(panel!.width)).toBe(Math.round(ledger!.width));
  expect(Math.round(panel!.height)).toBe(Math.round(ledger!.height));
  for (let pos = 0; pos < 4; pos++) {
    await expect(page.getByTestId(`sample-slot-${pos}`)).toHaveAttribute('data-state', 'factory');
  }
});

test('a loaded WAV gets its slot, settings and a place in the exported zip', async ({ page }) => {
  await openSamples(page);
  const wav = makeWav({ channels: 2, secs: 0.6 });
  const slot = page.getByTestId('sample-slot-0');

  await page.getByTestId('sample-file-0').setInputFiles({ name: 'Big Horn!.WAV', mimeType: 'audio/wav', buffer: wav });
  await expect(slot).toHaveAttribute('data-state', 'custom');
  await expect(slot).toContainText('big-horn.wav');
  await expect(slot.getByTestId('sample-info')).toContainText('44.1 kHz · 16-bit · stereo · 0.60 s');
  await expect(page.getByTestId('sample-disk-total')).toContainText('/ 1.00 MB');

  await slot.getByRole('button', { name: 'HOLD', exact: true }).click();
  await expect(slot.getByRole('button', { name: 'HOLD', exact: true })).toHaveAttribute('aria-pressed', 'true');

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

test('files the mic cannot play are refused or flagged', async ({ page }) => {
  await openSamples(page);
  await page.getByTestId('sample-file-1').setInputFiles({ name: 'song.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('ID3 not a wav') });
  await expect(page.getByText('Not a WAV file').first()).toBeVisible();
  await expect(page.getByTestId('sample-slot-1')).toHaveAttribute('data-state', 'factory');

  await page.getByTestId('sample-file-2').setInputFiles({ name: 'hires.wav', mimeType: 'audio/wav', buffer: makeWav({ rate: 192000, secs: 0.1 }) });
  const slot = page.getByTestId('sample-slot-2');
  await expect(slot).toHaveAttribute('data-state', 'custom');
  await expect(slot.getByRole('alert')).toContainText('up to 96 kHz');
});
