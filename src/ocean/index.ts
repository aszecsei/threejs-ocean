import * as THREE from "three";
import { buildOceanFft, bakeCascadeAmpScale, OCEAN_FFT_DEFAULTS } from "./fft/index.js";
import { SKY_COLOR_GLSL } from "../sky/index.js";
import { bakeOceanDetailTexture } from "./detail-texture.js";
import { band, drain } from "../loading/scheduler.js";
import type { Bake } from "../loading/types.js";
import { taaMaterialConfig, type TaaApi } from "../taa/index.js";
import type { CloudPass } from "../clouds/index.js";
import type { Uniform } from "../core/types.js";
import * as flags from "../flags.js";
import OCEAN_VERT from "./shaders/ocean.vert.glsl";
import OCEAN_UNIFORMS from "./shaders/ocean.uniforms.glsl";
import OCEAN_MAIN from "./shaders/ocean.main.glsl";
import CAPTURE_BLIT_VERT from "./shaders/capture-blit.vert.glsl";
import CAPTURE_BLIT_FRAG from "./shaders/capture-blit.frag.glsl";

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
export function oceanEnabled() { return flags.enabled("ocean"); }

// `?detail=0` drops the procedural detail texture (flat FFT normals + plain
// foam blob) for A/B comparison.
export function oceanDetailEnabled() { return flags.enabled("detail"); }

// `?contact=0` drops the contact foam around the knot for A/B comparison.
export function oceanContactEnabled() { return flags.enabled("contact"); }

// `?cascade2=0` drops the fine FFT cascade (A/B for the second cascade).
export function oceanCascade2Enabled() {
  // Note: unlike the other toggles this one accepts only "0", not "false".
  return !flags.is("cascade2", "0");
}

// `?ssr=0` drops screen-space reflections entirely; `?ssr=full` marches every
// near-water ray (disables the knot-bounds gate, the pre-gate behavior).
// Default: march only rays that can hit the knot's bounding sphere -- the
// knot is the only geometry in the capture depth buffer, so everything else
// already resolves through the sky/cloud direction fallback.
export function ssrMode() {
  if (!flags.enabled("ssr")) return "off";
  return flags.is("ssr", "full") ? "full" : "gate";
}

export function oceanSize() {
  const n = flags.int("ocean-n", 256);
  return [128, 256, 512].includes(n) ? n : 256;
}

// --- Geometry: exponential radial disc --------------------------------------
// Ring 0 is the center point (under the camera); rings 1..rings grow
// exponentially from rMin to rMax, so vertex density is high near the camera
// (where detail matters) and falls off toward the fog-obscured horizon. The
// mesh is never rotated and snaps to the camera XZ every frame, while the
// wave sampling stays world-anchored.
function* bakeDiscGeometry(
  rings: number,
  sectors: number,
  rMin: number,
  rMax: number,
  label = "Ocean surface"
): Bake<THREE.BufferGeometry> {
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
    if ((i & 31) === 31) yield { label, detail: `ring ${i + 1}/${rings}`, fraction: 0.4 * (i / rings) };
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
    if ((i & 31) === 31) yield { label, detail: `triangulating ${i + 1}/${rings}`, fraction: 0.4 + 0.6 * (i / rings) };
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

export function sampleSwell(x: number, z: number, t: number): { h: number; gx: number; gz: number } {
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

const VERTEX_SHADER = OCEAN_VERT;

const FRAGMENT_SHADER = [OCEAN_UNIFORMS, SKY_COLOR_GLSL, OCEAN_MAIN].join("\n");

// --- Factory ----------------------------------------------------------------
// Returns { mesh, uniforms, update(dt, t), sampleSwell, fft }.
/** Caller overrides for {@link createOcean}. */
export interface OceanOptions extends Partial<typeof OCEAN_DEFAULTS> {
  size?: number;
  taa?: TaaApi | null;
  /** Procedural detail texture; defaults to the ?detail flag. */
  detail?: boolean;
  /** Second (fine) FFT cascade; defaults to the ?cascade2 flag. */
  cascade2?: boolean;
  /** Contact foam; defaults to the ?contact flag. */
  contact?: boolean;
  heightRms?: number;
  /** Cloud shadow uniforms, shared by identity with the cloud rig. */
  cloudShadow?: Record<string, Uniform<unknown>> | null;
  /**
   * Water medium uniforms, shared by identity with the underwater rig. Their
   * presence is what turns on the surface's underside branch -- and what
   * makes the mesh double-sided, since from below every triangle is a back
   * face and would otherwise be culled.
   */
  water?: Record<string, Uniform<unknown>> | null;
  /** Per-channel refraction through Snell's window. Defaults to on. */
  dispersion?: boolean;
}

// The resumable form. The FFT cascades, the 512² detail bake and the ~61k-vert
// disc are the three blocks worth watching; they are laid out end to end across
// this bake's 0..1 range.
export function* buildOcean(
  scene: THREE.Scene,
  skyUniforms: Record<string, Uniform<unknown>>,
  renderer: THREE.WebGLRenderer,
  opts: OceanOptions = {}
) {
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
    ? yield* band(
        bakeCascadeAmpScale([coarse, fine], opts.heightRms ?? OCEAN_FFT_DEFAULTS.heightRms, "Wave spectrum"),
        "Wave spectrum", 0, 0.15)
    : null;

  const fft = yield* band(buildOceanFft(renderer, { ...coarse, ampScale }, "Wave cascade"), "Wave cascade", 0.15, 0.45);
  const fft2 = cascade2
    ? yield* band(buildOceanFft(renderer, { ...fine, ampScale }, "Wave cascade (fine)"), "Wave cascade (fine)", 0.45, 0.6)
    : null;

  const uniforms = {
    // FFT pipeline outputs (rebound every frame; the pipeline ping-pongs).
    uDisplace: { value: null as THREE.Texture | null },
    uPreviousDisplace: { value: null as THREE.Texture | null },
    uFoam: { value: null as THREE.Texture | null },

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
          uDisplace2: { value: null as THREE.Texture | null },
          uPreviousDisplace2: { value: null as THREE.Texture | null },
          uFoam2: { value: null as THREE.Texture | null },
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
      value: yield* band(
        bakeOceanDetailTexture(renderer, o.DETAIL_TEX_SIZE, {
          fold: o.DETAIL_FOLD,
          gain: o.DETAIL_GAIN,
          octaves: o.DETAIL_OCTAVES,
        }),
        "Ocean detail texture", 0.6, 0.9),
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
    uSceneColor: { value: null as THREE.Texture | null },
    uSceneDepth: { value: null as THREE.Texture | null },
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
    ...(opts.water ?? {}),
    ...taaConfig.uniforms,
  };

  const discGeometry = yield* band(
    bakeDiscGeometry(
      OCEAN_DEFAULTS.DISC_RINGS,
      OCEAN_DEFAULTS.DISC_SECTORS,
      OCEAN_DEFAULTS.DISC_RMIN,
      OCEAN_DEFAULTS.DISC_RADIUS
    ),
    "Ocean surface", 0.9, 1);

  const mesh = new THREE.Mesh(
    discGeometry,
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
        ...(opts.water ? { UNDERWATER: "" } : {}),
        ...(opts.water && (opts.dispersion ?? true) ? { OCEAN_DISPERSION: "" } : {}),
        ...taaConfig.defines,
      },
      // Backface culling is what makes the sea vanish from below, so the
      // underside branch and DoubleSide arrive together or not at all.
      side: opts.water ? THREE.DoubleSide : THREE.FrontSide,
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
    update(dt: number, t: number) {
      fft.update(dt, t);
      uniforms.uDisplace.value = fft.displacementTexture();
      uniforms.uPreviousDisplace.value = fft.previousDisplacementTexture();
      uniforms.uFoam.value = fft.foamTexture();
      if (fft2) {
        fft2.update(dt, t);
        uniforms.uDisplace2!.value = fft2.displacementTexture();
        uniforms.uPreviousDisplace2!.value = fft2.previousDisplacementTexture();
        uniforms.uFoam2!.value = fft2.foamTexture();
      }
      uniforms.uTime.value = t;
    },
    sampleSwell,
  };
}

/** Builds the ocean rig in one blocking task. See {@link buildOcean}. */
export function createOcean(
  scene: THREE.Scene,
  skyUniforms: Record<string, Uniform<unknown>>,
  renderer: THREE.WebGLRenderer,
  opts: OceanOptions = {}
) {
  return drain(buildOcean(scene, skyUniforms, renderer, opts));
}

/** The ocean rig returned by {@link createOcean}. */
export type OceanRig = ReturnType<typeof createOcean>;

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
export function createSceneCapture(
  renderer: THREE.WebGLRenderer,
  camera: THREE.PerspectiveCamera,
  ocean: OceanRig,
  cloudPass: CloudPass | null = null,
  taa: TaaApi | null = null
) {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const makeTarget = (w: number, h: number) => {
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
      tColor: { value: null as THREE.Texture | null },
      tDepth: { value: null as THREE.Texture | null },
      ...(taa?.enabled ? { tMotion: { value: null as THREE.Texture | null } } : {}),
    },
    glslVersion: taa?.enabled ? THREE.GLSL3 : null,
    depthTest: true,
    depthWrite: true,
    depthFunc: THREE.AlwaysDepth,
    vertexShader: CAPTURE_BLIT_VERT,
    fragmentShader: CAPTURE_BLIT_FRAG,
    defines: taa?.enabled ? { TAA_ENABLED: "" } : {},
  });
  const blitQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blitMaterial);
  blitQuad.frustumCulled = false;
  blitScene.add(blitQuad);

  const u = ocean.uniforms;

  return {
    get target() { return target; },
    // Always present -- makeTarget constructs one -- but three types the field
    // as nullable, so the assertion lives here rather than at every reader.
    get depthTexture() { return target.depthTexture!; },
    resize() {
      renderer.getDrawingBufferSize(size);
      target.dispose();
      target = makeTarget(size.x, size.y);
    },
    // `frame` is the linear HDR target the finished frame accumulates into
    // (post.js); the blit + ocean pass draws there instead of the screen.
    render(scene: THREE.Scene, frame: THREE.WebGLRenderTarget) {
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

/** The scene-capture pass returned by {@link createSceneCapture}. */
export type SceneCapture = ReturnType<typeof createSceneCapture>;
