import * as THREE from "three";
import { createOceanFft, cascadeAmpScale, OCEAN_FFT_DEFAULTS } from "./ocean-fft.js";
import { SKY_COLOR_GLSL } from "./sky.js";
import { createOceanDetailTexture } from "./ocean-textures.js";
import { TAA_FRAGMENT_GLSL, taaMaterialConfig } from "./taa.js";

// --- Stylized FFT ocean -----------------------------------------------------
// Distance-graded radial disc (dense verts near the camera, sparse to the
// horizon) displaced by the GPU Tessendorf simulation in ocean-fft.js.
// Shading: Fresnel-procedural-sky reflection, dual-lobe GGX sun specular,
// boosted sub-surface scattering on backlit crests, and Jacobian-driven foam
// with fade in/out (accumulated in the foam texture by the FFT pipeline).
// Sub-texel surface detail comes from a baked tiling texture
// (ocean-textures.js): RG = ripple normal map sampled at two drifting
// scales, B = foam churn lace that the foam mask erodes through as foam
// decays, A = bubble speckle. Being mip-mapped, it filters cleanly at the
// horizon where per-fragment noise would shimmer.
//
// Uniform *objects* are shared with the sky (same trick as clouds.js) so sun
// direction and sky colors stay in sync by construction. This file owns no
// palette of its own except the water-body colors below.

// Tuning knobs. FFT-side knobs live in OCEAN_FFT_DEFAULTS (ocean-fft.js).
export const OCEAN_DEFAULTS = {
  DISC_RADIUS: 380,   // world units to the horizon edge (fog covers the rim)
  DISC_RINGS: 240,    // ring count; exponential spacing, dense near camera
  DISC_SECTORS: 256,  // angular resolution
  DISC_RMIN: 0.5,     // innermost ring radius around the camera

  DEEP_COLOR: 0x0a4a75, // deep-water body color
  SSS_COLOR: 0x2bd4b0,  // boosted subsurface scatter (turquoise crest glow)
  SSS_STRENGTH: 0.9,
  SSS_POWER: 3.0,       // backlight lobe tightness
  SSS_DISTORT: 0.35,    // normal distortion of the through-light ray
  ROUGHNESS: 0.09,      // base GGX roughness (sun-glitter sharpness)
  FOG_NEAR: 90.0,       // own fog: blends the surface into the exact sky
  FOG_FAR: 360.0,       // color along each view ray (seamless horizon)

  // Procedural detail texture (see ocean-textures.js). `?detail=0` disables.
  DETAIL_TEX_SIZE: 512,          // baked texture resolution (tileable)
  // Character of the baked ripple heightfield (see fbm in ocean-textures.js).
  // +1 = ridged creases, 0 = plain fBm, -1 = billow. Ridged filaments read as
  // marbled oil once two panning copies are warped over each other, so this
  // sits on the billow side; the second FFT cascade now supplies the genuine
  // sub-metre waves that the sharp octaves used to be faking.
  DETAIL_FOLD: 0.0,
  DETAIL_GAIN: 0.42,             // octave falloff; lower = softer, cloudier
  DETAIL_OCTAVES: 5,
  DETAIL_SCALE: [0.45, 1.8],     // normal-map tilings, cycles per world unit
  DETAIL_STRENGTH: 0.2,         // tangent tilt added to the FFT normal
  // Pan velocities of the two normal layers, world units/s (x, z). Roughly
  // wind-aligned (wind is (1, 0.35)) at different speeds and slightly
  // different headings so the layers interfere instead of sliding together.
  DETAIL_PAN: [0.55, 0.25, 0.32, -0.08],
  // Macro layer: the same normal map at a large tile, slow pan. It adds a
  // broad tilt and domain-warps the fine layers so their repeat never lines
  // up. Two incommensurate FFT patch sizes (200 m and 17 m) now break up the
  // tiling on their own, so this only has to soften what is left — it used
  // to be the whole defence and was correspondingly heavy-handed.
  DETAIL_MACRO_SCALE: 0.06,      // cycles per world unit (~17 m tile)
  DETAIL_MACRO_STRENGTH: 0.15,   // tilt contribution relative to DETAIL_STRENGTH
  DETAIL_MACRO_WARP: 0.22,       // domain warp of the fine layers, in cycles
                                 // of their own tiling (not world units — see
                                 // the fragment shader). Past ~0.4 the layers
                                 // shear into marbled filaments.
  DETAIL_MACRO_PAN: [0.12, 0.05], // world units/s
  FOAM_CHURN_SCALE: 0.8,         // churn/bubble tiling, cycles per world unit
  FOAM_EDGE: 0.5,                // width of the foam erosion edge (wider = softer)
  FOAM_OPACITY: 0.65,            // peak foam coverage; aging foam thins toward 0
  FOAM_MACRO_WARP: 2.5,          // world-unit warp of the churn lookup by the macro layer
  FOAM_BUMP: 0.5,                // extra normal tilt inside foam

  // Screen-space reflections (see createSceneCapture + the SSR block in the
  // fragment shader).
  SSR_STEPS: 28,        // coarse march steps along the reflected ray
  SSR_REFINE: 5,        // binary-search refinements after a coarse hit
  SSR_STEP0: 0.12,      // first step length (world units); grows geometrically
  SSR_STEP_GROWTH: 1.16,
  SSR_THICKNESS: 0.35,  // depth-buffer thickness a ray may pass "behind"
  SSR_EDGE_FADE: 0.08,  // screen-edge fade width (uv units)

  // Contact foam where the water meets captured geometry (the knot), from
  // the view-space gap between the water fragment and the scene depth
  // behind it (not a true water-column depth). `?contact=0` disables.
  CONTACT_WIDTH: 0.35,    // view-depth gap (world units) that reads as touching
  CONTACT_STRENGTH: 0.9,  // peak contact foam coverage
  CONTACT_RIPPLE: 0.3,    // normal tilt of the ring ripples around the contact
  CONTACT_PULSE: 0.15,    // temporal breathing of the foam skirt

  // Second FFT cascade (`?cascade2=0` disables). A 200 m patch at 256^2 is
  // dx ~= 0.78 m, so everything shorter than a couple of metres had to come
  // from the baked detail normal, which cannot sharpen a crest. This one is
  // 17 m at 128^2 (dx ~= 13 cm) and carries the band above the boundary.
  CASCADE2_SIZE: 128,      // FFT resolution of the fine cascade
  CASCADE2_PATCH: 17,      // world-space period, metres
  CASCADE2_BAND: 6,        // band boundary = 2*pi / CASCADE2_PATCH * this
  CASCADE2_CUTOFF: 0.08,   // small-wave cutoff l, shared by both cascades
  // Choppy is an absolute displacement scale and dD/dx grows with k, so the
  // large-wave value drives the fine cascade's Jacobian straight through
  // zero and foams the whole sea. Short waves get their own, much smaller.
  CASCADE2_CHOPPY: 1.0,
  CASCADE2_FADE: [25.0, 70.0], // metres over which the fine cascade fades out
};

// Fallback capture sample count. Default TAA uses a single-sample MRT.
const CAPTURE_SAMPLES = 4;

// Render layer used to draw the ocean alone in the SSR second pass.
export const OCEAN_LAYER = 1;

// Toggle via `?ocean=0` / `?ocean=1` (default: on). Resolution override via
// `?ocean-n=128|256|512` (power of two; lower it for software rasterizers).
export function oceanEnabled() {
  const q = new URLSearchParams(window.location.search).get("ocean");
  if (q === null) return true;
  return q !== "0" && q !== "false";
}

// `?detail=0` drops the procedural detail texture (flat FFT normals + plain
// foam blob) for A/B comparison.
export function oceanDetailEnabled() {
  const q = new URLSearchParams(window.location.search).get("detail");
  if (q === null) return true;
  return q !== "0" && q !== "false";
}

// `?contact=0` drops the contact foam around the knot for A/B comparison.
export function oceanContactEnabled() {
  const q = new URLSearchParams(window.location.search).get("contact");
  if (q === null) return true;
  return q !== "0" && q !== "false";
}

// `?cascade2=0` drops the fine FFT cascade (A/B for the second cascade).
export function oceanCascade2Enabled() {
  const q = new URLSearchParams(window.location.search).get("cascade2");
  return q !== "0";
}

// `?ssr=0` drops screen-space reflections entirely; `?ssr=full` marches every
// near-water ray (disables the knot-bounds gate, the pre-gate behavior).
// Default: march only rays that can hit the knot's bounding sphere -- the
// knot is the only geometry in the capture depth buffer, so everything else
// already resolves through the sky/cloud direction fallback.
export function ssrMode() {
  const q = new URLSearchParams(window.location.search).get("ssr");
  if (q === "0" || q === "false") return "off";
  if (q === "full") return "full";
  return "gate";
}

export function oceanSize() {
  const q = new URLSearchParams(window.location.search).get("ocean-n");
  const n = parseInt(q, 10);
  if ([128, 256, 512].includes(n)) return n;
  return 256;
}

// --- Geometry: exponential radial disc --------------------------------------
// Ring 0 is the center point (under the camera); rings 1..rings grow
// exponentially from rMin to rMax, so vertex density is high near the camera
// (where detail matters) and falls off toward the fog-obscured horizon. The
// mesh is never rotated and snaps to the camera XZ every frame, while the
// wave sampling stays world-anchored.
function buildDiscGeometry(rings, sectors, rMin, rMax) {
  const positions = new Float32Array((rings + 1) * sectors * 3);
  const idx = [];

  for (let i = 0; i <= rings; i++) {
    const r = i === 0 ? 0 : rMin * Math.pow(rMax / rMin, (i - 1) / (rings - 1));
    for (let j = 0; j < sectors; j++) {
      const a = (j / sectors) * Math.PI * 2;
      const o = (i * sectors + j) * 3;
      positions[o + 0] = Math.cos(a) * r;
      positions[o + 1] = 0;
      positions[o + 2] = Math.sin(a) * r;
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < sectors; j++) {
      const jn = (j + 1) % sectors;
      const a = i * sectors + j;
      const b = i * sectors + jn;
      const c = (i + 1) * sectors + j;
      const d = (i + 1) * sectors + jn;
      idx.push(a, b, c, b, d, c);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setIndex(idx);
  return geo;
}

// --- CPU swell approximation (floating objects) ------------------------------
// A few dispersion-matched components tuned to the FFT swell. Not an exact
// match to the displacement texture (that would need GPU readback) — just
// enough for the torus knot to plausibly ride the waves.
const SWELL_COMPONENTS = [
  { dx: 0.94, dz: 0.33, wl: 38, amp: 0.45, phase: 0.0 },
  { dx: 0.85, dz: -0.52, wl: 17, amp: 0.22, phase: 1.9 },
  { dx: -0.45, dz: 0.89, wl: 7.5, amp: 0.07, phase: 4.1 },
];

export function sampleSwell(x, z, t) {
  let h = 0;
  let gx = 0;
  let gz = 0;
  for (const c of SWELL_COMPONENTS) {
    const dn = Math.hypot(c.dx, c.dz);
    const kx = (c.dx / dn) * ((2 * Math.PI) / c.wl);
    const kz = (c.dz / dn) * ((2 * Math.PI) / c.wl);
    const k = (2 * Math.PI) / c.wl;
    const w = Math.sqrt(9.81 * k);
    const ph = kx * x + kz * z - w * t + c.phase;
    h += c.amp * Math.sin(ph);
    gx += c.amp * kx * Math.cos(ph);
    gz += c.amp * kz * Math.cos(ph);
  }
  return { h, gx, gz };
}

// --- Shaders ----------------------------------------------------------------

const VERTEX_SHADER = /* glsl */ `
  uniform sampler2D uDisplace;
  uniform float uPatchSize;

  #ifdef TAA_ENABLED
    uniform sampler2D uPreviousDisplace;
    uniform mat4 uPreviousViewProjection;
    uniform vec3 uPreviousCameraPosition;
    varying vec4 vTaaCurrentClip;
    varying vec4 vTaaPreviousClip;
  #endif

  varying vec2 vUv;
  varying vec3 vWorldPos;
  varying float vHeight;
  varying float vDist;

  #ifdef OCEAN_CASCADE2
    uniform sampler2D uDisplace2;
    #ifdef TAA_ENABLED
      uniform sampler2D uPreviousDisplace2;
    #endif
    uniform float uPatchSize2;
    uniform vec2 uCascade2Fade;
    varying vec2 vUv2;
    varying float vFade2;
  #endif

  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);

    // World-anchored sampling: the wave field tiles with period uPatchSize
    // and does not move with the camera-following mesh. The displacement
    // texture wraps, so uv > 1 is fine.
    vec2 base = wp.xz;
    float rad = distance(base, cameraPosition.xz);
    vec2 uv = base / uPatchSize;
    vec4 d = texture2D(uDisplace, uv);

    // Gerstner choppy displacement + height (already scaled by the combine
    // pass of the FFT pipeline). Horizontal displacement fades out with
    // distance: far rings are coarser than the wave length, and folding
    // undersampled choppy displacement makes overlapping triangle sheets.
    float fade = smoothstep(30.0, 140.0, rad);
    wp.xz += d.xz * (1.0 - fade * 0.85);
    // Height also eases out at grazing angles to soften far-field faceting.
    wp.y = d.y * (1.0 - 0.5 * smoothstep(120.0, 320.0, rad));

    #ifdef OCEAN_CASCADE2
      // The fine cascade is sub-texel on the disc past a few tens of metres
      // and would alias into a crawling grid, so it fades out well before
      // the coarse one does. Sampled on the *undisplaced* xz, like cascade 0.
      vec2 uv2 = base / uPatchSize2;
      float fade2 = 1.0 - smoothstep(uCascade2Fade.x, uCascade2Fade.y, rad);
      vec4 d2 = texture2D(uDisplace2, uv2);
      wp.xz += d2.xz * (1.0 - fade * 0.85) * fade2;
      wp.y += d2.y * fade2;
      vUv2 = uv2;
      vFade2 = fade2;
    #endif

    #ifdef TAA_ENABLED
      // Rebuild last frame's displaced surface at the same world-anchored
      // base point. Camera-following mesh recentering is not water motion.
      vec4 previousWp = vec4(base.x, 0.0, base.y, 1.0);
      float previousRad = distance(base, uPreviousCameraPosition.xz);
      vec4 previousD = texture2D(uPreviousDisplace, uv);
      float previousFade = smoothstep(30.0, 140.0, previousRad);
      previousWp.xz += previousD.xz * (1.0 - previousFade * 0.85);
      previousWp.y = previousD.y * (1.0 - 0.5 * smoothstep(120.0, 320.0, previousRad));
      #ifdef OCEAN_CASCADE2
        vec4 previousD2 = texture2D(uPreviousDisplace2, uv2);
        float previousFade2 = 1.0 - smoothstep(uCascade2Fade.x, uCascade2Fade.y, previousRad);
        previousWp.xz += previousD2.xz * (1.0 - previousFade * 0.85) * previousFade2;
        previousWp.y += previousD2.y * previousFade2;
      #endif
      vTaaPreviousClip = uPreviousViewProjection * previousWp;
    #endif

    vUv = uv;
    vWorldPos = wp.xyz;
    vHeight = d.y;
    vDist = distance(wp.xyz, cameraPosition);
    gl_Position = projectionMatrix * viewMatrix * wp;
    #ifdef TAA_ENABLED
      vTaaCurrentClip = gl_Position;
    #endif
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uFoam;
  uniform float uFoamSize;
  #ifdef OCEAN_CASCADE2
    uniform sampler2D uFoam2;
    uniform float uFoamSize2;
    varying vec2 vUv2;
    varying float vFade2;
  #endif
  uniform vec3 uSunDirection;
  uniform vec3 uSunColor;
  uniform vec3 uZenithColor;
  uniform vec3 uHorizonColor;
  uniform vec3 uGroundColor;
  uniform vec3 uDeepColor;
  uniform vec3 uSSSColor;
  uniform float uSSSStrength;
  uniform float uSSSPower;
  uniform float uSSSDistort;
  uniform float uRoughness;
  uniform float uTime;
  uniform float uFogNear;
  uniform float uFogFar;
  #ifdef CLOUD_SHADOWS
    uniform sampler2D tCloudShadow;
    uniform vec2 uCloudShadowCenter;
    uniform float uCloudShadowExtent;
    uniform float uCloudShadowEnabled;
  #endif

  // Baked detail texture: RG normal xy, B foam churn, A bubble speckle.
  uniform sampler2D uDetailTex;
  uniform vec2 uDetailScale;
  uniform float uDetailStrength;
  uniform vec4 uDetailPan;
  uniform vec4 uDetailMacro; // scale, strength, warp, unused
  uniform vec2 uDetailMacroPan;
  uniform float uFoamChurnScale;
  uniform float uFoamEdge;
  uniform float uFoamOpacity;
  uniform float uFoamMacroWarp;
  uniform float uFoamBump;

  // Screen-space reflection inputs (scene without the ocean).
  uniform sampler2D uSceneColor;
  uniform sampler2D uSceneDepth;
  uniform mat4 uProjection;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform float uSsrThickness;
  uniform float uSsrEdgeFade;
  // Bounding sphere (center xyz, radius) of the captured geometry (the
  // knot); updated per frame by main.js. Gates the SSR march.
  uniform vec4 uReflectBound;
  // Contact foam: (width, strength, ripple, pulse); 1 / drawing-buffer size.
  uniform vec4 uContact;
  uniform vec2 uInvResolution;

  varying vec2 vUv;
  varying vec3 vWorldPos;
  varying float vHeight;
  varying float vDist;
  #ifdef TAA_ENABLED
    varying vec4 vTaaCurrentClip;
    varying vec4 vTaaPreviousClip;
  #endif

  ${TAA_FRAGMENT_GLSL}
  ${SKY_COLOR_GLSL}
  #include <packing>

  // --- Screen-space reflection helpers ------------------------------------
  // Project a world point to screen uv; also returns view-space z (negative
  // in front of the camera) and whether the point is in front of the camera.
  vec2 ssrProject(vec3 p, out float viewZ, out bool ok) {
    vec4 vp = viewMatrix * vec4(p, 1.0);
    vec4 cp = uProjection * vp;
    viewZ = vp.z;
    ok = cp.w > 1e-4;
    return (cp.xy / max(cp.w, 1e-4)) * 0.5 + 0.5;
  }

  bool ssrOnScreen(vec2 uv) {
    return uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0;
  }

  float ssrEdgeFade(vec2 uv) {
    vec2 f = smoothstep(0.0, uSsrEdgeFade, uv) * smoothstep(1.0, 1.0 - uSsrEdgeFade, uv);
    return f.x * f.y;
  }

  // Ray at world point p vs. the captured depth buffer: true when the ray
  // has gone just behind the stored surface (within thickness).
  bool ssrTest(vec3 p, out vec2 uv) {
    float vz; bool ok;
    uv = ssrProject(p, vz, ok);
    if (!ok || !ssrOnScreen(uv)) return false;
    float d = texture2D(uSceneDepth, uv).r;
    if (d >= 0.99999) return false; // sky: nothing to hit
    float sz = perspectiveDepthToViewZ(d, uCameraNear, uCameraFar);
    return vz < sz && vz > sz - uSsrThickness;
  }

  // Reflected radiance along R from world point origin. Falls back to the
  // procedural sky wherever the screen holds no information.
  vec3 ssrReflect(vec3 origin, vec3 R, vec3 fallback) {
    float t = 0.0;
    float stepLen = SSR_STEP0;
    float tPrev = 0.0;
    vec2 uv = vec2(0.0);
    bool hit = false;

    #ifdef SSR_BOUNDS_GATE
    // The capture depth holds only the knot: skip the whole march when the
    // reflected ray cannot intersect its bounding sphere (conservative
    // superset test -- rays that could hit still march). Grazing horizon
    // rays otherwise burn all SSR_STEPS on-screen and miss anyway; the
    // direction fallback below is exact for the sky/cloud content they
    // would have found.
    vec3 oc = origin - uReflectBound.xyz;
    float ob = dot(oc, R);
    float oc2 = dot(oc, oc) - uReflectBound.w * uReflectBound.w;
    bool mayHit = (ob * ob - oc2 > 0.0) && (ob < 0.0 || oc2 < 0.0);
    #else
    bool mayHit = true;
    #endif

    if (mayHit)
    for (int i = 0; i < SSR_STEPS; i++) {
      tPrev = t;
      t += stepLen;
      stepLen *= SSR_STEP_GROWTH;
      vec3 p = origin + R * t;
      float vz; bool ok;
      vec2 puv = ssrProject(p, vz, ok);
      if (!ok || !ssrOnScreen(puv)) break;
      if (ssrTest(p, uv)) { hit = true; break; }
    }

    if (hit) {
      // Binary refinement between the last miss and the hit.
      float lo = tPrev;
      float hi = t;
      for (int i = 0; i < SSR_REFINE; i++) {
        float mid = 0.5 * (lo + hi);
        vec2 muv;
        if (ssrTest(origin + R * mid, muv)) { hi = mid; uv = muv; } else { lo = mid; }
      }
      return mix(fallback, texture2D(uSceneColor, uv).rgb, ssrEdgeFade(uv));
    }

    // No geometry hit: if the ray direction lands on screen where sky (and
    // clouds) were drawn, use that pixel -- exact for direction-only content.
    float vz; bool ok;
    vec2 fuv = ssrProject(origin + R * 2000.0, vz, ok);
    if (ok && ssrOnScreen(fuv) && texture2D(uSceneDepth, fuv).r >= 0.99999) {
      return mix(fallback, texture2D(uSceneColor, fuv).rgb, ssrEdgeFade(fuv));
    }
    return fallback;
  }

  // Bicubic (B-spline) sample of the foam texture via 4 bilinear taps.
  // The FFT foam is accumulated per texel (~0.8 m); plain bilinear reads
  // leave fading patches as translucent slabs with straight texel edges,
  // which read as "mesh edges" up close. The cubic kernel removes the
  // plateaus without an extra blur pass.
  vec4 sampleFoamCubic(sampler2D tex, float size, vec2 uv) {
    vec2 texSize = vec2(size);
    vec2 p = uv * texSize - 0.5;
    vec2 f = fract(p);
    p -= f;
    vec2 f2 = f * f;
    vec2 f3 = f2 * f;
    vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
    vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
    vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
    vec2 w3 = f3 / 6.0;
    vec2 s0 = w0 + w1;
    vec2 s1 = w2 + w3;
    vec2 o0 = w1 / s0 - 1.0;
    vec2 o1 = w3 / s1 + 1.0;
    vec2 uv0 = (p + 0.5 + o0) / texSize;
    vec2 uv1 = (p + 0.5 + o1) / texSize;
    vec4 a = texture2D(tex, vec2(uv0.x, uv0.y));
    vec4 b = texture2D(tex, vec2(uv1.x, uv0.y));
    vec4 c = texture2D(tex, vec2(uv0.x, uv1.y));
    vec4 d = texture2D(tex, vec2(uv1.x, uv1.y));
    return (a * s0.x + b * s1.x) * s0.y + (c * s0.x + d * s1.x) * s1.y;
  }

  // Decode the tangent-space xy of the baked normal map (-1..1).
  vec2 detailNormalXY(vec2 uv) {
    return texture2D(uDetailTex, uv).rg * 2.0 - 1.0;
  }

  float cloudDirectTransmittance(vec3 worldPosition) {
    #ifdef CLOUD_SHADOWS
      vec2 uv = (worldPosition.xz - uCloudShadowCenter) / uCloudShadowExtent + 0.5;
      float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
      return mix(1.0, texture2D(tCloudShadow, uv).r, inside * uCloudShadowEnabled);
    #else
      return 1.0;
    #endif
  }

  float ggx(vec3 n, vec3 v, vec3 l, float rough) {
    vec3 hv = normalize(v + l);
    float a = max(rough * rough, 1e-4);
    float a2 = a * a;
    float ndh = max(dot(n, hv), 0.0);
    float d = ndh * ndh * (a2 - 1.0) + 1.0;
    return a2 / (3.14159265 * d * d);
  }

  void main() {
    vec3 viewDir = normalize(vWorldPos - cameraPosition);

    // Past uFogFar the fog mix below lands on the sky color exactly, so the
    // outermost rings -- horizon micro-triangles with worst-case quad
    // overshading -- skip the whole water shader. Seamless by construction.
    if (vDist > uFogFar) {
      gl_FragColor = vec4(skyColor(viewDir, uSunDirection, uZenithColor, uHorizonColor, uGroundColor, uSunColor), 1.0);
      #ifdef TAA_ENABLED
        taaMotion = taaPackMotion(vTaaCurrentClip, vTaaPreviousClip, 0.0);
      #endif
      return;
    }

    // Foam texture packs: x = accumulated foam, yzw = smooth water normal.
    vec4 F = sampleFoamCubic(uFoam, uFoamSize, vUv);
    vec3 N = normalize(F.yzw);
    float fftFoam = F.x;

    #ifdef OCEAN_CASCADE2
    // Beyond the fade the whole block is multiplied by exactly 0, so the 4
    // bicubic taps can be skipped (the fade is per-vertex, so the branch is
    // coherent across the far field).
    if (vFade2 > 0.001) {
      // Normals compose as slopes, not as vectors: recover (dh/dx, dh/dz)
      // from each unit normal, add them, rebuild. Averaging the normals
      // instead would flatten the total slope wherever they disagree.
      vec4 F2 = sampleFoamCubic(uFoam2, uFoamSize2, vUv2);
      vec3 N2 = normalize(F2.yzw);
      vec2 slope = -N.xz / max(N.y, 1e-3) - (N2.xz / max(N2.y, 1e-3)) * vFade2;
      N = normalize(vec3(-slope.x, 1.0, -slope.y));
      // Same max() convention foamRaw already uses for FFT vs contact foam.
      fftFoam = max(fftFoam, F2.x * vFade2);
    }
    #endif

    vec3 V = -viewDir;
    vec3 L = normalize(uSunDirection);
    // The shadow map modulates direct sun only. Sky reflection, the deep
    // ambient term and foam lift remain visible below clouds.
    float cloudShadow = cloudDirectTransmittance(vWorldPos);

    // Foam churn/bubbles: two slowly drifting samples of the lace texture.
    // Sampled before the normals so foam can flatten the ripple detail.
    vec2 dp = vWorldPos.xz;
    #ifdef OCEAN_DETAIL
    // Macro layer (large tile, slow pan): shared by the foam and the ripple
    // normals below. Breaks up tiling by domain-warping the finer lookups.
    vec2 nM = detailNormalXY((dp - uTime * uDetailMacroPan) * uDetailMacro.x);
    vec2 fwarp = nM * uFoamMacroWarp;
    // A second, even larger macro read gates the foam so lace density varies
    // across the sea instead of repeating with the churn tile.
    float foamGate = texture2D(uDetailTex, (dp.yx + uTime * vec2(0.03, 0.02)) * uDetailMacro.x * 0.55).b;
    vec2 cuvA = (dp + fwarp) * uFoamChurnScale + uTime * vec2(0.012, -0.02);
    vec2 cuvB = (dp - fwarp.yx) * uFoamChurnScale * 0.37 + uTime * vec2(-0.008, 0.006);
    vec4 churnA = texture2D(uDetailTex, cuvA);
    vec4 churnB = texture2D(uDetailTex, cuvB);
    float churn = clamp(0.65 * churnA.b + 0.45 * churnB.b, 0.0, 1.0);
    churn = clamp(churn * (0.55 + 0.9 * foamGate), 0.0, 1.0);
    float bubbles = churnA.a;
    #else
    // ?detail=0: skip the detail taps entirely (not just their strength)
    // so the A/B measures their real cost. Neutral mid values keep the
    // contact-foam erosion below usable.
    float churn = 0.5;
    float bubbles = 0.5;
    #endif

    // Foam mask: an erosion threshold through the churn pattern. Fresh foam
    // (F.x near 1) is solid; as the accumulated foam decays only the bright
    // lace filaments survive, so patches tear apart instead of fading as a
    // blob, and the 256^2 texel steps of F.x are broken up.
    #ifdef OCEAN_DETAIL
      float foamMask = smoothstep(0.0, uFoamEdge, fftFoam * 1.1 - (1.0 - churn) * 0.5);
      // Translucent, and thinner as the foam ages: coverage tracks the
      // accumulated value so patches dissolve gradually instead of cutting off.
      foamMask *= (0.6 + 0.4 * churn) * uFoamOpacity * smoothstep(0.0, 0.9, fftFoam);
    #else
      float foamMask = smoothstep(0.3, 0.8, fftFoam);
    #endif

    // --- Contact foam: water meeting captured geometry ------------------
    // View-space depth gap between this water fragment and whatever the
    // capture pass drew behind it (the knot). Water hidden by the knot is
    // depth-rejected, so only the visible skirt gets foam. The gap is a
    // slant range, not a water-column depth, so the skirt widens a little
    // at grazing angles (width is narrowed when looking down to compensate).
    float contact = 0.0;
    float contactFoam = 0.0;
    float gap = 1e3;
    if (uContact.y > 0.0 && vDist < 60.0) {
      vec2 suv = gl_FragCoord.xy * uInvResolution;
      float sd = texture2D(uSceneDepth, suv).r;
      if (sd < 0.99999) { // not sky
        float sceneZ = perspectiveDepthToViewZ(sd, uCameraNear, uCameraFar);
        float waterZ = (viewMatrix * vec4(vWorldPos, 1.0)).z;
        gap = max(waterZ - sceneZ, 0.0); // both negative; scene farther => positive
        float width = uContact.x * (0.6 + 0.4 * max(-viewDir.y, 0.0));
        contact = 1.0 - smoothstep(0.0, width, gap);
        // Slow breathing so the skirt reads as churn, not a static decal.
        contact *= 1.0 - uContact.w + uContact.w * (0.5 + 0.5 * sin(uTime * 2.6 + gap * 18.0 + churn * 6.0));
        // Erode through the churn lace like the FFT foam so it tears.
        contactFoam = smoothstep(0.0, uFoamEdge, contact * 1.3 - (1.0 - churn) * 0.5);
        contactFoam *= (0.6 + 0.4 * churn) * uContact.y;
      }
    }
    // foamRaw drives roughness / specular kill / detail damping;
    // foamAmount is the visible foam coverage.
    float foamRaw = max(fftFoam, contact);
    float foamAmount = max(foamMask, contactFoam);

    // Ripple detail normals: the baked normal map at two scales, each
    // panning at its own world-space velocity (a static normal on moving
    // water reads as a decal), summed and tilted into world XZ. The mip chain keeps the far
    // field clean, so only a gentle fade guards the horizon roughness.
    //
    // The macro layer domain-warps both lookups so their tiling never lines
    // up. The offset is in *cycles of each layer's own tiling*, not world
    // units: a fixed world offset shifts the 1.8 cyc/m layer four times
    // further in phase than the 0.45 one, which shears the fine layer into
    // filaments and reads as marbled oil rather than water.
    #ifdef OCEAN_DETAIL
    vec2 warp = nM * uDetailMacro.z;
    vec2 nA = detailNormalXY((dp - uTime * uDetailPan.xy) * uDetailScale.x + warp);
    vec2 nB = detailNormalXY((dp - uTime * uDetailPan.zw) * uDetailScale.y - warp.yx);
    // The macro map also modulates fine amplitude so ripple density varies
    // in patches instead of being uniform everywhere. Shallow on purpose:
    // deep modulation carves the surface into slick-looking patches.
    float patchAmp = 0.85 + 0.3 * nM.x;
    vec2 nD = (nA + nB * 0.7) * patchAmp + nM * uDetailMacro.y;
    float detailAmp = uDetailStrength * exp(-vDist * 0.01) * (1.0 - 0.7 * foamRaw);
    // Inside foam, tilt along the churn pattern instead so foam reads as a
    // churned surface catching the sun rather than a flat decal.
    vec2 nF = detailNormalXY(cuvA);
    // Ring ripples radiating from the contact line.
    nD += nF * uContact.z * contact * sin(gap * 30.0 - uTime * 4.0);
    nD = mix(nD * detailAmp, nF * uFoamBump * uDetailStrength, foamAmount);
    N = normalize(N + vec3(nD.x, 0.0, nD.y));
    #endif

    float NdV = max(dot(N, V), 0.0);

    // Fresnel (Schlick, water F0).
    float fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);

    // Procedural sky reflection: same gradient function as the sky dome, so
    // reflection and dome can never drift apart.
    vec3 R = reflect(viewDir, N);
    R.y = abs(R.y) + 0.02; // never reflect from below the horizon
    R = normalize(R);
    vec3 skyRef = skyColor(R, uSunDirection, uZenithColor, uHorizonColor, uGroundColor, uSunColor);
    // Screen-space reflection of the captured scene (knot, clouds, sky),
    // falling back to the procedural sky off-screen. Faded with distance:
    // far water is fog-dominated and the march is wasted there.
    #ifndef SSR_DISABLED
    float ssrWeight = 1.0 - smoothstep(60.0, 140.0, vDist);
    if (ssrWeight > 0.001) {
      skyRef = mix(skyRef, ssrReflect(vWorldPos + N * 0.02, R, skyRef), ssrWeight);
    }
    #endif

    // --- Boosted sub-surface scattering --------------------------------
    // Light transmission through backlit crests (Barre-Brisebois): light
    // enters the far side of the crest along -L, is bent by the normal, and
    // exits toward the eye. So the eye vector V must align with the
    // *transmitted* direction -Lt, i.e. viewDir (eye -> surface) aligns
    // with +Lt. Biased by crest height, killed by Fresnel (only where not
    // mirroring).
    //
    // The sun sits well above the horizon, so the literal transmitted ray
    // -L points down into the water and an above-water eye can never line
    // up with it. Treat the crest as a thin vertical lens instead: take the
    // backlight from the sun's horizontal bearing (elevation only scales
    // it), which is the usual trick for water SSS.
    vec3 Lh = normalize(vec3(L.x, 0.0, L.z));
    vec3 Lt = normalize(Lh + N * uSSSDistort);
    float through = pow(max(dot(viewDir, Lt), 0.0), uSSSPower);
    float crest = smoothstep(-0.25, 0.9, vHeight);
    float sss = through * crest * (1.0 - fres) * uSSSStrength;

    // --- Composite -------------------------------------------------------
    float ndl = max(dot(N, L), 0.0);
    vec3 col = uDeepColor * (0.45 + 0.55 * ndl * cloudShadow);
    // Through-light is mostly direct, but retaining a small floor avoids a
    // hard cut in translucent crests at shadow-map texel boundaries.
    col += uSSSColor * sss * mix(0.25, 1.0, cloudShadow);
    col += skyRef * fres;

    // Dual-lobe sun specular: sharp glitter + broad sheen.
    float rough = mix(uRoughness, 0.45, foamRaw * 0.8);
    float spec = ggx(N, V, L, rough) + 0.18 * ggx(N, V, L, rough + 0.32);
    col += uSunColor * spec * ndl * cloudShadow * 0.16 * (1.0 - foamRaw);

    // Foam: warm-white, kills specular, soaks up SSS.
    vec3 foamCol = mix(vec3(0.97, 0.98, 1.0), uSunColor, 0.2) * (0.82 + 0.2 * ndl);
    foamCol *= 0.78 + 0.22 * bubbles;
    col = mix(col, foamCol, foamAmount);

    // Distance fog into the exact sky color along this view ray -> the
    // horizon dissolves seamlessly into the sky dome. Near-field fragments
    // (vDist < uFogNear) skip the second skyColor evaluation entirely.
    float fog = smoothstep(uFogNear, uFogFar, vDist);
    if (fog > 0.001) {
      col = mix(col, skyColor(viewDir, uSunDirection, uZenithColor, uHorizonColor, uGroundColor, uSunColor), fog);
    }

    // Linear output: color space and tone mapping are applied once by the
    // post pipeline (post.js).
    gl_FragColor = vec4(col, 1.0);
    #ifdef TAA_ENABLED
      // Geometry motion handles the wave surface itself. Foam, contact churn,
      // and sharp changing glints are less predictable, so they shorten the
      // history rather than leaving bright trails.
      float taaReactive = clamp(foamAmount * 0.8 + contactFoam * 0.5
                              + smoothstep(0.4, 2.0, spec) * 0.35, 0.0, 1.0);
      taaMotion = taaPackMotion(vTaaCurrentClip, vTaaPreviousClip, taaReactive);
    #endif
  }
`;

// --- Factory ----------------------------------------------------------------
// Returns { mesh, uniforms, update(dt, t), sampleSwell, fft }.
export function createOcean(scene, skyUniforms, renderer, opts = {}) {
  const o = { ...OCEAN_DEFAULTS, ...opts };
  const taa = opts.taa ?? null;
  const taaConfig = taaMaterialConfig(taa);
  const detail = opts.detail ?? oceanDetailEnabled();
  const cascade2 = opts.cascade2 ?? oceanCascade2Enabled();

  // Cascade bands. The boundary is Unity's rule from gasgiant/FFT-Ocean:
  // the fine cascade owns everything from its 6th harmonic up, the coarse
  // one everything below. Without the split the two would synthesize the
  // overlapping wavenumbers twice and the sea would read twice as rough.
  const boundary = ((2 * Math.PI) / o.CASCADE2_PATCH) * o.CASCADE2_BAND;
  const coarse = {
    size: opts.size ?? 256,
    // The band limit already removes what a 0.78 m texel cannot resolve, so
    // the small-wave cutoff can drop to the fine cascade's value and the
    // spectrum stays continuous across the boundary.
    ...(cascade2 ? { cutoffHigh: boundary, smallWaveCutoff: o.CASCADE2_CUTOFF } : {}),
  };
  const fine = {
    size: o.CASCADE2_SIZE,
    patchSize: o.CASCADE2_PATCH,
    cutoffLow: boundary,
    smallWaveCutoff: o.CASCADE2_CUTOFF,
    choppy: o.CASCADE2_CHOPPY,
  };
  // One scale over both cascades: their variances sum, so normalizing each
  // on its own would raise the sea every time a cascade is added. This is
  // what keeps heightRms honest (and independent of `size`).
  const ampScale = cascade2
    ? cascadeAmpScale([coarse, fine], opts.heightRms ?? OCEAN_FFT_DEFAULTS.heightRms)
    : null;

  const fft = createOceanFft(renderer, { ...coarse, ampScale });
  const fft2 = cascade2 ? createOceanFft(renderer, { ...fine, ampScale }) : null;

  const uniforms = {
    // FFT pipeline outputs (rebound every frame; the pipeline ping-pongs).
    uDisplace: { value: null },
    uPreviousDisplace: { value: null },
    uFoam: { value: null },

    // Shared with the sky: same uniform *objects*, not copies.
    uSunDirection: skyUniforms.uSunDirection,
    uSunColor: skyUniforms.uSunColor,
    uZenithColor: skyUniforms.uZenithColor,
    uHorizonColor: skyUniforms.uHorizonColor,
    uGroundColor: skyUniforms.uGroundColor,

    uPatchSize: { value: fft.params.patchSize },
    uFoamSize: { value: fft.params.size },
    ...(fft2
      ? {
          uDisplace2: { value: null },
          uPreviousDisplace2: { value: null },
          uFoam2: { value: null },
          uPatchSize2: { value: fft2.params.patchSize },
          uFoamSize2: { value: fft2.params.size },
          uCascade2Fade: { value: new THREE.Vector2(...o.CASCADE2_FADE) },
        }
      : {}),
    uDeepColor: { value: new THREE.Color(OCEAN_DEFAULTS.DEEP_COLOR) },
    uSSSColor: { value: new THREE.Color(OCEAN_DEFAULTS.SSS_COLOR) },
    uSSSStrength: { value: OCEAN_DEFAULTS.SSS_STRENGTH },
    uSSSPower: { value: OCEAN_DEFAULTS.SSS_POWER },
    uSSSDistort: { value: OCEAN_DEFAULTS.SSS_DISTORT },
    uRoughness: { value: OCEAN_DEFAULTS.ROUGHNESS },
    uTime: { value: 0 },
    uFogNear: { value: OCEAN_DEFAULTS.FOG_NEAR },
    uFogFar: { value: OCEAN_DEFAULTS.FOG_FAR },

    // Baked procedural detail texture (ripple normals + foam churn).
    uDetailTex: {
      value: createOceanDetailTexture(renderer, o.DETAIL_TEX_SIZE, {
        fold: o.DETAIL_FOLD,
        gain: o.DETAIL_GAIN,
        octaves: o.DETAIL_OCTAVES,
      }),
    },
    uDetailScale: { value: new THREE.Vector2(...o.DETAIL_SCALE) },
    uDetailStrength: { value: detail ? o.DETAIL_STRENGTH : 0 },
    uDetailPan: { value: new THREE.Vector4(...o.DETAIL_PAN) },
    uDetailMacro: { value: new THREE.Vector4(o.DETAIL_MACRO_SCALE, o.DETAIL_MACRO_STRENGTH, o.DETAIL_MACRO_WARP, 0) },
    uDetailMacroPan: { value: new THREE.Vector2(...o.DETAIL_MACRO_PAN) },
    uFoamChurnScale: { value: o.FOAM_CHURN_SCALE },
    uFoamEdge: { value: o.FOAM_EDGE },
    uFoamOpacity: { value: o.FOAM_OPACITY },
    uFoamMacroWarp: { value: o.FOAM_MACRO_WARP },
    uFoamBump: { value: o.FOAM_BUMP },

    // Bound by createSceneCapture every frame.
    uSceneColor: { value: null },
    uSceneDepth: { value: null },
    uProjection: { value: new THREE.Matrix4() },
    uCameraNear: { value: 0.1 },
    uCameraFar: { value: 500 },
    uSsrThickness: { value: OCEAN_DEFAULTS.SSR_THICKNESS },
    uSsrEdgeFade: { value: OCEAN_DEFAULTS.SSR_EDGE_FADE },
    // Knot bounding sphere for the SSR march gate; main.js updates it every
    // frame from the knot's position and geometry bounding sphere.
    uReflectBound: { value: new THREE.Vector4(0, 1, 0, 2.5) },
    // Baked sky-grade LUT, shared with the sky (same uniform object).
    ...(skyUniforms.uGradeLUT ? { uGradeLUT: skyUniforms.uGradeLUT } : {}),
    uContact: {
      value: new THREE.Vector4(
        o.CONTACT_WIDTH,
        (opts.contact ?? oceanContactEnabled()) ? o.CONTACT_STRENGTH : 0,
        o.CONTACT_RIPPLE,
        o.CONTACT_PULSE
      ),
    },
    uInvResolution: { value: new THREE.Vector2(1, 1) },
    ...(opts.cloudShadow ?? {}),
    ...taaConfig.uniforms,
  };

  const mesh = new THREE.Mesh(
    buildDiscGeometry(
      OCEAN_DEFAULTS.DISC_RINGS,
      OCEAN_DEFAULTS.DISC_SECTORS,
      OCEAN_DEFAULTS.DISC_RMIN,
      OCEAN_DEFAULTS.DISC_RADIUS
    ),
    new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      glslVersion: taaConfig.glslVersion,
      defines: {
        SSR_STEPS: String(o.SSR_STEPS),
        SSR_REFINE: String(o.SSR_REFINE),
        SSR_STEP0: o.SSR_STEP0.toFixed(3),
        SSR_STEP_GROWTH: o.SSR_STEP_GROWTH.toFixed(3),
        ...(detail ? { OCEAN_DETAIL: "" } : {}),
        ...(fft2 ? { OCEAN_CASCADE2: "" } : {}),
        ...(ssrMode() === "gate" ? { SSR_BOUNDS_GATE: "" } : {}),
        ...(ssrMode() === "off" ? { SSR_DISABLED: "" } : {}),
        ...(skyUniforms.uGradeLUT ? { SKY_GRADE_LUT: "" } : {}),
        ...(opts.cloudShadow ? { CLOUD_SHADOWS: "" } : {}),
        ...taaConfig.defines,
      },
    })
  );
  mesh.frustumCulled = false;
  // The ocean lives on its own layer (as well as the default one) so the
  // capture pass can draw it alone after the blit.
  mesh.layers.enable(OCEAN_LAYER);
  scene.add(mesh);

  return {
    mesh,
    uniforms,
    params: { ...OCEAN_DEFAULTS, ...fft.params },
    fft,
    fft2,
    update(dt, t) {
      fft.update(dt, t);
      uniforms.uDisplace.value = fft.displacementTexture();
      uniforms.uPreviousDisplace.value = fft.previousDisplacementTexture();
      uniforms.uFoam.value = fft.foamTexture();
      if (fft2) {
        fft2.update(dt, t);
        uniforms.uDisplace2.value = fft2.displacementTexture();
        uniforms.uPreviousDisplace2.value = fft2.previousDisplacementTexture();
        uniforms.uFoam2.value = fft2.foamTexture();
      }
      uniforms.uTime.value = t;
    },
    sampleSwell,
  };
}

// --- Scene capture for screen-space reflections ------------------------------
// Frame = two passes:
//   1. everything except the ocean -> color (half-float, linear) + depth RT
//   2. blit that RT into the HDR frame target (color AND depth, via
//      gl_FragDepth), then draw only the ocean on top, depth-tested against
//      the blitted depth.
// The ocean shader samples the RT for reflections and for the contact-foam
// depth gap. Nothing is rendered twice (the cloud raymarch in particular),
// and the ocean still gets correct occlusion by the knot. Everything stays
// linear; post.js tone-maps and encodes once at the end.
// `cloudPass` (clouds.js, offscreen mode) is composited into the capture
// target right after pass 1, so the blit, the SSR color fallback and the
// frame all see clouds exactly where the in-scene dome used to draw them.
export function createSceneCapture(renderer, camera, ocean, cloudPass = null, taa = null) {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const makeTarget = (w, h) => {
    const depthTexture = new THREE.DepthTexture(w, h, THREE.FloatType);
    return new THREE.WebGLRenderTarget(w, h, {
      ...(taa?.enabled ? { count: 2 } : {}),
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthTexture,
      depthBuffer: true,
      stencilBuffer: false,
      // TAA replaces capture MSAA by default. ?taa=0 restores the exact old
      // 4x capture path for fallback and A/B comparisons.
      samples: taa?.enabled ? 0 : CAPTURE_SAMPLES,
    });
  };
  let target = makeTarget(size.x, size.y);

  const blitScene = new THREE.Scene();
  const blitCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const blitMaterial = new THREE.ShaderMaterial({
    uniforms: {
      tColor: { value: null },
      tDepth: { value: null },
      ...(taa?.enabled ? { tMotion: { value: null } } : {}),
    },
    glslVersion: taa?.enabled ? THREE.GLSL3 : null,
    depthTest: true,
    depthWrite: true,
    depthFunc: THREE.AlwaysDepth,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D tColor;
      uniform sampler2D tDepth;
      #ifdef TAA_ENABLED
      uniform sampler2D tMotion;
      #endif
      varying vec2 vUv;
      ${TAA_FRAGMENT_GLSL}
      void main() {
        // RT-to-RT copy: stays linear (post.js converts once at the end).
        gl_FragColor = vec4(texture2D(tColor, vUv).rgb, 1.0);
        #ifdef TAA_ENABLED
        taaMotion = texture2D(tMotion, vUv);
        #endif
        gl_FragDepthEXT = texture2D(tDepth, vUv).r;
      }
    `,
    defines: taa?.enabled ? { TAA_ENABLED: "" } : {},
  });
  const blitQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blitMaterial);
  blitQuad.frustumCulled = false;
  blitScene.add(blitQuad);

  const u = ocean.uniforms;

  return {
    get target() { return target; },
    resize() {
      renderer.getDrawingBufferSize(size);
      target.dispose();
      target = makeTarget(size.x, size.y);
    },
    // `frame` is the linear HDR target the finished frame accumulates into
    // (post.js); the blit + ocean pass draws there instead of the screen.
    render(scene, frame) {
      // Pass 1: scene minus ocean into the capture target.
      ocean.mesh.visible = false;
      renderer.setRenderTarget(target);
      renderer.clear();
      renderer.render(scene, camera);

      // Composite the low-res cloud color and motion over the sky. This is
      // an MRT in TAA mode and the old MSAA color target under ?taa=0.
      if (cloudPass) cloudPass.composite(renderer);

      // Pass 2: blit (color + depth) into the frame, then the ocean only.
      renderer.setRenderTarget(frame);
      blitMaterial.uniforms.tColor.value = target.texture;
      blitMaterial.uniforms.tDepth.value = target.depthTexture;
      if (taa?.enabled) blitMaterial.uniforms.tMotion.value = target.textures[1];
      const prevAutoClear = renderer.autoClear;
      renderer.autoClear = false;
      renderer.clear();
      renderer.render(blitScene, blitCamera);

      u.uSceneColor.value = target.texture;
      u.uSceneDepth.value = target.depthTexture;
      u.uProjection.value.copy(camera.projectionMatrix);
      u.uCameraNear.value = camera.near;
      u.uCameraFar.value = camera.far;
      u.uInvResolution.value.set(1 / size.x, 1 / size.y);

      // A Color scene.background makes three.js force-clear even with
      // autoClear off, which would wipe the blit -- drop it for this pass.
      ocean.mesh.visible = true;
      const prevLayers = camera.layers.mask;
      const prevBackground = scene.background;
      scene.background = null;
      camera.layers.set(OCEAN_LAYER);
      renderer.render(scene, camera);
      scene.background = prevBackground;
      camera.layers.mask = prevLayers;
      renderer.autoClear = prevAutoClear;
    },
  };
}
