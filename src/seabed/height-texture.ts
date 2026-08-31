import * as THREE from "three";
import { perlin, invertedWorley } from "../math/noise.js";
import { drain } from "../loading/scheduler.js";
import type { Bake } from "../loading/types.js";

const LABEL = "Seabed";

// --- Procedural seabed heightfield -------------------------------------------
// One tiling RGBA texture, baked on the CPU with the shared noise kernel and
// mip-mapped so it filters at distance instead of shimmering. Same shape as
// the ocean's detail texture (detail-texture.ts), and the same reasons.
//
//   R,G  tangent-space normal xy (0.5 + 0.5 * n) of the sand relief
//   B    coarse patch mask: where the sand gives way to darker, coarser
//        ground, so the floor is not one flat albedo
//   A    height, 0..1, read by the vertex shader
//
// Everything is a fixed z slice of the periodic 3D noise, which stays
// tileable in x and y -- the same trick bakeCurlField uses.

export interface SeabedTextureOptions {
  /** Lattice period of the base dunes, in cells across the tile. */
  period?: number;
  /** Weight of the ripple octaves against the dunes. */
  ripple?: number;
}

export function* bakeSeabedTexture(
  renderer: THREE.WebGLRenderer,
  size = 512,
  opts: SeabedTextureOptions = {}
): Bake<THREE.DataTexture> {
  const { period = 4, ripple = 0.35 } = opts;
  const N = size;
  const height = new Float32Array(N * N);
  const patch = new Float32Array(N * N);

  for (let j = 0; j < N; j++) {
    const v = j / N;
    for (let i = 0; i < N; i++) {
      const u = i / N;
      const k = j * N + i;

      // Dunes: two smooth octaves, enough shape to catch the light without
      // ever reading as terrain.
      let h = perlin(u * period, v * period, 0.5, period, 3301);
      h += 0.45 * perlin(u * period * 2, v * period * 2, 0.5, period * 2, 5507);

      // Sand ripples: the small parallel corrugations a current leaves.
      // Folding the noise to its absolute value turns the smooth field into
      // rounded ridges with sharp partings, which is what ripples are.
      const r = perlin(u * period * 11, v * period * 11, 0.5, period * 11, 7717);
      h += ripple * (1.0 - 2.0 * Math.abs(r));

      height[k] = h;

      // Coarse ground: Worley cells at a large scale, so the patches have
      // definite edges rather than fading in like another noise octave.
      patch[k] = invertedWorley(u * period * 1.5, v * period * 1.5, 0.5, Math.round(period * 1.5), 9137);
    }
    yield { label: LABEL, detail: `row ${j + 1}/${N}`, fraction: 0.85 * ((j + 1) / N) };
  }

  // Normalise the height into 0..1 so the vertex shader's relief scale means
  // the same thing whatever the octave weights are.
  let hMin = Infinity;
  let hMax = -Infinity;
  for (let k = 0; k < N * N; k++) {
    hMin = Math.min(hMin, height[k]);
    hMax = Math.max(hMax, height[k]);
  }
  const hRange = Math.max(hMax - hMin, 1e-6);
  for (let k = 0; k < N * N; k++) height[k] = (height[k] - hMin) / hRange;

  yield { label: LABEL, detail: "packing normals", fraction: 0.95 };

  // Normals by wrapped central differences, normalised so the encoded tilt
  // is full-range and its strength lives in a shader uniform.
  const slopeX = new Float32Array(N * N);
  const slopeY = new Float32Array(N * N);
  let maxSlope = 1e-6;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      const xp = height[j * N + ((i + 1) % N)];
      const xm = height[j * N + ((i - 1 + N) % N)];
      const yp = height[((j + 1) % N) * N + i];
      const ym = height[((j - 1 + N) % N) * N + i];
      slopeX[k] = (xp - xm) * 0.5 * N;
      slopeY[k] = (yp - ym) * 0.5 * N;
      maxSlope = Math.max(maxSlope, Math.abs(slopeX[k]), Math.abs(slopeY[k]));
    }
  }

  const data = new Uint8Array(N * N * 4);
  for (let k = 0; k < N * N; k++) {
    data[k * 4 + 0] = Math.round((0.5 - 0.5 * slopeX[k] / maxSlope) * 255);
    data[k * 4 + 1] = Math.round((0.5 - 0.5 * slopeY[k] / maxSlope) * 255);
    data[k * 4 + 2] = Math.round(Math.min(1, Math.max(0, patch[k])) * 255);
    data[k * 4 + 3] = Math.round(height[k] * 255);
  }

  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = renderer ? renderer.capabilities.getMaxAnisotropy() : 1;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export function createSeabedTexture(
  renderer: THREE.WebGLRenderer,
  size = 512,
  opts: SeabedTextureOptions = {}
): THREE.DataTexture {
  return drain(bakeSeabedTexture(renderer, size, opts));
}
