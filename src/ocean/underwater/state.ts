import { sampleSwell } from "../index.js";

// --- Where the camera is relative to the waterline ---------------------------
// Deliberately CPU-side and deliberately approximate. `sampleSwell` is the
// three-component swell the torus knot already rides, not the FFT field, so it
// is never the authority on *which pixels* are wet -- the water mask is (see
// mask.ts). This only decides whether the underwater passes run at all, and
// how far to dim the scene lights.
//
// The two jobs want different tolerances, hence `active` alongside
// `submerged`: running a cheap full-screen pass that turns out to be a no-op
// costs a fraction of a millisecond, whereas *not* running it when a wave has
// closed over the lens is a visible pop. So the passes switch on early and
// leave the per-pixel truth to the mask.

/**
 * How far above the mean surface `sampleSwell` can be wrong. Its three
 * components carry an RMS height near 0.36 against the FFT field's normalised
 * 0.85, so it systematically under-reports crests; this covers the gap with
 * room to spare.
 */
export const SUBMERSION_MARGIN = 2.0;

export interface Submersion {
  /** Water surface height at the camera's xz, world units. */
  waterY: number;
  /** Metres below the surface; 0 when above it. */
  depth: number;
  /** Best guess at whether the camera itself is under the water. */
  submerged: boolean;
  /** Whether the underwater passes should run this frame. */
  active: boolean;
}

/**
 * Samples the swell under the camera. `margin` is the height above the
 * estimated surface at which the passes switch on.
 *
 * `measure` is an optional exact reading of the surface height (see
 * height-probe.ts). It is given the estimate and the camera's height and may
 * decline, returning the estimate unchanged -- which is what keeps the probe
 * off the hot path when the camera is nowhere near the water.
 */
export function submersion(
  x: number,
  y: number,
  z: number,
  t: number,
  measure?: (x: number, z: number, cameraY: number, estimate: number) => number,
  margin = SUBMERSION_MARGIN
): Submersion {
  const estimate = sampleSwell(x, z, t).h;
  const waterY = measure ? measure(x, z, y, estimate) : estimate;
  return {
    waterY,
    depth: Math.max(waterY - y, 0),
    submerged: y < waterY,
    // Deliberately measured against the *estimate*: the probe only runs once
    // the passes are already on, so gating it on its own output would be
    // circular.
    active: y < estimate + margin,
  };
}
