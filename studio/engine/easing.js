const c1 = 1.70158, c2 = c1 * 1.525, c3 = c1 + 1, c4 = (2 * Math.PI) / 3;

export const EASE = {
  linear: t => t,
  easeIn: t => t * t,
  easeOut: t => 1 - (1 - t) * (1 - t),
  easeInOut: t => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  easeInCubic: t => t * t * t,
  easeOutCubic: t => 1 - Math.pow(1 - t, 3),
  easeInOutCubic: t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  easeOutQuart: t => 1 - Math.pow(1 - t, 4),
  easeInOutQuart: t => (t < 0.5 ? 8 * t ** 4 : 1 - Math.pow(-2 * t + 2, 4) / 2),
  easeOutExpo: t => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  easeInExpo: t => (t === 0 ? 0 : Math.pow(2, 10 * t - 10)),
  easeInOutExpo: t => (t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2),
  easeOutBack: t => 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2),
  easeInBack: t => c3 * t * t * t - c1 * t * t,
  easeInOutBack: t => (t < 0.5 ? (Math.pow(2 * t, 2) * ((c2 + 1) * 2 * t - c2)) / 2 : (Math.pow(2 * t - 2, 2) * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2),
  easeOutElastic: t => (t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1),
  spring: t => 1 - Math.exp(-6 * t) * Math.cos(t * 9.5) * (1 - t),
  easeOutCirc: t => Math.sqrt(1 - Math.pow(t - 1, 2)),
  easeInOutSine: t => -(Math.cos(Math.PI * t) - 1) / 2,
};

export const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
export const ease = (name, t) => (EASE[name] || EASE.easeOutCubic)(clamp01(t));
export const lerp = (a, b, t) => a + (b - a) * t;

export function sampleKeyframes(frames, t) {
  if (!frames?.length) return undefined;
  if (t <= frames[0].t) return frames[0].v;
  const last = frames[frames.length - 1];
  if (t >= last.t) return last.v;
  for (let i = 1; i < frames.length; i++) {
    const b = frames[i];
    if (t <= b.t) {
      const a = frames[i - 1];
      const span = b.t - a.t || 1e-6;
      return lerp(a.v, b.v, ease(b.ease, (t - a.t) / span));
    }
  }
  return last.v;
}
