// Puts the demo into a reproducible state for screenshot comparison, then
// leaves it paused on a rendered frame.
//
// The real-time loop makes every capture land on a different cloud phase,
// swell phase and TAA history: repeat captures of an unchanged build drift by
// ~10/255 in mean channel value, which is more than most real regressions.
// Driving `frame` on a synthetic fixed-step clock from t=0 removes that.
//
// Run: playwright-cli eval "() => import('/scripts/capture-frame.js').then(m => m.default())"
const CAMERA = { pos: [4, 2.6, 6], target: [0, 0.8, 0] };
const FRAMES = 90; // enough for TAA to converge and the swell to develop
const DT = 1 / 60;

// `?cam=x,y,z` / `?look=x,y,z` move the pose, and the capture has to honour
// them or every underwater shot lands back at the default above-water view.
// Same parse as main.js: three finite comma-separated numbers, or nothing.
function poseFlag(name, fallback) {
  const q = new URLSearchParams(window.location.search).get(name);
  if (!q) return fallback;
  const parts = q.split(",").map(Number);
  return parts.length === 3 && parts.every(Number.isFinite) ? parts : fallback;
}

export default async function captureFrame({
  frames = FRAMES,
  dt = DT,
  pos = poseFlag("cam", CAMERA.pos),
  target = poseFlag("look", CAMERA.target),
} = {}) {
  // The scene is built asynchronously behind the loading screen. __demoReady
  // resolves only after that screen has left the DOM, so awaiting it also
  // guarantees the screenshot is of the render alone.
  const d = await (window.__demoReady ?? window.__demo);
  if (!d) return { error: "no __demo" };
  if (typeof d.stepFrames !== "function") return { error: "__demo.stepFrames missing" };

  // Damping integrates over wall-clock time, so it must be off for the pose
  // to be exact rather than merely close.
  d.controls.enableDamping = false;
  d.camera.position.set(...pos);
  d.controls.target.set(...target);
  d.controls.update();

  d.pause();
  d.resetTemporal();
  d.stepFrames(frames, dt);

  return { ok: true, frames, dt, t: frames * dt, pos, target };
}
