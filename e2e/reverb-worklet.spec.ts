import { test, expect } from '@playwright/test';

/**
 * The REVERB AudioWorklet embeds ReverbKernel's own source. Render an impulse through it in a real
 * browser to prove the embedded class parses and sounds: a room tail, stereo width, and the spring.
 */
test('the reverb worklet renders a room tail and a spring in the browser', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const mod = await import('/src/dsp/AudioEngine.ts');
    const sr = 48000;
    const render = async (time: number, spring: number) => {
      const ctx = new OfflineAudioContext(2, sr * 2, sr);
      const url = URL.createObjectURL(new Blob([mod.WORKLET_PROCESSOR_SOURCE], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url);
      const node = new AudioWorkletNode(ctx, 'ep2350-reverb', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { time, spring }
      });
      const imp = ctx.createBuffer(1, 128, sr);
      imp.getChannelData(0)[0] = 1;
      const src = ctx.createBufferSource();
      src.buffer = imp;
      src.connect(node);
      node.connect(ctx.destination);
      src.start();
      const out = await ctx.startRendering();
      const L = out.getChannelData(0);
      const R = out.getChannelData(1);
      const e = (x: Float32Array, a: number, b: number) => {
        let s = 0;
        for (let i = Math.round(a * sr); i < Math.round(b * sr); i++) s += x[i] * x[i];
        return s;
      };
      let diff = 0;
      for (let i = 0; i < L.length; i++) diff += (L[i] - R[i]) ** 2;
      return { early: e(L, 0.05, 0.3), late: e(L, 1.2, 1.9), diff, total: e(L, 0, 2) };
    };
    return { short: await render(0.1, 0), long: await render(0.8, 0), spring: await render(0.5, 1) };
  });
  expect(result.long.early).toBeGreaterThan(0);
  expect(result.long.diff).toBeGreaterThan(0); // stereo
  expect(result.long.late).toBeGreaterThan(result.short.late * 100); // longer time, longer tail
  expect(result.spring.total).toBeGreaterThan(0);
});
