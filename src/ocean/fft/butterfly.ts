// Butterfly table for the Stockham-style FFT passes.
//
// Pure arithmetic, deliberately free of three.js and the DOM so the FFT can be
// validated against a brute-force DFT in a plain Node test. The old
// .fft-check.mjs re-implemented this table by hand, which meant the check could
// silently drift away from the code it was checking; test/fft.test.ts imports
// this function instead.

/**
 * Builds the per-stage butterfly table for an N-point FFT.
 *
 * Layout: RGBA per texel, `stages` rows of N texels. Row `s - 1`, texel `j`
 * holds the two input indices and the twiddle factor for stage `s`:
 *   R = index a, G = index b, BA = the complex twiddle w.
 *
 * The +/- of the butterfly is folded into the twiddle's sign, so the shader
 * only ever computes `out[j] = in[a] + w * in[b]`.
 *
 * The twiddle is e^{+2i.pi.r/span}: the positive kernel. It must match the
 * sign convention in spectrum.frag.glsl, or the surface moves the wrong way.
 */
export function buildButterflyTable(N: number): Float32Array {
  const stages = Math.round(Math.log2(N));
  const data = new Float32Array(N * stages * 4);
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
      data[idx + 0] = a;
      data[idx + 1] = b;
      data[idx + 2] = sign * Math.cos(ang);
      data[idx + 3] = sign * Math.sin(ang);
    }
  }
  return data;
}

/** Reverses the low `bits` bits of `x`. */
export function bitReverse(x: number, bits: number): number {
  let r = 0;
  for (let i = 0; i < bits; i++) {
    r = r * 2 + (x & 1);
    x >>= 1;
  }
  return r;
}
