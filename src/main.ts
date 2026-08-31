import * as THREE from "three";
import * as flags from "./flags.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SKY_PALETTE, makeSunDirection, createSky, deriveSceneColors } from "./sky/index.js";
import { cloudsEnabled, cirrusEnabled, buildClouds } from "./clouds/index.js";
import { attachCloudShadow } from "./clouds/shadows/index.js";
import { oceanEnabled, oceanSize, oceanCascade2Enabled, buildOcean, sampleSwell, createSceneCapture } from "./ocean/index.js";
import { raysStrength, createGodRays } from "./render/godrays.js";
import { bloomStrength, createPostPipeline } from "./render/post.js";
import { runSteps, type Step, type StepTiming } from "./loading/loader.js";
import { createLoadingOverlay, loadingDebug, loadingEnabled, loadingHold } from "./loading/overlay.js";
import type { CloudRig, CloudPass } from "./clouds/index.js";
import type { OceanRig, SceneCapture } from "./ocean/index.js";
import type { GodRays } from "./render/godrays.js";
import type { PostPipeline } from "./render/post.js";
import type { SkyRig } from "./sky/index.js";
import type { DemoHandle } from "./core/demo-handle.js";

const canvas = document.getElementById("scene") as HTMLCanvasElement | null;
const hudStats = document.getElementById("hud-stats");
if (!canvas) throw new Error("#scene canvas is missing from the document");

// `?dpr=<x>` overrides the device pixel ratio (diagnostic lever for perf
// attribution, e.g. `?dpr=1`; not a quality setting -- never a default).
function pixelRatio() {
  // Any positive value wins; 0 and garbage fall back to the capped default.
  const k = flags.num("dpr", 0);
  if (k > 0) return k;
  return Math.min(window.devicePixelRatio, 2);
}

// --- Renderer -----------------------------------------------------------
// No canvas MSAA: the default path resolves jittered HDR history in post.js.
// ?taa=0 restores the old 4x multisampled ocean scene capture.
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.setPixelRatio(pixelRatio());
renderer.setSize(window.innerWidth, window.innerHeight);
// Honored only by OutputPass (post.js): three.js skips tone mapping and the
// sRGB transfer for anything rendered into a render target.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;

// --- Scene & camera -----------------------------------------------------
const scene = new THREE.Scene();
// Sun direction first: fog, background and lights are all derived from the
// scattering sky at this sun position (see deriveSceneColors in sky.js).
const sunDir = makeSunDirection();
const skyColors = deriveSceneColors(sunDir);
scene.background = skyColors.horizon.clone();
// Fog matches the sky's horizon color so distant geometry blends into the sky.
scene.fog = new THREE.Fog(skyColors.horizon.clone(), 30, 250);
// Page background behind the canvas (resize flashes) follows the same color.
document.body.style.background = `#${skyColors.horizon.getHexString()}`;

const camera = new THREE.PerspectiveCamera(
  50,
  window.innerWidth / window.innerHeight,
  0.1,
  500
);
camera.position.set(4, 2.6, 6);

// --- Controls -----------------------------------------------------------
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 0.8, 0);

// --- Rigs, built by boot() under the loading screen ----------------------
// Everything above is microseconds; everything below is the multi-second
// asset bake the loading screen exists to cover. These are assigned once,
// before the animation loop or the __demo handle can reach them.
let post!: PostPipeline;
let sky!: SkyRig;
let cloudRig: CloudRig | null = null;
let cloudPass: CloudPass | null = null;
let godRays: GodRays | null = null;
let ocean: OceanRig | null = null;
let grid: THREE.GridHelper | null = null;
// Screen-space reflections: everything except the ocean is rendered into a
// color+depth target first; the ocean shader marches its reflection rays
// against that depth buffer. See createSceneCapture in ocean.js.
let capture: SceneCapture | null = null;
let knot!: THREE.Mesh<THREE.TorusKnotGeometry, THREE.MeshStandardMaterial>;
// Bounding-sphere radius for the ocean's SSR march gate (rotation does not
// change it; a small margin covers filtering slop).
let knotBoundRadius = 1;

// --- Animation loop -----------------------------------------------------
const clock = new THREE.Clock(false);
// Warm-up frames are rendered behind the loading screen, so the live clock
// resumes where they left off rather than jumping the swell phase backwards.
let timeOffset = 0;
let frames = 0;
let fpsTimer = 0;

function tick() {
  frame(clock.getDelta(), timeOffset + clock.elapsedTime);
}

// One frame at an explicit (dt, t). Split out of the animation loop so test
// tooling can drive the demo on a synthetic clock -- with the real clock the
// cloud field, FFT swell and TAA history all land at a different phase on
// every run, which swamps screenshot comparison. See __demo.stepFrames.
function frame(dt: number, t: number) {
  // Drive the FFT simulation and rebind its ping-ponged textures.
  if (ocean) ocean.update(dt, t);

  // The torus knot rides the CPU swell approximation (bob + tilt).
  const swell = sampleSwell(knot.position.x, knot.position.z, t);
  knot.rotation.x = t * 0.35 + swell.gx * 0.6;
  knot.rotation.y = t * 0.5;
  knot.rotation.z = -swell.gz * 0.5;
  knot.position.y = 0.45 + swell.h;

  // Finish camera damping before centering camera-following geometry and
  // before TAA captures the current jittered view transform.
  controls.update();

  // Keep the sky and cloud domes centered on the camera so orbiting/zooming
  // never exits either shell. The ocean tile follows camera XZ only, so the
  // wave field stays world-anchored while never running out.
  sky.mesh.position.copy(camera.position);
  if (cloudRig) cloudRig.mesh.position.copy(camera.position);
  if (ocean) {
    ocean.mesh.position.x = camera.position.x;
    ocean.mesh.position.z = camera.position.z;
  }

  // Slow wind drift + evolution of the cloud field.
  if (cloudRig) cloudRig.uniforms.uTime.value = t;

  // The knot is the only geometry in the capture depth buffer; its bounding
  // sphere gates the ocean's SSR march (see ssrReflect in ocean.js).
  if (ocean) {
    ocean.uniforms.uReflectBound.value.set(
      knot.position.x, knot.position.y, knot.position.z, knotBoundRadius);
  }

  // Jitter only the scene render. endFrame() restores the base projection
  // after post-processing and commits camera/object transforms for velocity.
  post.taa.beginFrame(dt, scene);

  // March the cloud dome into its low-res buffer first; the capture pass
  // (or the `?ocean=0` branch below) composites it over the sky.
  if (cloudPass) cloudPass.render(camera);
  if (cloudRig?.shadows) cloudRig.shadows.update(camera.position);
  if (capture) {
    capture.render(scene, post.frame);
  } else {
    renderer.setRenderTarget(post.frame);
    renderer.render(scene, camera);
    if (cloudPass) cloudPass.composite(renderer);
  }
  if (cloudRig?.shadows) cloudRig.shadows.renderDebug(post.frame);
  if (godRays && cloudRig?.shadows?.mode !== "debug") godRays.render(post.frame);
  post.finish();
  post.taa.endFrame();

  // Cheap FPS readout, updated ~2x per second.
  frames++;
  fpsTimer += dt;
  if (fpsTimer >= 0.5) {
    const fps = Math.round(frames / fpsTimer);
    const dpr = renderer.getPixelRatio();
    if (hudStats) hudStats.textContent = `${fps} fps · ${Math.round(window.innerWidth * dpr)}×${Math.round(window.innerHeight * dpr)} px`;
    frames = 0;
    fpsTimer = 0;
  }
}

// --- Resize handling ----------------------------------------------------
function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(pixelRatio());
  renderer.setSize(w, h);
  post.resize();
  if (capture) capture.resize();
  if (godRays) godRays.resize();
  if (cloudPass) cloudPass.resize();
  if (cloudRig) cloudRig.reset();
}

function disposeDemo() {
  renderer.setAnimationLoop(null);
  window.removeEventListener("resize", onResize);
  cloudRig?.dispose();
  post.dispose();
  renderer.dispose();
}

// --- Boot ---------------------------------------------------------------
// The bakes below run for seconds. Each is a resumable generator, so the
// loader can hand the main thread back between chunks and the "Generating
// Assets" screen stays live and honest about what it is waiting on.

/**
 * Renders into the (hidden) canvas until TAA and the FFT have settled, so the
 * reveal shows a converged image rather than one resolving in front of the
 * viewer. The frames are charged to `timeOffset` so the live clock picks up
 * where they left off instead of jumping the swell phase backwards.
 */
function warmUpStep(): Step<void> {
  return {
    label: "Warming up",
    weight: COST_MS.warm,
    *bake() {
      for (let i = 0; i < WARM_FRAMES; i++) {
        frame(WARM_DT, i * WARM_DT);
        yield { label: "Warming up", detail: `frame ${i + 1}/${WARM_FRAMES}`, fraction: (i + 1) / WARM_FRAMES };
      }
      timeOffset = WARM_FRAMES * WARM_DT;
    },
  };
}

/** Wraps synchronous construction as a single-yield step. */
function sync<T>(label: string, weight: number, fn: () => T): Step<T> {
  return {
    label,
    weight,
    *bake() {
      yield { label, fraction: 0 };
      return fn();
    },
  };
}

// Warm-up frames are rendered behind the scrim, so shader compilation hitches
// and the first ~40 frames of TAA convergence happen where nobody sees them.
const WARM_FRAMES = 45;
const WARM_DT = 1 / 60;

// Step costs in approximate milliseconds, measured on a desktop GPU. They only
// pace the bar, so being off by a factor on the cheap steps is harmless -- what
// matters is that the 128³ cloud bake, which is most of the wait, gets most of
// the bar. `?loading=debug` prints the run's real timings to re-tune these.
const COST_MS = {
  post: 20, sky: 5, clouds: 3600, godRays: 5, ocean: 700,
  // Shader compilation swings from ~12 ms (driver cache warm) to ~220 ms cold.
  capture: 5, knot: 10, compile: 120, warm: 200,
  // Savings when the corresponding flag turns a sub-bake off.
  cirrus: 200, cascade2: 200,
};

async function boot(): Promise<DemoHandle> {
  const overlay = createLoadingOverlay();
  const timings: StepTiming[] = [];

  // The list is fixed before anything runs, and mirrors the flag readers the
  // factories use -- otherwise a `?clouds=0` run reserves half the bar for a
  // subsystem that never bakes.
  const steps: Step<unknown>[] = [
    sync("Post pipeline", COST_MS.post, () =>
      createPostPipeline(renderer, { bloom: bloomStrength(), camera })),
    sync("Sky dome", COST_MS.sky, () => createSky(scene, sunDir, post.taa)),
  ];
  if (cloudsEnabled()) {
    steps.push({
      label: "Cloud noise",
      weight: COST_MS.clouds - (cirrusEnabled() ? 0 : COST_MS.cirrus),
      bake: () => buildClouds(scene, sky.uniforms, renderer, post.taa),
    });
  }
  const rays = raysStrength();
  if (rays > 0) {
    steps.push(sync("God rays", COST_MS.godRays, () =>
      createGodRays(renderer, camera, scene, sky, cloudRig, { strength: rays, taa: post.taa })));
  }
  if (oceanEnabled()) {
    steps.push({
      label: "Ocean",
      weight: COST_MS.ocean - (oceanCascade2Enabled() ? 0 : COST_MS.cascade2),
      bake: () => buildOcean(scene, sky.uniforms, renderer, {
        size: oceanSize(),
        taa: post.taa,
        cloudShadow: cloudRig?.shadows?.uniforms ?? null,
      }),
    });
    steps.push(sync("Reflection capture", COST_MS.capture, () =>
      createSceneCapture(renderer, camera, ocean!, cloudPass, post.taa)));
  }
  steps.push(sync("Scene objects", COST_MS.knot, buildSceneObjects));
  steps.push({
    label: "Compiling shaders",
    weight: COST_MS.compile,
    // compileAsync resolves off a polled fence, so the await genuinely lets
    // the overlay repaint while the driver links programs.
    bake: function* () {
      yield { label: "Compiling shaders", detail: "linking programs", fraction: 0 };
      return renderer.compileAsync(scene, camera);
    },
  });
  if (loadingEnabled()) steps.push(warmUpStep());

  // Each rig is assigned the moment its step lands, because the steps after it
  // read it by name (the ocean wants the cloud shadow uniforms, the capture
  // wants the ocean) and so does frame().
  await runSteps(steps, {
    onProgress(pct, p) {
      overlay.setProgress(pct, p.detail ? `${p.label} · ${p.detail}` : p.label);
    },
    onStep(t) { timings.push(t); overlay.logStep(t.label, t.ms); },
    onValue(step, value) {
      switch (step.label) {
        case "Post pipeline": post = value as PostPipeline; break;
        case "Sky dome": sky = value as SkyRig; break;
        case "Cloud noise":
          cloudRig = value as CloudRig;
          // The cloud dome renders through an offscreen low-res pass by default
          // (cloudRig.pass; `?cloud-res=0` restores the in-scene dome).
          cloudPass = cloudRig.pass;
          break;
        case "God rays": godRays = value as GodRays; break;
        case "Ocean": ocean = value as OceanRig; break;
        case "Reflection capture": capture = value as SceneCapture; break;
      }
    },
  });

  // The `?ocean=0` fallback grid. Built after the steps because it only
  // exists when the ocean does not.
  if (!oceanEnabled()) {
    grid = new THREE.GridHelper(40, 40, 0x9cc8ea, 0x6fa8d8);
    grid.position.y = -0.01;
    scene.add(grid);
    // GridHelper is an unlit diagnostic. Leave its authored colors untouched;
    // the cloud map applies only to actual direct-sun lighting.
    post.taa.trackObject(grid);
  }

  if (loadingDebug()) console.table(timings);

  window.addEventListener("resize", onResize);
  window.addEventListener("pagehide", disposeDemo, { once: true });
  clock.start();
  renderer.setAnimationLoop(tick);

  const demo: DemoHandle = {
    scene, camera, controls, renderer, post, taa: post.taa,
    get clouds() { return cloudRig; },
    get ocean() { return ocean; },
    get capture() { return capture; },
    get godRays() { return godRays; },
    loading: overlay,
    dispose: disposeDemo,

    // --- Deterministic capture (screenshot regression testing) --------------
    // Stop the real-time loop and drive `frame` on a synthetic fixed-step clock,
    // so a run always lands on the same cloud phase, swell phase and TAA
    // history. Without this, repeat captures of an unchanged build differ by
    // ~10/255 in mean channel value -- enough to hide a real regression.
    pause() { renderer.setAnimationLoop(null); },
    resume() { renderer.setAnimationLoop(tick); },
    // Renders `count` frames of exactly `dt` seconds starting from t = 0.
    // Call after pause(); reset() first to clear temporal history.
    stepFrames(count = 60, dt = 1 / 60) {
      for (let i = 0; i < count; i++) frame(dt, i * dt);
    },
    // Drops every accumulated temporal buffer so stepFrames starts from a known
    // state rather than whatever the real-time loop left behind.
    resetTemporal() {
      post.taa.reset();
      cloudRig?.reset();
    },
  };
  window.__demo = demo;

  // `?loading-hold=1` leaves the finished screen up for screenshotting; the
  // handle is published either way so the hold can be released from the page.
  if (!loadingHold()) await overlay.finish();
  return demo;
}

// --- Starter object -----------------------------------------------------
function buildSceneObjects() {
  // Hemisphere: sky side is the mid-sky color, ground side the sea-bounce fill.
  const hemiSky = skyColors.horizon.clone().lerp(skyColors.zenith, 0.5);
  scene.add(new THREE.HemisphereLight(hemiSky, skyColors.ground, 0.9));

  const key = new THREE.DirectionalLight(SKY_PALETTE.sun, 2.2);
  key.position.copy(sunDir).multiplyScalar(12);
  scene.add(key);

  const rim = new THREE.DirectionalLight(0x6ea8ff, 0.7);
  rim.position.set(-6, 3, -5);
  scene.add(rim);

  knot = new THREE.Mesh(
    new THREE.TorusKnotGeometry(1, 0.34, 220, 32),
    new THREE.MeshStandardMaterial({
      color: 0xd9dee6,
      metalness: 0.55,
      roughness: 0.3,
    })
  );
  knot.position.y = 1;
  scene.add(knot);
  if (cloudRig?.shadows) attachCloudShadow(knot.material, cloudRig.shadows.uniforms);
  post.taa.trackObject(knot);
  knot.geometry.computeBoundingSphere();
  knotBoundRadius = knot.geometry.boundingSphere!.radius * 1.15;
}

// Published synchronously so external tooling has something to await: with an
// async boot, `window.__demo` no longer exists at module-evaluation time.
// Resolves only after the loading overlay has left the DOM, so a screenshot
// taken off this promise can never contain the scrim.
window.__demoReady = boot();
