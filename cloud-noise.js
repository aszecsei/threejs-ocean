import * as THREE from "three";

// Deterministic CPU-baked, tileable cloud volumes. The base texture follows
// the Perlin-Worley packing used by real-time cloud renderers; the detail
// texture stores three increasing-frequency inverted Worley bands.
const SEED = 0x51f15e;

function hash3(x, y, z, seed = SEED) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647 + seed) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
function lerp(a, b, t) { return a + (b - a) * t; }
function wrap(i, period) { return ((i % period) + period) % period; }

const GRADIENTS = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
];

function gradientDot(ix, iy, iz, x, y, z, period, seed) {
  const g = GRADIENTS[hash3(wrap(ix, period), wrap(iy, period), wrap(iz, period), seed) % GRADIENTS.length];
  return g[0] * (x - ix) + g[1] * (y - iy) + g[2] * (z - iz);
}

function perlin(x, y, z, period, seed) {
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const u = fade(x - x0), v = fade(y - y0), w = fade(z - z0);
  const n000 = gradientDot(x0, y0, z0, x, y, z, period, seed);
  const n100 = gradientDot(x0 + 1, y0, z0, x, y, z, period, seed);
  const n010 = gradientDot(x0, y0 + 1, z0, x, y, z, period, seed);
  const n110 = gradientDot(x0 + 1, y0 + 1, z0, x, y, z, period, seed);
  const n001 = gradientDot(x0, y0, z0 + 1, x, y, z, period, seed);
  const n101 = gradientDot(x0 + 1, y0, z0 + 1, x, y, z, period, seed);
  const n011 = gradientDot(x0, y0 + 1, z0 + 1, x, y, z, period, seed);
  const n111 = gradientDot(x0 + 1, y0 + 1, z0 + 1, x, y, z, period, seed);
  return lerp(lerp(lerp(n000, n100, u), lerp(n010, n110, u), v),
              lerp(lerp(n001, n101, u), lerp(n011, n111, u), v), w);
}

function perlinFbm(x, y, z, period, seed) {
  let sum = 0, norm = 0, amp = 1, frequency = 1;
  for (let octave = 0; octave < 3; octave++) {
    sum += amp * perlin(x * frequency, y * frequency, z * frequency, period * frequency, seed + octave * 977);
    norm += amp;
    amp *= 0.5;
    frequency *= 2;
  }
  return Math.max(0, Math.min(1, 0.5 + 0.5 * sum / norm));
}

function feature(cellX, cellY, cellZ, period, seed) {
  const x = wrap(cellX, period), y = wrap(cellY, period), z = wrap(cellZ, period);
  return [
    (hash3(x, y, z, seed) & 1023) / 1024,
    (hash3(x, y, z, seed + 1013) & 1023) / 1024,
    (hash3(x, y, z, seed + 2027) & 1023) / 1024,
  ];
}

function invertedWorley(x, y, z, period, seed) {
  const cx = Math.floor(x), cy = Math.floor(y), cz = Math.floor(z);
  let nearest = 3;
  for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const f = feature(cx + dx, cy + dy, cz + dz, period, seed);
    const px = cx + dx + f[0], py = cy + dy + f[1], pz = cz + dz + f[2];
    const qx = x - px, qy = y - py, qz = z - pz;
    nearest = Math.min(nearest, qx * qx + qy * qy + qz * qz);
  }
  return Math.max(0, Math.min(1, 1 - Math.sqrt(nearest) / 1.15));
}

function makeTexture(size, detail) {
  const data = new Uint8Array(size * size * size * 4);
  let i = 0;
  const basePeriods = detail ? [4, 8, 12] : [4, 8, 12];
  for (let z = 0; z < size; z++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
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
      data[i++] = Math.round(pw * 255);
      data[i++] = Math.round(bands[0] * 255);
      data[i++] = Math.round(bands[1] * 255);
      data[i++] = Math.round(bands[2] * 255);
    }
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

export function cloudNoiseSupported(renderer) {
  if (!renderer?.capabilities?.isWebGL2) return false;
  const gl = renderer.getContext();
  return gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) >= 64;
}

export function createCloudNoiseTextures(renderer) {
  if (!cloudNoiseSupported(renderer)) return null;
  const started = performance.now();
  try {
    const base = makeTexture(64, false);
    const detail = makeTexture(32, true);
    base.name = "CloudNoise.base64";
    detail.name = "CloudNoise.detail32";
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
