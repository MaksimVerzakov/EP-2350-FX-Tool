// Generates a synthesized vocal audition audio buffer as fallback when speech.mp3 is unavailable
export function createSyntheticAudioBuffer(ctx: AudioContext): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const duration = 2.2;

  const length = Math.floor(sampleRate * duration);
  const buffer = ctx.createBuffer(2, length, sampleRate);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);

  // Synthesize a human vocal speech formant phrase: "EP TWO THREE FIVE ZERO"
  // Formant filter synthesis with vowel transitions (Ah -> Oh -> Ee)
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    // Pitch trajectory (approx 120Hz fundamental with gentle inflection)
    const f0 = 120 + 25 * Math.sin(t * 3.5);
    const glottal =
      Math.sin(2 * Math.PI * f0 * t) +
      0.5 * Math.sin(4 * Math.PI * f0 * t) +
      0.25 * Math.sin(6 * Math.PI * f0 * t);

    // Syllable gating
    const envelope =
      Math.sin(Math.min(Math.PI, (t * Math.PI) / duration)) *
      (0.5 + 0.5 * Math.sin(2 * Math.PI * 3.5 * t));

    // Formants
    const f1 = 600 + 300 * Math.sin(t * 5.0);
    const f2 = 1400 + 600 * Math.cos(t * 4.0);
    const voiceSample =
      glottal * (0.6 * Math.sin(2 * Math.PI * f1 * t) + 0.4 * Math.sin(2 * Math.PI * f2 * t));

    const s = voiceSample * envelope * 0.45;
    left[i] = s;
    right[i] = s;
  }

  return buffer;
}
