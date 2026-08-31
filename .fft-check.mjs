// Validates the FFT algorithm used in ocean-fft.js against a brute-force DFT.
// Mirrors: spectrum written at bit-reversed position, butterflies from the
// precomputed table, twiddles e^{+2i pi r/span} (sign folded into table).
const N = 16;
const stages = 4;

const bitrev = (x) => {
  let r = 0;
  for (let i = 0; i < stages; i++) { r = r * 2 + (x & 1); x >>= 1; }
  return r;
};

// Build the butterfly table exactly as buildButterflyTexture does.
const table = new Float32Array(N * stages * 4);
for (let s = 1; s <= stages; s++) {
  const span = 1 << s;
  const m = span >> 1;
  for (let j = 0; j < N; j++) {
    const r = j % span;
    let a, b, sign, ang;
    if (r < m) {
      a = j; b = j + m; sign = 1;
      ang = (2 * Math.PI * r) / span;
    } else {
      a = j - m; b = j; sign = -1;
      ang = (2 * Math.PI * (r - m)) / span;
    }
    const idx = ((s - 1) * N + j) * 4;
    table[idx + 0] = a;
    table[idx + 1] = b;
    table[idx + 2] = sign * Math.cos(ang);
    table[idx + 3] = sign * Math.sin(ang);
  }
}

// Arbitrary complex signal (the RG channel of the packed texture).
const sigRe = new Array(N);
const sigIm = new Array(N);
for (let n = 0; n < N; n++) {
  sigRe[n] = Math.cos(n * 0.7) + 0.5 * Math.sin(n * 2.1);
  sigIm[n] = Math.sin(n * 1.3) * 0.8;
}

// Spectrum pass: value for natural index n lands at texel bitrev(n).
let re = new Array(N);
let im = new Array(N);
for (let p = 0; p < N; p++) {
  const n = bitrev(p);
  re[p] = sigRe[n];
  im[p] = sigIm[n];
}

const cmul = (ar, ai, br, bi) => [ar * br - ai * bi, ar * bi + ai * br];

// Run the 1D pass chain (the horizontal case; vertical is identical).
for (let s = 1; s <= stages; s++) {
  const outRe = new Array(N);
  const outIm = new Array(N);
  for (let j = 0; j < N; j++) {
    const t = ((s - 1) * N + j) * 4;
    const a = table[t + 0];
    const b = table[t + 1];
    const wr = table[t + 2];
    const wi = table[t + 3];
    const [vr, vi] = cmul(re[b], im[b], wr, wi);
    outRe[j] = re[a] + vr;
    outIm[j] = im[a] + vi;
  }
  re = outRe;
  im = outIm;
}

// Brute-force DFT with the + kernel: X[k] = sum_n x[n] e^{+2i pi kn/N}.
let maxErr = 0;
for (let k = 0; k < N; k++) {
  let xr = 0;
  let xi = 0;
  for (let n = 0; n < N; n++) {
    const ang = (2 * Math.PI * n * k) / N;
    const c = Math.cos(ang);
    const s2 = Math.sin(ang);
    xr += sigRe[n] * c - sigIm[n] * s2;
    xi += sigRe[n] * s2 + sigIm[n] * c;
  }
  const err = Math.hypot(re[k] - xr, im[k] - xi);
  if (err > maxErr) maxErr = err;
}
console.log('max abs error vs brute-force DFT:', maxErr.toExponential(2));
if (maxErr > 1e-5) {
  console.log('FFT MISMATCH');
  process.exit(1);
}
console.log('FFT OK');
