// Generic, deterministic, tileable noise primitives shared by texture bakers.
// Everything here is pure math: callers supply seeds and periods and receive
// scalars in [0, 1] (or signed derivatives for the curl helpers).

export function hash3(x: number, y: number, z: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647 + seed) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

export function fade(t: number): number { return t * t * t * (t * (t * 6 - 15) + 10); }
export function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
export function wrap(i: number, period: number): number { return ((i % period) + period) % period; }

export const GRADIENTS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
];

export function gradientDot(ix: number, iy: number, iz: number, x: number, y: number, z: number, period: number, seed: number): number {
  const g = GRADIENTS[hash3(wrap(ix, period), wrap(iy, period), wrap(iz, period), seed) % GRADIENTS.length];
  return g[0] * (x - ix) + g[1] * (y - iy) + g[2] * (z - iz);
}

export function perlin(x: number, y: number, z: number, period: number, seed: number): number {
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

export function perlinFbm(x: number, y: number, z: number, period: number, seed: number): number {
  let sum = 0, norm = 0, amp = 1, frequency = 1;
  for (let octave = 0; octave < 3; octave++) {
    sum += amp * perlin(x * frequency, y * frequency, z * frequency, period * frequency, seed + octave * 977);
    norm += amp;
    amp *= 0.5;
    frequency *= 2;
  }
  return Math.max(0, Math.min(1, 0.5 + 0.5 * sum / norm));
}

export function feature(cellX: number, cellY: number, cellZ: number, period: number, seed: number): [number, number, number] {
  const x = wrap(cellX, period), y = wrap(cellY, period), z = wrap(cellZ, period);
  return [
    (hash3(x, y, z, seed) & 1023) / 1024,
    (hash3(x, y, z, seed + 1013) & 1023) / 1024,
    (hash3(x, y, z, seed + 2027) & 1023) / 1024,
  ];
}

export function invertedWorley(x: number, y: number, z: number, period: number, seed: number): number {
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

// Divergence-free 2D curl field from tileable Perlin-fBm potentials.
// A fixed z slice of the periodic 3D noise is still tileable in x/y.
// Returns a Float32Array of size*size*3 signed values (not yet normalized):
// [curlX(psi1), curlY(psi1), curlY(psi2)] per texel, where
// curl(psi) = (d(psi)/dy, -d(psi)/dx).
export function curlField(size: number, period: number, seed: number): Float32Array {
  const out = new Float32Array(size * size * 3);
  const eps = (0.5 * period) / size;
  const slice1 = 0.37, slice2 = 0.71;
  const psi1 = (x: number, y: number) => perlinFbm(x, y, slice1 * period, period, seed);
  const psi2 = (x: number, y: number) => perlinFbm(x, y, slice2 * period, period, seed + 5407);
  let i = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = (x / size) * period, v = (y / size) * period;
    out[i++] = (psi1(u, v + eps) - psi1(u, v - eps)) / (2 * eps);
    out[i++] = -(psi1(u + eps, v) - psi1(u - eps, v)) / (2 * eps);
    out[i++] = (psi2(u, v + eps) - psi2(u, v - eps)) / (2 * eps);
  }
  return out;
}

// Void-and-cluster blue-noise rank matrix (Ulichney). Returns a size*size
// Float32Array of values in [0, 1) whose thresholding at any level yields a
// homogeneous point set — the classic dither/jitter texture. On a torus the
// "largest void" insertion rule stays valid past half fill, so a single
// insertion loop covers phases II and III.
export function blueNoiseRanks(size: number, seed: number): Float32Array {
  const N = size * size;
  const sigma = 1.5;
  const kernel = new Float32Array(N);
  for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) {
    const wx = Math.min(dx, size - dx), wy = Math.min(dy, size - dy);
    kernel[dy * size + dx] = Math.exp(-(wx * wx + wy * wy) / (2 * sigma * sigma));
  }
  const energy = new Float32Array(N);
  const ones = new Uint8Array(N);
  const splat = (pos: number, sign: number) => {
    const px = pos % size, py = (pos - px) / size;
    for (let y = 0; y < size; y++) {
      const ky = ((y - py) % size + size) % size;
      for (let x = 0; x < size; x++) {
        energy[y * size + x] += sign * kernel[ky * size + (((x - px) % size + size) % size)];
      }
    }
  };
  const pick = (wantOne: boolean, wantMax: boolean) => {
    let best = -1, bestE = wantMax ? -Infinity : Infinity;
    for (let i = 0; i < N; i++) {
      if (ones[i] !== (wantOne ? 1 : 0)) continue;
      if (wantMax ? energy[i] > bestE : energy[i] < bestE) { bestE = energy[i]; best = i; }
    }
    return best;
  };
  // Initial pattern: hash-scattered tenth, relaxed to homogeneity.
  let h = seed >>> 0;
  const rand = () => (h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0, (h >>> 8) / 16777216);
  const M = Math.floor(N / 10);
  let count = 0;
  while (count < M) {
    const i = Math.floor(rand() * N);
    if (!ones[i]) { ones[i] = 1; splat(i, 1); count++; }
  }
  for (let iter = 0; iter < 10 * N; iter++) {
    const cluster = pick(true, true);
    ones[cluster] = 0; splat(cluster, -1);
    const voidPos = pick(false, false);
    ones[voidPos] = 1; splat(voidPos, 1);
    if (voidPos === cluster) break;
  }
  const rank = new Float32Array(N);
  // Phase I: rank the initial points by removing the tightest cluster.
  const snapshot = ones.slice();
  for (let c = M; c > 0; c--) {
    const cluster = pick(true, true);
    ones[cluster] = 0; splat(cluster, -1);
    rank[cluster] = c - 1;
  }
  ones.set(snapshot);
  energy.fill(0);
  for (let i = 0; i < N; i++) if (ones[i]) splat(i, 1);
  // Phases II+III: fill the largest void, ranking upward.
  for (let c = M; c < N; c++) {
    const voidPos = pick(false, false);
    ones[voidPos] = 1; splat(voidPos, 1);
    rank[voidPos] = c;
  }
  for (let i = 0; i < N; i++) rank[i] /= N;
  return rank;
}
