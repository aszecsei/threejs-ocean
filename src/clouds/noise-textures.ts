import * as THREE from "three";
import { bakeBlueNoiseRanks, bakeCurlField, invertedWorley, perlinFbm } from "../math/noise.js";
import { band, drain } from "../loading/scheduler.js";
import type { Bake } from "../loading/types.js";

// Deterministic CPU-baked, tileable cloud volumes. The base texture follows
// the Perlin-Worley packing used by real-time cloud renderers; the detail
// texture stores three increasing-frequency inverted Worley bands.
const SEED = 0x51f15e;

const CIRRUS = "Cirrus noise";

// Yields once per z-slice: at 128³ this is the longest single block of CPU
// work in the whole startup, so the loading screen needs to see inside it.
function* bakeTexture(size: number, detail: boolean, label: string): Bake<THREE.Data3DTexture> {
  const data = new Uint8Array(size * size * size * 4);
  let i = 0;
  const basePeriods = detail ? [4, 8, 12] : [4, 8, 12];
  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size, w = z / size;
      const bands = basePeriods.map((period, band) => invertedWorley(u * period, v * period, w * period, period, SEED + 3001 + band * 811));
      if (detail) {
        data[i++] = Math.round(bands[0] * 255);
        data[i++] = Math.round(bands[1] * 255);
        data[i++] = Math.round(bands[2] * 255);
        data[i++] = Math.round((0.5 * bands[1] + 0.5 * bands[2]) * 255);
      } else {
        // Gradient fBm occupies a narrower numeric range than the analytic
        // reference noise. Lift it before the Perlin-Worley remap so R keeps
        // connected bodies instead of quantizing mostly to empty space.
        const p = Math.min(1, perlinFbm(u * 4, v * 4, w * 4, 4, SEED + 41) * 0.72 + 0.28);
        const pw = Math.max(0, Math.min(1, (p - (1 - bands[0])) / Math.max(bands[0], 1e-4)));
        // Dilate by the Worley fBm (billowed silhouette), in float precision —
        // doing these remaps in the shader stretches 8-bit steps into visible
        // terracing. The dilated signal occupies roughly [0.33, 0.83]
        // (measured), so stretch that band to the full [0, 1] range: without
        // the stretch the density threshold saturates wherever the profile
        // envelope is strong and clouds render as flat envelope-shaped slabs.
        // Weighted toward the higher bands so the dilation imprints clusters
        // of small billows on the silhouette, not one large-cell outline.
        const wfbm = 0.45 * bands[0] + 0.33 * bands[1] + 0.22 * bands[2];
        const dilated = Math.max(0, Math.min(1, (pw - (wfbm - 1)) / (2 - wfbm)));
        // Gentler stretch than the original (dilated-0.4)/0.4: that steep remap
        // made R nearly binary in space, leaving only a thin 0<d<1 shell for
        // erosion to sculpt — clouds read as solid puffballs with shaved skins.
        // The wider band gives broad translucent fringes the erosion can shred.
        const shaped = Math.max(0, Math.min(1, (dilated - 0.33) / 0.5));
        data[i++] = Math.round(shaped * 255);
        data[i++] = Math.round(bands[0] * 255);
        data[i++] = Math.round(bands[1] * 255);
        data[i++] = Math.round(bands[2] * 255);
      }
    }
    yield { label, detail: `slice ${z + 1}/${size}`, fraction: (z + 1) / size };
  }
  const texture = new THREE.Data3DTexture(data, size, size, size);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = texture.wrapR = THREE.RepeatWrapping;
  texture.colorSpace = THREE.NoColorSpace;
  texture.unpackAlignment = 1;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

// Tileable 2D curl-noise texture (HZD-style turbulence). RGB carries a
// divergence-free XY offset plus an independent vertical component, encoded
// as 0.5 + 0.5 * v / maxAmplitude so the shader decodes with *2-1.
export function* bakeCurlNoiseTexture(size = 128): Bake<THREE.DataTexture> {
  const field = yield* bakeCurlField(size, 6, SEED + 9013, "Curl noise");
  let maxAmp = 1e-4;
  for (let i = 0; i < field.length; i++) maxAmp = Math.max(maxAmp, Math.abs(field[i]));
  const data = new Uint8Array(size * size * 4);
  for (let i = 0, j = 0; i < field.length; i += 3, j += 4) {
    data[j] = Math.round((0.5 + 0.5 * field[i] / maxAmp) * 255);
    data[j + 1] = Math.round((0.5 + 0.5 * field[i + 1] / maxAmp) * 255);
    data[j + 2] = Math.round((0.5 + 0.5 * field[i + 2] / maxAmp) * 255);
    data[j + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.NoColorSpace;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  texture.name = "CloudNoise.curl" + size;
  return texture;
}

export function createCurlNoiseTexture(size = 128) {
  return drain(bakeCurlNoiseTexture(size));
}

// Tileable 2D cirrus basis texture. The bake is isotropic — the wind-aligned
// stretch happens in the shader's UV transform so RepeatWrapping keeps the
// result tileable under any affine warp. Channels follow the HFW 2.5-D model:
// R = streaky source, G = wispy source (pre-curled by a curl-field domain
// warp), B = round source (inverted Worley), A = very-low-frequency regional
// influence so streak systems vary across the sky instead of tiling globally.
// Contrast shaping runs in float precision here for the same terracing
// reason documented on the base texture above.
export function* bakeCirrusNoiseTexture(size = 256): Bake<THREE.DataTexture> {
  const fbm = (u: number, v: number) =>
    perlinFbm(u * 4, v * 4, 1.37 * 4, 4, SEED + 7411) * 0.6 +
    perlinFbm(u * 16, v * 16, 0.61 * 16, 16, SEED + 7907) * 0.4;
  const shape = (v: number, lo: number, hi: number) => {
    const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
    return t * t * (3 - 2 * t);
  };
  // The domain-warp field is roughly a third of this bake's cost; the shaping
  // loop below is the rest.
  const warp = yield* band(bakeCurlField(size, 4, SEED + 8317), CIRRUS, 0, 0.35, "warp");
  let maxAmp = 1e-4;
  for (let i = 0; i < warp.length; i++) maxAmp = Math.max(maxAmp, Math.abs(warp[i]));
  const data = new Uint8Array(size * size * 4);
  for (let y = 0, i = 0, j = 0; y < size; y++) {
    for (let x = 0; x < size; x++, i += 3, j += 4) {
      const u = x / size, v = y / size;
      const wu = u + (warp[i] / maxAmp) * 0.06, wv = v + (warp[i + 1] / maxAmp) * 0.06;
      data[j] = Math.round(shape(fbm(u, v), 0.35, 0.75) * 255);
      data[j + 1] = Math.round(shape(fbm(wu, wv), 0.32, 0.78) * 255);
      data[j + 2] = Math.round(invertedWorley(u * 6, v * 6, 2.37, 6, SEED + 8923) * 255);
      data[j + 3] = Math.round(perlinFbm(u * 2, v * 2, 0.83 * 2, 2, SEED + 9403) * 255);
    }
    yield { label: CIRRUS, detail: `shaping row ${y + 1}/${size}`, fraction: 0.35 + 0.65 * ((y + 1) / size) };
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.NoColorSpace;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  texture.name = "CloudNoise.cirrus" + size;
  return texture;
}

export function createCirrusNoiseTexture(size = 256) {
  return drain(bakeCirrusNoiseTexture(size));
}

// Void-and-cluster blue-noise jitter texture for the ray-march offsets.
// Blue noise pushes the sampling error into frequencies the temporal
// neighborhood clamp and TAA absorb far better than white noise.
export function* bakeBlueNoiseTexture(size = 64): Bake<THREE.DataTexture> {
  const ranks = yield* bakeBlueNoiseRanks(size, SEED + 40787, "Blue noise");
  const data = new Uint8Array(size * size);
  for (let i = 0; i < ranks.length; i++) data[i] = Math.round(ranks[i] * 255);
  const texture = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.UnsignedByteType);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.NoColorSpace;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  texture.name = "CloudNoise.blue" + size;
  return texture;
}

export function createBlueNoiseTexture(size = 64) {
  return drain(bakeBlueNoiseTexture(size));
}

export function cloudNoiseSupported(
  renderer: THREE.WebGLRenderer | null | undefined
): renderer is THREE.WebGLRenderer {
  if (!renderer?.capabilities?.isWebGL2) return false;
  // isWebGL2 above is the runtime guarantee; getContext() is typed as the
  // WebGL1|WebGL2 union, so narrow it to reach MAX_3D_TEXTURE_SIZE.
  const gl = renderer.getContext() as WebGL2RenderingContext;
  return gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) >= 64;
}

/** The baked 3D noise pair, or null when the GPU cannot host it. */
export interface CloudNoiseTextures {
  base: THREE.Data3DTexture;
  detail: THREE.Data3DTexture;
  generationMs: number;
  dispose(): void;
}

export function* bakeCloudNoiseTextures(
  renderer: THREE.WebGLRenderer | null | undefined
): Bake<CloudNoiseTextures | null> {
  if (!cloudNoiseSupported(renderer)) return null;
  const started = performance.now();
  try {
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const highRes = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) >= 128;
    const baseSize = highRes ? 128 : 64;
    const detailSize = highRes ? 64 : 32;
    // Split the band by voxel count: at 128³/64³ the base volume is eight
    // times the work, and it must not look stalled while it runs.
    const share = baseSize ** 3 / (baseSize ** 3 + detailSize ** 3);
    const base = yield* band(bakeTexture(baseSize, false, "Cloud volume noise"), "Cloud volume noise", 0, share);
    const detail = yield* band(bakeTexture(detailSize, true, "Cloud detail noise"), "Cloud detail noise", share, 1);
    base.name = "CloudNoise.base" + baseSize;
    detail.name = "CloudNoise.detail" + detailSize;
    console.info(`Cloud noise baked at ${baseSize}³/${detailSize}³ in ${(performance.now() - started).toFixed(0)} ms`);
    return {
      base,
      detail,
      generationMs: performance.now() - started,
      dispose() { base.dispose(); detail.dispose(); },
    };
  } catch (error) {
    console.warn("Cloud 3D-noise generation failed; using procedural fallback", error);
    return null;
  }
}

export function createCloudNoiseTextures(
  renderer: THREE.WebGLRenderer | null | undefined
): CloudNoiseTextures | null {
  return drain(bakeCloudNoiseTextures(renderer));
}
