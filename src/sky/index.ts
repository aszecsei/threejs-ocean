import * as THREE from "three";
import * as flags from "../flags.js";
import { taaMaterialConfig, type TaaHandle } from "../taa/index.js";
import SKY_COLOR_STATIC_GLSL from "./shaders/sky-color.glsl";
import SKY_DOME_VERT from "./shaders/sky-dome.vert.glsl";
import SKY_DOME_UNIFORMS from "./shaders/sky-dome.uniforms.glsl";
import SKY_DOME_MAIN from "./shaders/sky-dome.main.glsl";

// --- Sky palette ----------------------------------------------------------
// Shared sRGB hex values. Under the scattering model these are no longer the
// gradient endpoints: zenith/horizon are *grade targets* the physical result
// is pulled toward (see GRADE below), ground is the below-horizon fill, sun is
// the disk/halo tint. Fog, background and lights in main.js are derived from
// sampleSkyColor() instead, so they track ?sun= changes automatically.
// Ghibli-summer afternoon palette, sampled from the user's reference image:
// deep azure zenith -> cyan mid-band -> pale ice-blue horizon, white-gold sun.
//
// These are *pre-ACES* values: the frame is tone-mapped by post.js, so the
// hex gives the chromaticity and PALETTE_GAIN scales it into linear HDR. They
// were picked by pixel probe so the rendered sky lands on the display
// targets (zenith #2166b4, horizon #74bae9 at ~3 deg: a saturated bright blue)
// after tone mapping. Do not push the horizon gain much higher: a hot blue
// channel bleeds through the ACES matrices and bleaches everything that
// reflects it (the ocean went white at ~3x).
/** Authored sky colors, pre-gain, as hex. */
export interface SkyPalette {
  zenith: number;
  horizon: number;
  ground: number;
  sun: number;
}

/** {@link SKY_PALETTE} after gain, as linear HDR colors. */
export interface GradedPalette {
  zenith: THREE.Color;
  horizon: THREE.Color;
  ground: THREE.Color;
  sun: THREE.Color;
}

/** Colors the rest of the scene derives from the sky (fog, lights, background). */
export interface SceneColors {
  horizon: THREE.Color;
  zenith: THREE.Color;
  ground: THREE.Color;
}

export const SKY_PALETTE: SkyPalette = {
  zenith: 0x1955a6,
  horizon: 0x2289ff,
  ground: 0xbfe4f5, // bright sea-tone below the horizon
  sun: 0xfff3d9,
};
export const PALETTE_GAIN = { zenith: 1.0, horizon: 1.6, ground: 1.5 };

// --- Sun direction ---------------------------------------------------------
// `?sun=<elevationDeg>[,<azimuthDeg>]` overrides the mid-afternoon default.
// Azimuth 0 points down -Z (into the default view), increasing toward +X.
const DEFAULT_SUN = new THREE.Vector3(0.45, 0.62, -0.65).normalize();
const DEFAULT_ELEVATION = THREE.MathUtils.radToDeg(Math.asin(DEFAULT_SUN.y));
const DEFAULT_AZIMUTH = THREE.MathUtils.radToDeg(Math.atan2(DEFAULT_SUN.x, -DEFAULT_SUN.z));

export function sunAngles() {
  const q = flags.raw("sun");
  let elevation = DEFAULT_ELEVATION;
  let azimuth = DEFAULT_AZIMUTH;
  if (q !== null) {
    const [e, a] = q.split(",").map(Number);
    if (Number.isFinite(e)) elevation = e;
    if (Number.isFinite(a)) azimuth = a;
  }
  return { elevation, azimuth };
}

export function makeSunDirection() {
  const { elevation, azimuth } = sunAngles();
  const el = THREE.MathUtils.degToRad(elevation);
  const az = THREE.MathUtils.degToRad(azimuth);
  return new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    -Math.cos(az) * Math.cos(el)
  ).normalize();
}

// `?sky-lut=0` falls back to evaluating the grade reference sky per pixel
// instead of the baked 1D LUT (A/B check; see createGradeLUT).
export function skyLutEnabled() {
  return flags.enabled("sky-lut");
}

// --- Scattering constants --------------------------------------------------
// Declared once here and interpolated into the GLSL so the JS mirror
// (sampleSkyColor) and the shader can never drift apart.
// Physical part: Preetham-style Rayleigh + Mie single scattering with an
// analytic optical depth (same family as three.js's Sky addon).
// Art part: the physical result is graded *multiplicatively* against the
// palette, anchored to a reference sun (REF_SUN = the default afternoon sun):
//   col *= pow(paletteGradient(y) / physical(y, azimuth perpendicular to REF_SUN), GRADE)
// So at the default sun the sky lands on the sampled palette exactly, while
// everything sun-dependent (Mie halo, sun-side brightening, low-sun warming
// under ?sun=) survives as a ratio on top of it.
export const SKY_CONSTS = {
  // Physical
  TURBIDITY: 2.6,          // haze; 2 = crystal clear, 10 = hazy
  RAYLEIGH: 1.6,           // scale on Rayleigh scattering (blueness)
  MIE_COEFFICIENT: 0.006,  // amount of Mie (forward) scattering
  MIE_G: 0.80,             // Mie anisotropy; higher = tighter sun halo
  RAYLEIGH_ZENITH_LENGTH: 8400.0,
  MIE_ZENITH_LENGTH: 1250.0,
  SUN_EE: 1000.0,          // sun irradiance scale
  SUN_CUTOFF: Math.PI / 1.95,
  SUN_STEEPNESS: 1.5,
  SUN_ANGULAR_DIAMETER_COS: 0.999956676946448443553574619906976478926848692873900859324,
  // Art
  EXPOSURE: 0.9,           // exponential tonemap exposure (before grading)
  SATURATION: 0.95,        // chroma after grading (<1 now: ACES adds its own)
  GRADE: 0.85,             // 0 = pure physical, 1 = fully anchored to palette
  HALO: 0.35,              // extra soft glow around the sun (reference look)
};

const RAYLEIGH_TOTAL = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
const MIE_CONST = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];
const LUMA = [0.2126, 0.7152, 0.0722];
// Horizontal direction perpendicular to the reference sun: the grade samples
// the physical sky here so the sun's own halo/brightening isn't divided out.
const REF_PERP = new THREE.Vector3(-DEFAULT_SUN.z, 0, DEFAULT_SUN.x).normalize();

// Texel count of the baked grade LUT (createGradeLUT); interpolated into the
// GLSL below so the bake and the sampler mapping can never drift apart.
export const GRADE_LUT_SIZE = 256;

// GLSL float literal: always carries a decimal point or exponent.
const glslFloat = (x: number) => {
  const s = x.toPrecision(12);
  return /[.e]/.test(s) ? s : `${s}.0`;
};
const glslVec3 = (v: readonly number[]) => `vec3(${v.map(glslFloat).join(", ")})`;
const constDecls = Object.entries(SKY_CONSTS)
  .map(([k, v]) => `  const float ${k} = ${glslFloat(v)};`)
  .join("\n");

// --- Shared GLSL: the sky as a function ------------------------------------
// Single source of truth for the sky + sun, reused by the cloud shader
// (aerial perspective) and the ocean shader (reflections, horizon fog) so
// sky/water/clouds can never drift apart. Signature is stable:
//   skyColor(dir, sunDir, zenith, horizon, ground, sunCol)
// Returns linear color, tonemapped to ~0..1 (sun disk / halo may exceed 1).
// Constants shared by the GLSL sky and its CPU mirror. Generated rather than
// written into sky-color.glsl so SKY_CONSTS stays the single source of truth
// for both -- see skyPhysicalJS below.
const SKY_CONST_DECLS = /* glsl */ `
${constDecls}
  const vec3 RAYLEIGH_TOTAL = ${glslVec3(RAYLEIGH_TOTAL)};
  const vec3 MIE_CONST = ${glslVec3(MIE_CONST)};
  const vec3 LUMA = ${glslVec3(LUMA)};
  const vec3 REF_SUN = ${glslVec3(DEFAULT_SUN.toArray())};
  const vec3 REF_PERP = ${glslVec3(REF_PERP.toArray())};
  // Sample the grade LUT at texel centres.
  const float GRADE_LUT_SCALE = ${glslFloat((GRADE_LUT_SIZE - 1) / GRADE_LUT_SIZE)};
  const float GRADE_LUT_OFFSET = ${glslFloat(0.5 / GRADE_LUT_SIZE)};
`;

export const SKY_COLOR_GLSL = SKY_CONST_DECLS + SKY_COLOR_STATIC_GLSL;

// The dome fragment shader, assembled in the original order: declarations,
// then the sky function (with its generated constants), then the shading.
const SKY_DOME_FRAG = [SKY_DOME_UNIFORMS, SKY_COLOR_GLSL, SKY_DOME_MAIN].join("\n");

// --- JS mirror of skyColor() ------------------------------------------------
// Straight port of the GLSL above (same constants). Used for CPU-side
// derivation of fog / background / light colors. Returns a linear THREE.Color.
const clamp = THREE.MathUtils.clamp;
const smoothstep = THREE.MathUtils.smoothstep;
const mixv = (a: number[], b: number[], t: number): number[] => a.map((x, i) => x + (b[i] - x) * t);
const luma = (c: number[]) => c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];
const colorArr = (hex: THREE.ColorRepresentation): number[] => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };

function skyPhysicalJS(dir: THREE.Vector3, sunDir: THREE.Vector3, sunArr: number[], halo: number) {
  const K = SKY_CONSTS;
  const sy = clamp(sunDir.y, -1, 1);
  const sunE = K.SUN_EE * Math.max(0, 1 - Math.exp(-((K.SUN_CUTOFF - Math.acos(sy)) / K.SUN_STEEPNESS)));
  const sunFade = 1 - clamp(1 - Math.exp(sunDir.y), 0, 1);
  const betaR = RAYLEIGH_TOTAL.map((x) => x * K.RAYLEIGH);
  const mieC = 0.2 * K.TURBIDITY * 10e-18;
  const betaM = MIE_CONST.map((x) => 0.434 * mieC * x * K.MIE_COEFFICIENT);

  const cosZ = Math.max(dir.y, 0);
  const zenithAngle = Math.acos(cosZ);
  const inv = 1 / (cosZ + 0.15 * Math.pow(93.885 - THREE.MathUtils.radToDeg(zenithAngle), -1.253));
  const Fex = betaR.map((r, i) => Math.exp(-(r * K.RAYLEIGH_ZENITH_LENGTH * inv + betaM[i] * K.MIE_ZENITH_LENGTH * inv)));

  const mu = dir.dot(sunDir);
  const rPhase = (3 / (16 * Math.PI)) * (1 + mu * mu);
  const g2 = K.MIE_G * K.MIE_G;
  const mPhase = (1 / (4 * Math.PI)) * (1 - g2) / Math.pow(1 - 2 * K.MIE_G * mu + g2, 1.5);
  const ratio = betaR.map((r, i) => (r * rPhase + betaM[i] * mPhase) / (r + betaM[i]));
  const night = clamp(Math.pow(1 - sunDir.y, 5), 0, 1);
  const Lin = ratio.map((q, i) =>
    Math.pow(sunE * q * (1 - Fex[i]), 1.5) * (1 + (Math.pow(sunE * q * Fex[i], 0.5) - 1) * night));

  const disk = smoothstep(mu, K.SUN_ANGULAR_DIAMETER_COS, K.SUN_ANGULAR_DIAMETER_COS + 0.00002);
  const L0 = Fex.map((f) => 0.1 * f + sunE * 19000 * f * disk);

  const bias = [0, 0.0003, 0.00075];
  const haloAmt = halo * Math.pow(Math.max(mu, 0), 24);
  const hdr = Lin.map((l, i) =>
    Math.pow((l + L0[i]) * 0.04 + bias[i], 1 / (1.2 + 1.2 * sunFade)) + sunArr[i] * haloAmt * Fex[i]);
  return { col: hdr.map((h) => 1 - Math.exp(-h * K.EXPOSURE)), disk };
}

// Palette as the shader / mirror consume it: linear HDR, pre-ACES.
export function gradePalette(palette: SkyPalette = SKY_PALETTE, gain = PALETTE_GAIN): GradedPalette {
  return {
    zenith: new THREE.Color(palette.zenith).multiplyScalar(gain.zenith),
    horizon: new THREE.Color(palette.horizon).multiplyScalar(gain.horizon),
    ground: new THREE.Color(palette.ground).multiplyScalar(gain.ground),
    sun: new THREE.Color(palette.sun), // light color / disc tint: no gain
  };
}

// Bake of the grade multiplier pow(target / max(ref, 1e-3), gradeAmt) over
// dir.y: exactly the #else branch of skyColor's grade block, evaluated with
// the JS mirror. Everything it depends on -- reference sun, palette, actual
// sun elevation (gradeAmt) -- is fixed at page load, so the bake is exact
// and never regenerated. Texel i sits at u = i/(N-1) on the pow(cosZ, 0.55)
// axis, matching the half-texel mapping in the GLSL sampler.
const _lutDir = new THREE.Vector3();
export function createGradeLUT(sunDir: THREE.Vector3, palette: SkyPalette = SKY_PALETTE): THREE.DataTexture {
  const K = SKY_CONSTS;
  const P = gradePalette(palette);
  const sunArr = colorArr(P.sun);
  const zenith = colorArr(P.zenith);
  const horizon = colorArr(P.horizon);
  const gradeAmt = K.GRADE * smoothstep(sunDir.y, 0.05, 0.35);
  const n = GRADE_LUT_SIZE;
  const data = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    const cosZ = Math.pow(u, 1 / 0.55);
    const r = Math.sqrt(Math.max(1 - cosZ * cosZ, 0));
    _lutDir.set(REF_PERP.x * r, cosZ, REF_PERP.z * r);
    const ref = skyPhysicalJS(_lutDir, DEFAULT_SUN, sunArr, 0).col;
    const target = mixv(horizon, zenith, u); // u == pow(cosZ, 0.55)
    for (let c = 0; c < 3; c++) {
      data[i * 4 + c] = Math.pow(target[c] / Math.max(ref[c], 1e-3), gradeAmt);
    }
    data[i * 4 + 3] = 1;
  }
  const tex = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

const _refDir = new THREE.Vector3();
export function sampleSkyColor(dir: THREE.Vector3, sunDir: THREE.Vector3, palette: SkyPalette = SKY_PALETTE): THREE.Color {
  const K = SKY_CONSTS;
  const P = gradePalette(palette);
  const sunArr = colorArr(P.sun);
  let { col, disk } = skyPhysicalJS(dir, sunDir, sunArr, K.HALO);

  const cosZ = Math.max(dir.y, 0);
  const r = Math.sqrt(Math.max(1 - cosZ * cosZ, 0));
  _refDir.set(REF_PERP.x * r, cosZ, REF_PERP.z * r);
  const ref = skyPhysicalJS(_refDir, DEFAULT_SUN, sunArr, 0).col;
  const target = mixv(colorArr(P.horizon), colorArr(P.zenith), Math.pow(cosZ, 0.55));
  const gradeAmt = K.GRADE * smoothstep(sunDir.y, 0.05, 0.35);
  col = col.map((c, i) => c * Math.pow(target[i] / Math.max(ref[i], 1e-3), gradeAmt));
  const l = luma(col);
  col = col.map((c) => l + (c - l) * K.SATURATION);

  col = mixv(col, sunArr.map((s) => s * 6.0), disk);
  col = mixv(col, colorArr(P.ground), smoothstep(-dir.y, 0, 0.25));
  return new THREE.Color().setRGB(col[0], col[1], col[2], THREE.LinearSRGBColorSpace);
}

// Scene-level colors derived from the sky: averaged just-above-horizon color
// (fog, background, hemisphere sky), straight-up color, and the ground fill.
export function deriveSceneColors(sunDir: THREE.Vector3): SceneColors {
  const horizon = new THREE.Color(0, 0, 0);
  const n = 16;
  const d = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    d.set(Math.sin(a), 0.02, -Math.cos(a)).normalize();
    horizon.add(sampleSkyColor(d, sunDir));
  }
  horizon.multiplyScalar(1 / n);
  const zenith = sampleSkyColor(new THREE.Vector3(0, 1, 0), sunDir);
  const ground = gradePalette().ground;
  return { horizon, zenith, ground };
}

// --- Procedural sky -------------------------------------------------------
// Scattering sky rendered on an inverted sphere that follows the camera.
export function createSky(scene: THREE.Scene, sunDir: THREE.Vector3, taa: TaaHandle | null = null) {
  const P = gradePalette();
  const lut = skyLutEnabled() ? createGradeLUT(sunDir) : null;
  const uniforms = {
    uZenithColor: { value: P.zenith },
    uHorizonColor: { value: P.horizon },
    uGroundColor: { value: P.ground },
    uSunColor: { value: P.sun },
    uSunDirection: { value: sunDir },
    // 1 = god-ray occlusion mask pass: output a soft sun blob instead of the
    // sky (see godrays.js).
    uMaskMode: { value: 0 },
    // Present only when the LUT is on; clouds.js / ocean.js share this
    // uniform object and mirror the SKY_GRADE_LUT define off its presence.
    ...(lut ? { uGradeLUT: { value: lut } } : {}),
  };

  const taaConfig = taaMaterialConfig(taa);
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(60, 32, 16),
    new THREE.ShaderMaterial({
      uniforms: { ...uniforms, ...taaConfig.uniforms },
      side: THREE.BackSide,
      depthWrite: false,
      glslVersion: taaConfig.glslVersion,
      defines: { ...(lut ? { SKY_GRADE_LUT: "" } : {}), ...taaConfig.defines },
      vertexShader: SKY_DOME_VERT,
      fragmentShader: SKY_DOME_FRAG,
    })
  );
  mesh.frustumCulled = false;
  scene.add(mesh);

  return { mesh, uniforms };
}

/** The sky rig returned by {@link createSky}. */
export type SkyRig = ReturnType<typeof createSky>;
