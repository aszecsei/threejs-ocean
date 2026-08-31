import * as THREE from "three";
import { TAA_FRAGMENT_GLSL, taaMaterialConfig, type TaaHandle } from "./taa.js";

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
  const q = new URLSearchParams(window.location.search).get("sun");
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
  const q = new URLSearchParams(window.location.search).get("sky-lut");
  if (q === null) return true;
  return q !== "0" && q !== "false";
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
export const SKY_COLOR_GLSL = /* glsl */ `
${constDecls}
  const vec3 RAYLEIGH_TOTAL = ${glslVec3(RAYLEIGH_TOTAL)};
  const vec3 MIE_CONST = ${glslVec3(MIE_CONST)};
  const vec3 LUMA = ${glslVec3(LUMA)};
  const vec3 REF_SUN = ${glslVec3(DEFAULT_SUN.toArray())};
  const vec3 REF_PERP = ${glslVec3(REF_PERP.toArray())};
  const float PI = 3.141592653589793;

  // Physical single-scattering sky, tonemapped. halo scales the art glow;
  // disk returns the sun-disk mask for the caller.
  vec3 skyPhysical(vec3 dir, vec3 sunDir, vec3 sunCol, float halo, out float disk) {
    // --- Scattering coefficients (depend on sun only) ---
    float sunE = SUN_EE * max(0.0, 1.0 - exp(-((SUN_CUTOFF - acos(clamp(sunDir.y, -1.0, 1.0))) / SUN_STEEPNESS)));
    float sunFade = 1.0 - clamp(1.0 - exp(sunDir.y), 0.0, 1.0);
    vec3 betaR = RAYLEIGH_TOTAL * RAYLEIGH;
    float mieC = 0.2 * TURBIDITY * 10.0e-18;
    vec3 betaM = 0.434 * mieC * MIE_CONST * MIE_COEFFICIENT;

    // --- Optical depth along the view ray (analytic, clamped at horizon) ---
    float cosZ = max(dir.y, 0.0);
    float zenithAngle = acos(cosZ);
    float inv = 1.0 / (cosZ + 0.15 * pow(93.885 - degrees(zenithAngle), -1.253));
    vec3 Fex = exp(-(betaR * (RAYLEIGH_ZENITH_LENGTH * inv) + betaM * (MIE_ZENITH_LENGTH * inv)));

    // --- In-scattered light ---
    float mu = dot(dir, sunDir);
    float rPhase = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
    float g2 = MIE_G * MIE_G;
    float mPhase = (1.0 / (4.0 * PI)) * (1.0 - g2) / pow(1.0 - 2.0 * MIE_G * mu + g2, 1.5);
    vec3 ratio = (betaR * rPhase + betaM * mPhase) / (betaR + betaM);
    vec3 Lin = pow(sunE * ratio * (1.0 - Fex), vec3(1.5));
    Lin *= mix(vec3(1.0), pow(sunE * ratio * Fex, vec3(0.5)),
               clamp(pow(1.0 - sunDir.y, 5.0), 0.0, 1.0));

    // --- Sun disk + faint space term ---
    disk = smoothstep(SUN_ANGULAR_DIAMETER_COS, SUN_ANGULAR_DIAMETER_COS + 0.00002, mu);
    vec3 L0 = vec3(0.1) * Fex + sunE * 19000.0 * Fex * disk;

    vec3 hdr = (Lin + L0) * 0.04 + vec3(0.0, 0.0003, 0.00075);
    hdr = pow(hdr, vec3(1.0 / (1.2 + 1.2 * sunFade)));

    // Soft wide halo in the sun's tint (art term; the Mie lobe alone is tight).
    hdr += sunCol * halo * pow(max(mu, 0.0), 24.0) * Fex;

    // --- Tonemap ---
    return 1.0 - exp(-hdr * EXPOSURE);
  }

  #ifdef SKY_GRADE_LUT
  // Baked art-grade multiplier (createGradeLUT): the whole reference-sky
  // evaluation below is a pure function of dir.y once sun and palette are
  // fixed (page load), so one LUT tap replaces a full skyPhysical call.
  // Must be bound by every consumer of this GLSL when SKY_GRADE_LUT is
  // defined (share the sky's uniform object, like the color uniforms).
  uniform sampler2D uGradeLUT;
  #endif

  vec3 skyColor(vec3 dir, vec3 sunDir, vec3 zenith, vec3 horizon, vec3 ground, vec3 sunCol) {
    float disk;
    vec3 col = skyPhysical(dir, sunDir, sunCol, HALO, disk);

    // --- Art grade, anchored to the reference sun ---
    float cosZ = max(dir.y, 0.0);
    #ifdef SKY_GRADE_LUT
    // X axis is pow(cosZ, 0.55) -- same warp as the target gradient, so
    // texels crowd the horizon where the reference sky changes fastest.
    col *= texture2D(uGradeLUT,
                     vec2(pow(cosZ, 0.55) * ${glslFloat((GRADE_LUT_SIZE - 1) / GRADE_LUT_SIZE)}
                          + ${glslFloat(0.5 / GRADE_LUT_SIZE)}, 0.5)).rgb;
    #else
    float refDisk;
    vec3 refDir = REF_PERP * sqrt(max(1.0 - cosZ * cosZ, 0.0)) + vec3(0.0, cosZ, 0.0);
    vec3 ref = skyPhysical(refDir, REF_SUN, sunCol, 0.0, refDisk);
    vec3 target = mix(horizon, zenith, pow(cosZ, 0.55));
    // The anchor fades out as the sun drops so sunsets go fully physical
    // (the palette is a mid-afternoon look; it would cancel the warming).
    float gradeAmt = GRADE * smoothstep(0.05, 0.35, sunDir.y);
    col *= pow(target / max(ref, vec3(1e-3)), vec3(gradeAmt));
    #endif
    col = mix(vec3(dot(col, LUMA)), col, SATURATION);

    // HDR sun disc: well above the bloom threshold (post.js) so it blooms
    // into a soft glow; ACES rolls it off to white.
    col = mix(col, sunCol * 6.0, disk);

    // Below the horizon: fade to the ground/sea fill.
    col = mix(col, ground, smoothstep(0.0, 0.25, -dir.y));
    return col;
  }
`;

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
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        #ifdef TAA_ENABLED
        uniform mat4 uPreviousViewProjection;
        uniform vec3 uPreviousCameraPosition;
        varying vec4 vTaaCurrentClip;
        varying vec4 vTaaPreviousClip;
        #endif
        void main() {
          // Sphere is never rotated, so local position == world direction.
          vDir = position;
          gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
          #ifdef TAA_ENABLED
          vTaaCurrentClip = gl_Position;
          // The sky is infinitely distant. Recenter the same local direction
          // on the previous camera so translation contributes no velocity.
          vec3 previousWorld = uPreviousCameraPosition + position;
          vTaaPreviousClip = uPreviousViewProjection * vec4(previousWorld, 1.0);
          #endif
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vDir;
        uniform vec3 uZenithColor;
        uniform vec3 uHorizonColor;
        uniform vec3 uGroundColor;
        uniform vec3 uSunColor;
        uniform vec3 uSunDirection;
        uniform float uMaskMode;
        #ifdef TAA_ENABLED
        varying vec4 vTaaCurrentClip;
        varying vec4 vTaaPreviousClip;
        #endif

        ${TAA_FRAGMENT_GLSL}
        ${SKY_COLOR_GLSL}

        void main() {
          vec3 dir = normalize(vDir);
          if (uMaskMode > 0.5) {
            // Soft blob a few degrees across around the sun: the light
            // source the screen-space rays radiate from.
            float mu = dot(dir, normalize(uSunDirection));
            // Bright core plus a dim wide skirt: the skirt is what clouds carve
            // streaks out of.
            float m = max(mu, 0.0);
            gl_FragColor = vec4(vec3(0.5 * pow(m, 600.0) + 0.3 * pow(m, 40.0)), 1.0);
            #ifdef TAA_ENABLED
            taaMotion = taaPackMotion(vTaaCurrentClip, vTaaPreviousClip, 0.0);
            taaMotion.z = 1.0;
            #endif
            return;
          }
          vec3 col = skyColor(dir, normalize(uSunDirection), uZenithColor, uHorizonColor, uGroundColor, uSunColor);

          // Linear output: color space and tone mapping are applied once by
          // the post pipeline (post.js).
          gl_FragColor = vec4(col, 1.0);
          #ifdef TAA_ENABLED
          taaMotion = taaPackMotion(vTaaCurrentClip, vTaaPreviousClip, 0.0);
          // The dome does not write depth, so history stores the clear depth.
          taaMotion.z = 1.0;
          #endif
        }
      `,
    })
  );
  mesh.frustumCulled = false;
  scene.add(mesh);

  return { mesh, uniforms };
}

/** The sky rig returned by {@link createSky}. */
export type SkyRig = ReturnType<typeof createSky>;
