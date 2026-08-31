// Validates the GPU FFT's butterfly table against a brute-force DFT.
//
// This replaces the old .fft-check.mjs, which re-implemented the table by hand
// and so could pass while the real table was wrong. Here the table comes from
// the same function the pipeline uses.
//
// The pass chain mirrors what the shader does, and must keep mirroring it:
//   - the spectrum pass writes each value at its bit-reversed position,
//   - each stage reads the two indices from the table and applies the twiddle,
//   - the twiddle's sign carries the butterfly's +/-, so a pass is always
//     out[j] = in[a] + w * in[b].
import { describe, expect, it } from "vitest";
import { bitReverse, buildButterflyTable } from "../src/ocean/fft/butterfly.js";

/** One 1-D FFT over `re`/`im`, driven entirely by the real butterfly table. */
function fftFromTable(re: number[], im: number[]) {
  const N = re.length;
  const stages = Math.round(Math.log2(N));
  const table = buildButterflyTable(N);

  // Spectrum pass: the value for natural index n lands at texel bitReverse(n).
  let curRe = new Array<number>(N);
  let curIm = new Array<number>(N);
  for (let p = 0; p < N; p++) {
    const n = bitReverse(p, stages);
    curRe[p] = re[n]!;
    curIm[p] = im[n]!;
  }

  for (let s = 1; s <= stages; s++) {
    const outRe = new Array<number>(N);
    const outIm = new Array<number>(N);
    for (let j = 0; j < N; j++) {
      const t = ((s - 1) * N + j) * 4;
      const a = table[t + 0]!;
      const b = table[t + 1]!;
      const wr = table[t + 2]!;
      const wi = table[t + 3]!;
      outRe[j] = curRe[a]! + (curRe[b]! * wr - curIm[b]! * wi);
      outIm[j] = curIm[a]! + (curRe[b]! * wi + curIm[b]! * wr);
    }
    curRe = outRe;
    curIm = outIm;
  }
  return { re: curRe, im: curIm };
}

/** X[k] = sum_n x[n] e^{+2i.pi.kn/N} -- the positive kernel the table uses. */
function dft(re: number[], im: number[]) {
  const N = re.length;
  const outRe = new Array<number>(N);
  const outIm = new Array<number>(N);
  for (let k = 0; k < N; k++) {
    let xr = 0;
    let xi = 0;
    for (let n = 0; n < N; n++) {
      const ang = (2 * Math.PI * n * k) / N;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      xr += re[n]! * c - im[n]! * s;
      xi += re[n]! * s + im[n]! * c;
    }
    outRe[k] = xr;
    outIm[k] = xi;
  }
  return { re: outRe, im: outIm };
}

function maxError(N: number, signal: (n: number) => [number, number]) {
  const re: number[] = [];
  const im: number[] = [];
  for (let n = 0; n < N; n++) {
    const [r, i] = signal(n);
    re.push(r);
    im.push(i);
  }
  const fast = fftFromTable(re, im);
  const slow = dft(re, im);
  let worst = 0;
  for (let k = 0; k < N; k++) {
    worst = Math.max(worst, Math.hypot(fast.re[k]! - slow.re[k]!, fast.im[k]! - slow.im[k]!));
  }
  return worst;
}

describe("butterfly table", () => {
  it("matches a brute-force DFT for an arbitrary complex signal", () => {
    const err = maxError(16, (n) => [
      Math.cos(n * 0.7) + 0.5 * Math.sin(n * 2.1),
      Math.sin(n * 1.3) * 0.8,
    ]);
    expect(err).toBeLessThan(1e-5);
  });

  it.each([4, 8, 16, 32, 64, 128, 256])("matches at N = %i", (N) => {
    const err = maxError(N, (n) => [Math.cos(n * 0.31) * 1.7, Math.sin(n * 0.11)]);
    // The table is a Float32Array, so each twiddle carries ~1e-7 of relative
    // error, and log2(N) stages accumulate it across a signal of magnitude N.
    expect(err).toBeLessThan(1e-6 * N);
  });

  it("transforms a unit impulse into a flat spectrum", () => {
    const N = 32;
    const re = new Array<number>(N).fill(0);
    const im = new Array<number>(N).fill(0);
    re[0] = 1;
    const out = fftFromTable(re, im);
    for (let k = 0; k < N; k++) {
      expect(out.re[k]!).toBeCloseTo(1, 6);
      expect(out.im[k]!).toBeCloseTo(0, 6);
    }
  });

  it("has the shape and index range the shader assumes", () => {
    const N = 16;
    const stages = 4;
    const table = buildButterflyTable(N);
    expect(table.length).toBe(N * stages * 4);
    for (let i = 0; i < N * stages; i++) {
      const a = table[i * 4 + 0]!;
      const b = table[i * 4 + 1]!;
      expect(Number.isInteger(a) && a >= 0 && a < N).toBe(true);
      expect(Number.isInteger(b) && b >= 0 && b < N).toBe(true);
      // The twiddle is a unit complex number, sign folded in. Float32 storage
      // puts the magnitude within ~1e-7 of 1, not within double precision.
      expect(Math.hypot(table[i * 4 + 2]!, table[i * 4 + 3]!)).toBeCloseTo(1, 6);
    }
  });
});

describe("bitReverse", () => {
  it("is an involution over the index range", () => {
    for (const bits of [1, 3, 8]) {
      for (let x = 0; x < 1 << bits; x++) {
        expect(bitReverse(bitReverse(x, bits), bits)).toBe(x);
      }
    }
  });

  it("reverses known patterns", () => {
    expect(bitReverse(0b0001, 4)).toBe(0b1000);
    expect(bitReverse(0b1011, 4)).toBe(0b1101);
  });
});
