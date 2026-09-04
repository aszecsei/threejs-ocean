// Rough GPU-inclusive frame time for A/B-ing render flags.
//
// Steps the demo on the fixed clock (same as capture-frame.js), then times a
// burst of frames with a gl.finish() at the end so the GPU work is counted.
// The number is only comparable between runs at the same window size and
// ?dpr=; use it to rank flag sets, not to quote absolute costs.
//
// Run: playwright-cli eval "() => import('/scripts/measure-frame-time.js').then(m => m.default())"
const WARMUP = 30;
const FRAMES = 120;
const DT = 1 / 60;

export default async function measureFrameTime({ warmup = WARMUP, frames = FRAMES, dt = DT } = {}) {
  const d = await (window.__demoReady ?? window.__demo);
  if (!d) return { error: "no __demo" };
  const gl = d.renderer.getContext();
  d.pause();
  d.resetTemporal();
  d.stepFrames(warmup, dt);
  gl.finish();
  const started = performance.now();
  d.stepFrames(frames, dt);
  gl.finish();
  const ms = (performance.now() - started) / frames;
  return { ok: true, frames, msPerFrame: Number(ms.toFixed(3)), modes: d.clouds?.modes ?? null };
}
