import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SKY_PALETTE, makeSunDirection, createSky, deriveSceneColors } from "./sky.js";
import { cloudsEnabled, createClouds } from "./clouds.js";
import { attachCloudShadow } from "./cloud-shadows.js";
import { oceanEnabled, oceanSize, createOcean, sampleSwell, createSceneCapture } from "./ocean.js";
import { raysStrength, createGodRays } from "./godrays.js";
import { bloomStrength, createPostPipeline } from "./post.js";

const canvas = document.getElementById("scene");
const hudStats = document.getElementById("hud-stats");

// `?dpr=<x>` overrides the device pixel ratio (diagnostic lever for perf
// attribution, e.g. `?dpr=1`; not a quality setting -- never a default).
function pixelRatio() {
  const q = new URLSearchParams(window.location.search).get("dpr");
  const k = Number(q);
  if (q !== null && Number.isFinite(k) && k > 0) return k;
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

// --- Post pipeline: jittered HDR + motion -> TAA -> bloom -> display -----
const post = createPostPipeline(renderer, { bloom: bloomStrength(), camera });

// --- Controls -----------------------------------------------------------
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 0.8, 0);

// Debug/test handle: lets external tooling (playwright-cli eval) steer the
// camera and poke at the scene without reaching into module scope.
window.__demo = {
  scene, camera, controls, renderer, post, taa: post.taa,
  get clouds() { return cloudRig; },
  get ocean() { return ocean; },
  get capture() { return capture; },
  get godRays() { return godRays; },
};

// --- Sky & clouds -------------------------------------------------------
const sky = createSky(scene, sunDir, post.taa);
// The cloud dome renders through an offscreen low-res pass by default
// (cloudRig.pass; `?cloud-res=0` restores the in-scene dome).
const cloudRig = cloudsEnabled() ? createClouds(scene, sky.uniforms, renderer, post.taa) : null;
const cloudPass = cloudRig ? cloudRig.pass : null;
// Screen-space crepuscular rays, drawn over the finished frame (`?rays=0`).
const rays = raysStrength();
const godRays = rays > 0 ? createGodRays(renderer, camera, scene, sky, cloudRig, { strength: rays, taa: post.taa }) : null;

// --- Ocean (replaces the ground grid) -----------------------------------
// `?ocean=0` falls back to the flat grid for sky-only / perf A/B checks.
let ocean = null;
let grid = null;
// Screen-space reflections: everything except the ocean is rendered into a
// color+depth target first; the ocean shader marches its reflection rays
// against that depth buffer. See createSceneCapture in ocean.js.
let capture = null;
if (oceanEnabled()) {
  ocean = createOcean(scene, sky.uniforms, renderer, {
    size: oceanSize(),
    taa: post.taa,
    cloudShadow: cloudRig?.shadows?.uniforms ?? null,
  });
  capture = createSceneCapture(renderer, camera, ocean, cloudPass, post.taa);
} else {
  grid = new THREE.GridHelper(40, 40, 0x9cc8ea, 0x6fa8d8);
  grid.position.y = -0.01;
  scene.add(grid);
  // GridHelper is an unlit diagnostic. Leave its authored colors untouched;
  // the cloud map applies only to actual direct-sun lighting.
  post.taa.trackObject(grid);
}

// --- Lights -------------------------------------------------------------
// Hemisphere: sky side is the mid-sky color, ground side the sea-bounce fill.
const hemiSky = skyColors.horizon.clone().lerp(skyColors.zenith, 0.5);
scene.add(new THREE.HemisphereLight(hemiSky, skyColors.ground, 0.9));

const key = new THREE.DirectionalLight(SKY_PALETTE.sun, 2.2);
key.position.copy(sunDir).multiplyScalar(12);
scene.add(key);

const rim = new THREE.DirectionalLight(0x6ea8ff, 0.7);
rim.position.set(-6, 3, -5);
scene.add(rim);

// --- Ground grid (fallback only: `?ocean=0`) -----------------------------
// Created above when the ocean is disabled.

// --- Starter object -----------------------------------------------------
const knot = new THREE.Mesh(
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
// Bounding-sphere radius for the ocean's SSR march gate (rotation does not
// change it; a small margin covers filtering slop).
knot.geometry.computeBoundingSphere();
const knotBoundRadius = knot.geometry.boundingSphere.radius * 1.15;

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
window.addEventListener("resize", onResize);

function disposeDemo() {
  renderer.setAnimationLoop(null);
  window.removeEventListener("resize", onResize);
  cloudRig?.dispose();
  post.dispose();
  renderer.dispose();
}
window.__demo.dispose = disposeDemo;
window.addEventListener("pagehide", disposeDemo, { once: true });

// --- Animation loop -----------------------------------------------------
const clock = new THREE.Clock();
let frames = 0;
let fpsTimer = 0;

renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  const t = clock.elapsedTime;

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
    hudStats.textContent = `${fps} fps · ${Math.round(window.innerWidth * dpr)}×${Math.round(window.innerHeight * dpr)} px`;
    frames = 0;
    fpsTimer = 0;
  }
});
