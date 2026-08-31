// The CPU noise kernel bakes every cloud and ocean texture at load time, so
// its two load-bearing properties are determinism (the same seed must give the
// same texture on every machine and every run) and tileability (the lattice
// must wrap at its period, or seams appear across the sky and sea).
import { describe, expect, it } from "vitest";
import {
  blueNoiseRanks,
  curlField,
  invertedWorley,
  perlin,
  perlinFbm,
} from "../src/math/noise.js";

const SEED = 1234;

describe("perlin", () => {
  it("is deterministic", () => {
    expect(perlin(1.7, 2.3, 0.4, 8, SEED)).toBe(perlin(1.7, 2.3, 0.4, 8, SEED));
  });

  it("tiles at its period", () => {
    const period = 8;
    for (const [x, y, z] of [[1.7, 2.3, 0.4], [0.1, 7.9, 3.3], [5.5, 5.5, 5.5]]) {
      const a = perlin(x!, y!, z!, period, SEED);
      expect(perlin(x! + period, y!, z!, period, SEED)).toBeCloseTo(a, 12);
      expect(perlin(x!, y! + period, z!, period, SEED)).toBeCloseTo(a, 12);
      expect(perlin(x!, y!, z! + period, period, SEED)).toBeCloseTo(a, 12);
    }
  });

  it("is zero on lattice points", () => {
    // Gradient noise vanishes where the interpolation weights collapse.
    for (let i = 0; i < 4; i++) {
      expect(perlin(i, 2, 3, 8, SEED)).toBeCloseTo(0, 12);
    }
  });

  it("changes with the seed", () => {
    expect(perlin(1.7, 2.3, 0.4, 8, SEED)).not.toBeCloseTo(
      perlin(1.7, 2.3, 0.4, 8, SEED + 1), 6);
  });
});

describe("perlinFbm", () => {
  it("stays inside [0, 1]", () => {
    for (let i = 0; i < 500; i++) {
      const v = perlinFbm(i * 0.37, i * 0.11, i * 0.53, 8, SEED);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("tiles at its period", () => {
    // Each octave doubles the frequency AND the period, so the sum tiles too.
    const period = 8;
    const a = perlinFbm(1.7, 2.3, 0.4, period, SEED);
    expect(perlinFbm(1.7 + period, 2.3, 0.4, period, SEED)).toBeCloseTo(a, 12);
  });
});

describe("invertedWorley", () => {
  it("stays inside [0, 1]", () => {
    for (let i = 0; i < 500; i++) {
      const v = invertedWorley(i * 0.29, i * 0.71, i * 0.13, 8, SEED);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("tiles at its period", () => {
    const period = 8;
    const a = invertedWorley(1.7, 2.3, 0.4, period, SEED);
    expect(invertedWorley(1.7 + period, 2.3, 0.4, period, SEED)).toBeCloseTo(a, 12);
    expect(invertedWorley(1.7, 2.3 + period, 0.4, period, SEED)).toBeCloseTo(a, 12);
  });
});

describe("curlField", () => {
  it("has the documented shape and is deterministic", () => {
    const size = 16;
    const a = curlField(size, 4, SEED);
    expect(a.length).toBe(size * size * 3);
    expect(Array.from(curlField(size, 4, SEED))).toEqual(Array.from(a));
  });

  it("is not degenerate", () => {
    const a = curlField(16, 4, SEED);
    expect(a.some((v) => Math.abs(v) > 1e-3)).toBe(true);
  });
});

describe("blueNoiseRanks", () => {
  const size = 16;
  const ranks = blueNoiseRanks(size, SEED);

  it("is a permutation scaled into [0, 1)", () => {
    expect(ranks.length).toBe(size * size);
    // Every rank 0..N-1 appears exactly once, divided by N.
    const seen = new Set(Array.from(ranks, (v) => Math.round(v * ranks.length)));
    expect(seen.size).toBe(ranks.length);
    expect(Math.min(...ranks)).toBe(0);
    expect(Math.max(...ranks)).toBeCloseTo((ranks.length - 1) / ranks.length, 12);
  });

  it("is deterministic", () => {
    expect(Array.from(blueNoiseRanks(size, SEED))).toEqual(Array.from(ranks));
  });

  it("spreads low ranks rather than clustering them", () => {
    // The point of void-and-cluster: thresholding at any level gives a
    // homogeneous set. A clustered pattern would leave whole quadrants empty.
    const chosen: Array<[number, number]> = [];
    ranks.forEach((v, i) => {
      if (v < 0.25) chosen.push([i % size, Math.floor(i / size)]);
    });
    const quadrants = [0, 0, 0, 0];
    for (const [x, y] of chosen) {
      quadrants[(x < size / 2 ? 0 : 1) + (y < size / 2 ? 0 : 2)]!++;
    }
    const expected = chosen.length / 4;
    for (const q of quadrants) expect(Math.abs(q - expected)).toBeLessThan(expected);
  });
});
