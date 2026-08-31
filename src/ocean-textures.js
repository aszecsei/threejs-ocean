import * as THREE from "three";

// --- Procedural ocean detail texture ----------------------------------------
// One tiling RGBA texture baked once on the CPU, mip-mapped so it filters
// correctly at any distance (unlike per-fragment noise, which shimmers):
//   R,G = tangent-space detail normal xy (0.5 + 0.5 * n), capillary ripple
//   B   = foam "churn" lace: 1 - worleyF1 at two cell scales, gated by fBm.
//         The foam mask erodes through this as accumulated foam decays.
//   A   = bubble speckle: Worley cell edges (F2 - F1) + fine fBm, for
//         brightness variation inside foam.
// Everything is tileable by wrapping the noise lattice at its period, so
// the texture can be sampled at any world scale with RepeatWrapping.

const SEED = 4242;

function makeRng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Lattice hash: deterministic per (ix, iy, salt); lattice coords are wrapped
// by the caller so the same cell hashes identically across the tile border.
function hash2(ix, iy, salt) {
  let h = (ix * 374761393 + iy * 668265263 + salt * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

// Tileable gradient (Perlin-style) noise with integer period p.
function gradNoise(x, y, p, salt) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const wrap = (i) => ((i % p) + p) % p;
  const g = (ix, iy) => {
    const a = hash2(wrap(ix), wrap(iy), salt) * Math.PI * 2;
    return [Math.cos(a), Math.sin(a)];
  };
  const dot = (ix, iy, dx, dy) => {
    const v = g(ix, iy);
    return v[0] * dx + v[1] * dy;
  };
  const u = fade(fx);
  const v = fade(fy);
  const n00 = dot(x0, y0, fx, fy);
  const n10 = dot(x0 + 1, y0, fx - 1, fy);
  const n01 = dot(x0, y0 + 1, fx, fy - 1);
  const n11 = dot(x0 + 1, y0 + 1, fx - 1, fy - 1);
  const nx0 = n00 + (n10 - n00) * u;
  const nx1 = n01 + (n11 - n01) * u;
  return (nx0 + (nx1 - nx0) * v) * 1.41; // ~[-1, 1]
}

// Tileable fBm; uv in [0,1), base period in cells.
//
// `fold` shapes the character of the octaves from o >= 2 (the first two stay
// smooth so the broad shape is never creased):
//   +1  ridged  (1 - 2|n|): sharp creases — a filament network that, once two
//       panning copies are warped over each other, reads as marbled oil.
//    0  plain fBm: soft and rolling.
//   -1  billow  (2|n| - 1): rounded lumps with soft partings — cloud.
// The blend is continuous, so intermediate values are meaningful.
function fbm(u, v, basePeriod, octaves, salt, fold = 0, gain = 0.5) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let p = basePeriod;
  const af = Math.abs(fold);
  for (let o = 0; o < octaves; o++) {
    let n = gradNoise(u * p, v * p, p, salt + o * 17);
    if (fold !== 0 && o >= 2) n = (1 - af) * n + fold * (1 - 2 * Math.abs(n));
    sum += n * amp;
    norm += amp;
    amp *= gain;
    p *= 2;
  }
  return sum / norm;
}

// Tileable Worley: returns [F1, F2] for uv in [0,1) with `cells` per side.
function worley(u, v, cells, salt) {
  const x = u * cells;
  const y = v * cells;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let f1 = 1e9;
  let f2 = 1e9;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const cx = ix + ox;
      const cy = iy + oy;
      const wx = ((cx % cells) + cells) % cells;
      const wy = ((cy % cells) + cells) % cells;
      const px = cx + hash2(wx, wy, salt);
      const py = cy + hash2(wx, wy, salt + 101);
      const d = (px - x) * (px - x) + (py - y) * (py - y);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
    }
  }
  return [Math.sqrt(f1), Math.sqrt(f2)];
}

const clamp01 = (x) => Math.min(1, Math.max(0, x));

export function createOceanDetailTexture(renderer, size = 512, opts = {}) {
  const { fold = 0, gain = 0.5, octaves = 5 } = opts;
  const N = size;
  const height = new Float32Array(N * N);
  const churn = new Float32Array(N * N);
  const bubbles = new Float32Array(N * N);

  // Bake the scalar fields.
  for (let j = 0; j < N; j++) {
    const v = j / N;
    for (let i = 0; i < N; i++) {
      const u = i / N;
      const k = j * N + i;

      // Ripple heightfield: broad swell-let base + capillary octaves whose
      // character comes from `fold` (see fbm).
      height[k] = fbm(u, v, 4, octaves, 11, fold, gain);

      // Churn lace: two Worley scales, cells bright at their edges.
      const [a1] = worley(u, v, 6, 23);
      const [b1] = worley(u, v, 14, 47);
      const lace = 0.6 * (1 - clamp01(a1 * 1.9)) + 0.4 * (1 - clamp01(b1 * 2.2));
      const gate = 0.5 + 0.5 * fbm(u, v, 3, 3, 31);
      churn[k] = clamp01(lace * (0.55 + 0.9 * gate));

      // Bubble speckle: cell edges + fine grain.
      const [c1, c2] = worley(u, v, 40, 71);
      const edge = clamp01((c2 - c1) * 3.0);
      const grain = 0.5 + 0.5 * fbm(u, v, 32, 2, 91);
      bubbles[k] = clamp01(0.65 * edge + 0.35 * grain);
    }
  }

  // Normalize churn to use the full [0,1] range so the erosion threshold in
  // the shader has a predictable span.
  let cMin = 1;
  let cMax = 0;
  for (let k = 0; k < N * N; k++) {
    cMin = Math.min(cMin, churn[k]);
    cMax = Math.max(cMax, churn[k]);
  }
  const cRange = Math.max(cMax - cMin, 1e-6);

  // Normals via wrapped central differences; slope normalized so the max
  // encoded tilt is fixed (strength lives in a shader uniform).
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
    // Tangent xy of the normal for a unit-height field: n = (-dx, -dy, 1).
    const nx = -slopeX[k] / maxSlope;
    const ny = -slopeY[k] / maxSlope;
    data[k * 4 + 0] = Math.round((0.5 + 0.5 * nx) * 255);
    data[k * 4 + 1] = Math.round((0.5 + 0.5 * ny) * 255);
    data[k * 4 + 2] = Math.round(((churn[k] - cMin) / cRange) * 255);
    data[k * 4 + 3] = Math.round(bubbles[k] * 255);
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
