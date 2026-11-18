import { cutoffToHz, makeSoftClipCurve } from './math';

/**
 * DELAY: two echo lines, left and right, with cross-feed between them.
 *
 * Each line feeds itself with echo * (1 - cross-feed) and the other line with echo * cross-feed.
 * The left line always takes the input; the right line takes input * (1 - cross-feed). So at
 * cross-feed 0 both sides echo together (dual mono), and at 1 the echoes ping-pong: the first
 * repeat on the left, the next on the right, and so on. The loop gain per line is `echo` either
 * way, and a soft clipper in each loop lets echo > 1 self-oscillate warmly instead of exploding.
 *
 * Every repeat runs through the line's high-pass and low-pass, so repeats get thinner and darker.
 */

export interface StereoDelayParams {
  /** Seconds, 0.01..1.1. */
  time: number;
  /** Feedback, 0..1.18 (above 1 self-oscillates through the soft clipper). */
  echo: number;
  /** 0 = each side repeats itself, 1 = repeats alternate sides. */
  crossFeed: number;
  /** 0..1 knob positions (mapped to Hz like every cutoff). */
  lowpass: number;
  highpass: number;
  wet: number;
  dry: number;
  /** 0 = left, 0.5 = centre, 1 = right (pans the repeats). */
  balance: number;
}

export type ParamSetter = (param: AudioParam | undefined, value: number, tau: number) => void;

export function buildStereoDelay(ctx: BaseAudioContext) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dryGain = ctx.createGain();
  const wetGain = ctx.createGain();
  const wetPanner = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
  const merger = ctx.createChannelMerger(2);
  const injectR = ctx.createGain();
  const curve = makeSoftClipCurve();

  const makeLine = () => {
    const delay = ctx.createDelay(2.0);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    const clip = ctx.createWaveShaper();
    clip.curve = curve as any;
    const fbSame = ctx.createGain();
    const fbCross = ctx.createGain();
    delay.connect(hp);
    hp.connect(lp);
    lp.connect(clip);
    clip.connect(fbSame);
    fbSame.connect(delay);
    return { delay, hp, lp, clip, fbSame, fbCross };
  };
  const left = makeLine();
  const right = makeLine();
  left.clip.connect(left.fbCross);
  left.fbCross.connect(right.delay);
  right.clip.connect(right.fbCross);
  right.fbCross.connect(left.delay);

  input.connect(dryGain);
  dryGain.connect(output);
  input.connect(left.delay);
  input.connect(injectR);
  injectR.connect(right.delay);
  left.clip.connect(merger, 0, 0);
  right.clip.connect(merger, 0, 1);
  merger.connect(wetGain);
  wetGain.connect(wetPanner);
  wetPanner.connect(output);

  const apply = (p: StereoDelayParams, set: ParamSetter) => {
    const time = Math.max(0.01, Math.min(1.1, p.time));
    const echo = Math.max(0, Math.min(1.18, p.echo));
    const cross = Math.max(0, Math.min(1, p.crossFeed));
    for (const line of [left, right]) {
      set(line.delay.delayTime, time, 0.03);
      set(line.fbSame.gain, echo * (1 - cross), 0.02);
      set(line.fbCross.gain, echo * cross, 0.02);
      set(line.lp.frequency, cutoffToHz(p.lowpass), 0.02);
      set(line.hp.frequency, cutoffToHz(p.highpass), 0.02);
    }
    set(injectR.gain, 1 - cross, 0.02);
    set(wetGain.gain, Math.max(0, Math.min(1, p.wet)), 0.02);
    set(dryGain.gain, Math.max(0, Math.min(1, p.dry)), 0.02);
    if ('pan' in wetPanner) set((wetPanner as StereoPannerNode).pan, (Math.max(0, Math.min(1, p.balance)) - 0.5) * 2, 0.015);
  };

  return { input, output, dryGain, wetGain, wetPanner, injectR, left, right, apply };
}

export type StereoDelay = ReturnType<typeof buildStereoDelay>;
