import * as THREE from "three";
import * as flags from "../../flags.js";
import type { Uniform } from "../../core/types.js";

// --- The water body as a participating medium --------------------------------
// Everything below the surface -- the fog, the surface's own underside, the
// sun shafts and the scene lights -- reads its optics from one medium rig, so
// they cannot describe different water. The uniform *objects* are shared by
// identity (the same trick sky/clouds/ocean already use), which is why this is
// built before the ocean rather than inside it.
//
// The model is Monzon et al., CEIG 2023 (docs/TFM_underwater_rendering...):
// in-scattering split into a closed-form multiple-scattering term driven by the
// oceanographic diffuse-downwelling coefficient Kd, plus a marched single-
// scattering term for the sun shafts. See shaders/scatter.glsl.

/** Absorption, scattering and diffuse-downwelling coefficients, per metre. */
export interface WaterType {
  /** Absorption sigma_a, RGB, m^-1. */
  sigmaA: readonly [number, number, number];
  /** Scattering sigma_s, RGB, m^-1. */
  sigmaS: readonly [number, number, number];
  /** Diffuse downwelling attenuation Kd, RGB, m^-1. */
  kd: readonly [number, number, number];
}

// Indicative wideband values in the Jerlov I-3C range -- the average of the
// spectral coefficients over [600,700] / [500,600] / [400,500] nm. They are
// tuning starting points, not transcriptions; the model is what the papers
// pin down. Papadopoulos' single scalar gamma = 0.13 m^-1 is the sanity
// anchor: every preset here brackets it in green.
export const WATER_TYPES = {
  // Jerlov I: clearest open ocean, and the deepest blue. Very little
  // scattering, so the surface stays sharp from a long way down.
  I: {
    sigmaA: [0.42, 0.065, 0.019],
    sigmaS: [0.006, 0.008, 0.010],
    kd: [0.35, 0.055, 0.030],
  },
  // Jerlov I-II: clear open ocean, the default. Red is gone by ~5 m, blue
  // carries 30. The scattering coefficient is what sets how much haze the
  // volume puts in front of the surface -- push it up and the ceiling washes
  // out long before visibility becomes the limit.
  II: {
    sigmaA: [0.44, 0.080, 0.035],
    sigmaS: [0.012, 0.016, 0.020],
    kd: [0.37, 0.080, 0.050],
  },
  // Jerlov 3C: coastal and turbid. ~5 m of visibility, heavily scattering.
  "3C": {
    sigmaA: [0.55, 0.18, 0.30],
    sigmaS: [0.35, 0.40, 0.42],
    kd: [0.60, 0.25, 0.42],
  },
} as const satisfies Record<string, WaterType>;

export type WaterTypeName = keyof typeof WATER_TYPES;

export const WATER_DEFAULTS = {
  /** Refractive index of water. The critical angle it implies is ~48.6 deg. */
  IOR: 1.333,
  /** Henyey-Greenstein anisotropy for the shafts. Ocean particulates are
   *  strongly forward-scattering (Petzold is ~0.92); 0.7 is the usual
   *  real-time compromise -- tight enough to beam, wide enough to fill. */
  PHASE_G: 0.7,
  // E_D0 is an *irradiance* -- the sky's radiance integrated over the
  // hemisphere -- while uSunColor and uZenithColor are radiances near 1. The
  // gap between the two is most of what these two scales are for. Calibrated
  // so that horizontal sight at the surface, sigma_s*E_D0/(4pi*sigma_t),
  // lands near the above-water body colour uDeepColor; deeper water then
  // falls away from there on Kd alone.
  /** Scale on the sun's contribution to the downwelling irradiance E_D0. */
  SUN_IRRADIANCE: 12.0,
  /** Scale on the sky's contribution to E_D0. Also what keeps deep water
   *  from going black when the sun is near the horizon. */
  SKY_IRRADIANCE: 3.5,
  /** Mean water level. The FFT field oscillates around it. */
  LEVEL: 0.0,
};

/** `?water=I|II|3C` selects the medium; default is clear open ocean. */
export function waterTypeName(): WaterTypeName {
  return flags.oneOf("water", ["I", "II", "3C"] as const, "II");
}

/** Fresnel reflectance at an air/water interface, Schlick, for cos(theta). */
export function waterFresnel(cosTheta: number): number {
  const c = Math.min(Math.max(cosTheta, 0), 1);
  return 0.02 + 0.98 * Math.pow(1 - c, 5);
}

/**
 * The sun's direction once it has crossed the surface, for a flat mean
 * surface. Snell bends it toward the vertical, so it is noticeably steeper
 * than the sun itself -- which is why the shafts are steeper than the sky
 * would suggest. `sunDir` points from the surface toward the sun.
 */
export function refractSun(sunDir: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
  const eta = 1 / WATER_DEFAULTS.IOR;
  // GLSL refract(I, N, eta) with I the downward incident ray -sunDir and
  // N = +Y. Clamped away from a sun exactly on the horizon, where the
  // transmitted ray is grazing and the whole term is dark anyway.
  const d = -Math.max(sunDir.y, 1e-3); // dot(N, I), negative
  const k = 1 - eta * eta * (1 - d * d);
  // k < 0 is total internal reflection, which air -> water cannot produce.
  const s = eta * d + Math.sqrt(Math.max(k, 0));
  return out
    .set(eta * -sunDir.x, eta * -sunDir.y - s, eta * -sunDir.z)
    .normalize();
}

export interface WaterMediumOptions extends Partial<typeof WATER_DEFAULTS> {
  /** Medium preset; defaults to the `?water` flag. */
  type?: WaterTypeName;
}

/**
 * The shared medium. `uniforms` goes into every material that needs to know
 * what the water is made of; `update` refreshes the per-frame terms from the
 * sky's own (identity-shared) sun uniforms.
 */
export function createWaterMedium(
  skyUniforms: Record<string, Uniform<unknown>>,
  opts: WaterMediumOptions = {}
) {
  const o = { ...WATER_DEFAULTS, ...opts };
  const name = opts.type ?? waterTypeName();
  const type: WaterType = WATER_TYPES[name];

  const sigmaS = new THREE.Vector3(...type.sigmaS);
  const sigmaT = new THREE.Vector3(
    type.sigmaA[0] + type.sigmaS[0],
    type.sigmaA[1] + type.sigmaS[1],
    type.sigmaA[2] + type.sigmaS[2]
  );
  const kd = new THREE.Vector3(...type.kd);

  const sunDirection = skyUniforms.uSunDirection as Uniform<THREE.Vector3>;
  const sunColor = skyUniforms.uSunColor as Uniform<THREE.Color>;
  const zenithColor = skyUniforms.uZenithColor as Uniform<THREE.Color>;

  const uniforms = {
    // Shared with the sky by identity, exactly as the ocean does it.
    uSunDirection: skyUniforms.uSunDirection,
    uSunColor: skyUniforms.uSunColor,

    uWaterIor: { value: o.IOR },
    uWaterSigmaS: { value: sigmaS },
    uWaterSigmaT: { value: sigmaT },
    uWaterKd: { value: kd },
    uWaterLevel: { value: o.LEVEL },
    uWaterPhaseG: { value: o.PHASE_G },
    /** Depth of the camera below the mean surface; 0 when above it. */
    uWaterCameraDepth: { value: 0 },
    /** Sun direction below the surface (points downward). */
    uWaterSunDirection: { value: new THREE.Vector3(0, -1, 0) },
    /** E_D0: total downwelling irradiance just under the surface, sun and
     *  sky together. Drives the multiple-scattering term and the ambient. */
    uWaterIrradiance: { value: new THREE.Vector3(1, 1, 1) },
    /** The sun's share of E_D0 alone. Single scattering is scattering *of the
     *  beam*, so feeding it the sky's share too would put a sunbeam's worth
     *  of light into every direction the sun is not in. */
    uWaterSunIrradiance: { value: new THREE.Vector3(1, 1, 1) },

    // The caustic map. Declared here rather than in the caustics rig so that
    // everything holding the medium can read it without a second wiring
    // step -- and so the ocean, the seabed and the volume are looking at one
    // map by construction.
    tCaustic: { value: null as THREE.Texture | null },
    uCausticCenter: { value: new THREE.Vector2() },
    uCausticExtent: { value: 1 },
    /** World y of the plane the photons were splatted onto. */
    uCausticPlaneY: { value: 0 },
    uCausticStrength: { value: 1 },
  };

  const irradiance = uniforms.uWaterIrradiance.value;
  const sunIrradiance = uniforms.uWaterSunIrradiance.value;

  return {
    name,
    type,
    uniforms,
    /** Read-only view of the coefficients, for the CPU-side light dimming. */
    coefficients: { sigmaS, sigmaT, kd },

    /**
     * Refreshes the terms that depend on the sun or the camera. `cameraDepth`
     * is metres below the mean surface, clamped at zero above it.
     */
    update(cameraDepth: number) {
      uniforms.uWaterCameraDepth.value = Math.max(cameraDepth, 0);
      const sun = sunDirection.value;
      refractSun(sun, uniforms.uWaterSunDirection.value);

      // What actually gets through the surface: the sun's vertical component
      // (irradiance falls off with the cosine) less what Fresnel reflects
      // away, plus a flat sky term so deep water does not go black at dusk.
      const elevation = Math.max(sun.y, 0);
      const through = elevation * (1 - waterFresnel(elevation)) * o.SUN_IRRADIANCE;
      const sc = sunColor.value;
      const zc = zenithColor.value;
      sunIrradiance.set(sc.r * through, sc.g * through, sc.b * through);
      irradiance.set(
        sunIrradiance.x + zc.r * o.SKY_IRRADIANCE,
        sunIrradiance.y + zc.g * o.SKY_IRRADIANCE,
        sunIrradiance.z + zc.b * o.SKY_IRRADIANCE
      );
    },
  };
}

/** The medium rig returned by {@link createWaterMedium}. */
export type WaterMedium = ReturnType<typeof createWaterMedium>;
