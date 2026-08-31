import type * as THREE from "three";
import type { OceanRig } from "../index.js";

// --- The real water height under the camera -----------------------------------
// `sampleSwell` is three Gerstner components with an RMS near 0.36; the FFT
// field it stands in for is normalised to 0.85 and shares none of its phases.
// That is fine for bobbing the torus knot and fine for deciding whether to run
// the underwater passes at all, but it is not good enough to say *where* the
// waterline is -- and the meniscus is drawn on the waterline.
//
// So read the answer instead of guessing it: one texel out of the FFT
// displacement target is the wave height at a world position.
//
// The readback is synchronous, which stalls the pipeline. Two things make
// that acceptable. It only runs when the camera is already within
// PROBE_RANGE of the estimated surface, which is a state the camera is
// almost never in; and being synchronous is what keeps it usable from
// `stepFrames`, where an async readback would never resolve between frames
// and the deterministic capture would silently screenshot a stale height.

/**
 * How close the swell estimate has to put the camera to the surface before
 * the probe is worth its stall. Comfortably wider than the estimate's own
 * error, so the exact height is always available before it is needed.
 */
export const PROBE_RANGE = 4.0;

export function createHeightProbe(renderer: THREE.WebGLRenderer, ocean: OceanRig) {
  const texel = new Float32Array(4);

  /** Wave height at a world xz from one cascade, or 0 off the end of it. */
  function sampleCascade(
    target: THREE.WebGLRenderTarget,
    size: number,
    patchSize: number,
    x: number,
    z: number
  ): number {
    // Same world-anchored mapping the vertex shader uses, wrapped into the
    // patch. Texture v runs bottom-up, which is also how readRenderTargetPixels
    // indexes rows, so no flip is needed.
    const u = (((x / patchSize) % 1) + 1) % 1;
    const v = (((z / patchSize) % 1) + 1) % 1;
    const col = Math.min(size - 1, Math.floor(u * size));
    const row = Math.min(size - 1, Math.floor(v * size));
    renderer.readRenderTargetPixels(target, col, row, 1, 1, texel);
    return texel[1];
  }

  return {
    /**
     * The surface height at (x, z), or `estimate` when the camera is too far
     * from the water for the exact answer to be worth a pipeline stall.
     */
    heightAt(x: number, z: number, cameraY: number, estimate: number): number {
      if (Math.abs(cameraY - estimate) > PROBE_RANGE) return estimate;
      let h = sampleCascade(
        ocean.fft.displacementTarget(),
        ocean.fft.params.size,
        ocean.fft.params.patchSize,
        x,
        z
      );
      // The fine cascade adds its own height, undamped this close in (its
      // distance fade only starts at 25 m).
      if (ocean.fft2) {
        h += sampleCascade(
          ocean.fft2.displacementTarget(),
          ocean.fft2.params.size,
          ocean.fft2.params.patchSize,
          x,
          z
        );
      }
      return h;
    },
  };
}

/** The height probe returned by {@link createHeightProbe}. */
export type HeightProbe = ReturnType<typeof createHeightProbe>;
