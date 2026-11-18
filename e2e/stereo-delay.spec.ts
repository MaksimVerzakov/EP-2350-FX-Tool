import { test, expect } from '@playwright/test';

/** Render the real DELAY graph in Chromium: echoes land on both sides at cross-feed 0 and alternate at 1. */
test('DELAY cross-feed ping-pongs between left and right', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { buildStereoDelay } = await import('/src/dsp/stereoDelay.ts');
    const sr = 48000;
    const render = async (crossFeed: number) => {
      const ctx = new OfflineAudioContext(2, sr, sr);
      const d = buildStereoDelay(ctx);
      d.apply(
        { time: 0.1, echo: 0.5, crossFeed, lowpass: 1, highpass: 0, wet: 1, dry: 0, balance: 0.5 },
        (param, v) => { if (param) param.value = v; }
      );
      const imp = ctx.createBuffer(1, 128, sr);
      imp.getChannelData(0)[0] = 1;
      const src = ctx.createBufferSource();
      src.buffer = imp;
      src.connect(d.input);
      d.output.connect(ctx.destination);
      src.start();
      const out = await ctx.startRendering();
      // Energy per channel around each repeat (0.1 s, 0.2 s, 0.3 s)
      return [1, 2, 3].map((k) => {
        const from = Math.round((k * 0.1 - 0.01) * sr), to = Math.round((k * 0.1 + 0.02) * sr);
        const e = (ch: number) => {
          let s = 0;
          const x = out.getChannelData(ch);
          for (let i = from; i < to; i++) s += x[i] * x[i];
          return s;
        };
        return [e(0), e(1)];
      });
    };
    return { mono: await render(0), pingPong: await render(1) };
  });
  const side = ([l, r]: number[]) => (l > r * 100 ? 'L' : r > l * 100 ? 'R' : 'both');
  expect(result.mono.map(side)).toEqual(['both', 'both', 'both']);
  expect(result.pingPong.map(side)).toEqual(['L', 'R', 'L']);
  // Each repeat is quieter than the last
  expect(result.pingPong[1][1]).toBeLessThan(result.pingPong[0][0]);
  expect(result.pingPong[2][0]).toBeLessThan(result.pingPong[1][1]);
});
