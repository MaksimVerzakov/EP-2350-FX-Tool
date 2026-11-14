/**
 * Pure TypeScript WAV PCM encoder, decoder, and synthetic vocal generator.
 * Zero external dependencies — works identically in Node.js and browser environments.
 */

export interface StereoPcmBuffer {
  sampleRate: number;
  left: Float32Array;
  right: Float32Array;
  durationSec: number;
}

/**
 * Decode a RIFF/WAVE binary buffer (8/16/24/32-bit PCM or 32-bit float) into stereo Float32Arrays,
 * resampling to `targetSampleRate` (default 48000 Hz) if needed.
 */
export function decodeWavBuffer(
  input: Uint8Array | ArrayBuffer,
  targetSampleRate = 48000
): StereoPcmBuffer {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (bytes.byteLength < 44) {
    throw new Error('Invalid WAV file: buffer too small (< 44 bytes).');
  }

  const riff = readFourCC(view, 0);
  const wave = readFourCC(view, 8);
  if (riff !== 'RIFF' || wave !== 'WAVE') {
    throw new Error(`Invalid WAV header: expected RIFF/WAVE, got ${riff}/${wave}.`);
  }

  let audioFormat = 1; // 1 = PCM, 3 = IEEE Float
  let numChannels = 1;
  let sampleRate = 48000;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataLength = 0;

  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const chunkId = readFourCC(view, offset);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataStart = offset + 8;

    if (chunkId === 'fmt ' && chunkSize >= 16) {
      audioFormat = view.getUint16(chunkDataStart, true);
      numChannels = view.getUint16(chunkDataStart + 2, true);
      sampleRate = view.getUint32(chunkDataStart + 4, true);
      bitsPerSample = view.getUint16(chunkDataStart + 14, true);
      // Handle WAVE_FORMAT_EXTENSIBLE (0xFFFE)
      if (audioFormat === 0xfffe && chunkSize >= 40) {
        audioFormat = view.getUint16(chunkDataStart + 24, true);
      }
    } else if (chunkId === 'data') {
      dataOffset = chunkDataStart;
      dataLength = Math.min(chunkSize, bytes.byteLength - chunkDataStart);
      break;
    }

    offset = chunkDataStart + chunkSize + (chunkSize & 1);
  }

  if (dataOffset < 0 || dataLength <= 0) {
    throw new Error('Invalid WAV file: missing data chunk.');
  }
  if (audioFormat !== 1 && audioFormat !== 3) {
    throw new Error(`Unsupported WAV format code ${audioFormat} (only PCM=1 and IEEE Float=3 supported).`);
  }
  if (numChannels < 1) {
    throw new Error(`Invalid WAV channel count: ${numChannels}.`);
  }

  const bytesPerSample = Math.max(1, bitsPerSample >> 3);
  const blockAlign = bytesPerSample * numChannels;
  const numFrames = Math.floor(dataLength / blockAlign);

  const rawLeft = new Float32Array(numFrames);
  const rawRight = new Float32Array(numFrames);

  for (let i = 0; i < numFrames; i++) {
    const frameStart = dataOffset + i * blockAlign;
    const ch0 = readPcmSample(view, frameStart, audioFormat, bitsPerSample);
    const ch1 =
      numChannels >= 2
        ? readPcmSample(view, frameStart + bytesPerSample, audioFormat, bitsPerSample)
        : ch0;
    rawLeft[i] = ch0;
    rawRight[i] = ch1;
  }

  if (sampleRate === targetSampleRate || targetSampleRate <= 0) {
    return {
      sampleRate,
      left: rawLeft,
      right: rawRight,
      durationSec: numFrames / sampleRate
    };
  }

  const outFrames = Math.max(1, Math.round((numFrames * targetSampleRate) / sampleRate));
  const left = resampleLinear(rawLeft, outFrames);
  const right = resampleLinear(rawRight, outFrames);

  return {
    sampleRate: targetSampleRate,
    left,
    right,
    durationSec: outFrames / targetSampleRate
  };
}

/**
 * Encode a StereoPcmBuffer into a standard 16-bit stereo RIFF/WAVE binary buffer.
 */
export function encodeWavBuffer(pcm: StereoPcmBuffer): Uint8Array {
  const numChannels = 2;
  const bitsPerSample = 16;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const numFrames = Math.min(pcm.left.length, pcm.right.length);
  const dataSize = numFrames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeFourCC(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeFourCC(view, 8, 'WAVE');

  writeFourCC(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM = 1
  view.setUint16(22, numChannels, true);
  view.setUint32(24, pcm.sampleRate, true);
  view.setUint32(28, pcm.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  writeFourCC(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    const l = Math.max(-1, Math.min(1, pcm.left[i] || 0));
    const r = Math.max(-1, Math.min(1, pcm.right[i] || 0));
    view.setInt16(offset, l < 0 ? Math.round(l * 32768) : Math.round(l * 32767), true);
    view.setInt16(offset + 2, r < 0 ? Math.round(r * 32768) : Math.round(r * 32767), true);
    offset += 4;
  }

  return new Uint8Array(buffer);
}

/**
 * Generate a deterministic, broadband vocal audition phrase with formant transitions,
 * upper harmonics (up to 10 kHz for accurate LP/HP/EQ/SSB probing), syllable transients,
 * and trailing silence (`tailSilenceSec`) so DELAY echoes and REVERB tails can be measured.
 */
export function generateSyntheticVocalPcm(
  sampleRate = 48000,
  voiceDurationSec = 1.6,
  tailSilenceSec = 0.8
): StereoPcmBuffer {
  const totalSec = voiceDurationSec + tailSilenceSec;
  const totalSamples = Math.round(sampleRate * totalSec);
  const activeSamples = Math.round(sampleRate * voiceDurationSec);
  const left = new Float32Array(totalSamples);
  const right = new Float32Array(totalSamples);

  let phase = 0;
  for (let i = 0; i < activeSamples; i++) {
    const t = i / sampleRate;
    // Steady fundamental around 140Hz with natural vibrato
    const f0 = 140 + 12 * Math.sin(2 * Math.PI * 2.2 * t);
    phase += f0 / sampleRate;
    phase -= Math.floor(phase);

    // Rich glottal pulse train (harmonics 1..28 spanning 140 Hz .. ~4 kHz + upper presence)
    let glottal = 0;
    for (let h = 1; h <= 24; h++) {
      const rolloff = 1.0 / Math.pow(h, 0.72);
      glottal += rolloff * Math.sin(2 * Math.PI * h * phase);
    }
    glottal *= 0.22;

    // 4 distinct syllables ("E - P - F - X") so delay/reverb envelope autocorrelation has clear transient peaks
    const sylRate = 2.5; // 2.5 syllables per second
    const sylPhase = (t * sylRate) % 1.0;
    const sylAttack = Math.min(1.0, sylPhase * 18.0);
    const sylDecay = Math.exp(-3.2 * sylPhase);
    const syllableEnv = sylAttack * sylDecay;

    // Vowel formant modulation across the phrase
    const f1 = 550 + 250 * Math.sin(2 * Math.PI * 1.1 * t);
    const f2 = 1650 + 550 * Math.cos(2 * Math.PI * 1.5 * t);
    const f3 = 3200 + 400 * Math.sin(2 * Math.PI * 2.0 * t);

    const formantMod =
      0.55 +
      0.22 * Math.sin(2 * Math.PI * f1 * t) +
      0.15 * Math.sin(2 * Math.PI * f2 * t) +
      0.08 * Math.sin(2 * Math.PI * f3 * t);

    // Crisp plosive transient at the start of each syllable (broadband up to 12kHz)
    const transient =
      sylPhase < 0.025
        ? 0.18 *
          Math.exp(-sylPhase * 120) *
          (Math.sin(2 * Math.PI * 4800 * t) + 0.6 * Math.sin(2 * Math.PI * 8200 * t))
        : 0;

    // Smooth fade-in and fade-out at phrase boundaries
    const phraseWindow =
      Math.min(1.0, t / 0.02) * Math.min(1.0, (voiceDurationSec - t) / 0.04);

    const sample = (glottal * formantMod * syllableEnv + transient) * phraseWindow * 0.65;
    left[i] = sample;
    right[i] = sample;
  }

  return {
    sampleRate,
    left,
    right,
    durationSec: totalSec
  };
}

function readFourCC(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  );
}

function writeFourCC(view: DataView, offset: number, fourCC: string): void {
  for (let i = 0; i < 4; i++) {
    view.setUint8(offset + i, fourCC.charCodeAt(i) & 0xff);
  }
}

function readPcmSample(
  view: DataView,
  byteOffset: number,
  audioFormat: number,
  bitsPerSample: number
): number {
  if (byteOffset >= view.byteLength) return 0;
  if (audioFormat === 3 && bitsPerSample === 32) {
    return Math.max(-1, Math.min(1, view.getFloat32(byteOffset, true)));
  }
  if (bitsPerSample === 8) {
    return (view.getUint8(byteOffset) - 128) / 128;
  }
  if (bitsPerSample === 16) {
    return view.getInt16(byteOffset, true) / 32768;
  }
  if (bitsPerSample === 24) {
    const b0 = view.getUint8(byteOffset);
    const b1 = view.getUint8(byteOffset + 1);
    const b2 = view.getUint8(byteOffset + 2);
    const int24 = ((b2 << 24) | (b1 << 16) | (b0 << 8)) >> 8;
    return int24 / 8388608;
  }
  if (bitsPerSample === 32) {
    return view.getInt32(byteOffset, true) / 2147483648;
  }
  return 0;
}

function resampleLinear(input: Float32Array, outLength: number): Float32Array {
  if (input.length === 0) return new Float32Array(outLength);
  if (input.length === outLength) return new Float32Array(input);
  const out = new Float32Array(outLength);
  const ratio = (input.length - 1) / Math.max(1, outLength - 1);
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const s0 = input[idx] || 0;
    const s1 = input[Math.min(input.length - 1, idx + 1)] || 0;
    out[i] = s0 + frac * (s1 - s0);
  }
  return out;
}
