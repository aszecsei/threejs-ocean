// The CPU-side wave spectrum decides how tall the sea is. cascadeAmpScale is
// what makes `heightRms` an actual RMS wave height rather than a vague knob,
// and it has to keep meaning that as cascades are added or resized.
import { describe, expect, it } from "vitest";
import { OCEAN_FFT_DEFAULTS, cascadeAmpScale, spectrumVariance } from "../src/ocean/fft/index.js";
import { sampleSwell } from "../src/ocean/index.js";

describe("spectrumVariance", () => {
  it("is positive for the default sea state", () => {
    expect(spectrumVariance({})).toBeGreaterThan(0);
  });

  it("grows with wind speed", () => {
    const calm = spectrumVariance({ windSpeed: 6 });
    const blowing = spectrumVariance({ windSpeed: 18 });
    expect(blowing).toBeGreaterThan(calm);
  });

  it("is unchanged by heightRms, which is applied afterwards", () => {
    expect(spectrumVariance({ heightRms: 0.1 })).toBeCloseTo(spectrumVariance({ heightRms: 10 }), 12);
  });
});

describe("cascadeAmpScale", () => {
  it("produces the requested RMS height", () => {
    // The scale multiplies amplitudes, so it squares into the variance:
    // sum(variance) * scale^2 must equal heightRms^2.
    for (const heightRms of [0.25, 0.85, 3]) {
      const cascades = [{}, { patchSize: 20 }];
      const scale = cascadeAmpScale(cascades, heightRms);
      const total = cascades.reduce((sum, c) => sum + spectrumVariance(c), 0);
      expect(Math.sqrt(total) * scale).toBeCloseTo(heightRms, 9);
    }
  });

  it("scales inversely with the number of cascades", () => {
    // Adding a cascade adds variance, so each one must contribute less.
    const one = cascadeAmpScale([{}], 1);
    const two = cascadeAmpScale([{}, { patchSize: 20 }], 1);
    expect(two).toBeLessThan(one);
  });

  it("is linear in heightRms", () => {
    const a = cascadeAmpScale([{}], 1);
    expect(cascadeAmpScale([{}], 3)).toBeCloseTo(a * 3, 9);
  });
});

describe("OCEAN_FFT_DEFAULTS", () => {
  it("has a power-of-two size, which the butterfly passes require", () => {
    const n = OCEAN_FFT_DEFAULTS.size;
    expect(Number.isInteger(Math.log2(n))).toBe(true);
  });
});

describe("sampleSwell", () => {
  it("is deterministic and finite", () => {
    const a = sampleSwell(3, -2, 1.5);
    const b = sampleSwell(3, -2, 1.5);
    expect(a).toEqual(b);
    for (const v of [a.h, a.gx, a.gz]) expect(Number.isFinite(v)).toBe(true);
  });

  it("moves over time and across space", () => {
    expect(sampleSwell(0, 0, 0).h).not.toBeCloseTo(sampleSwell(0, 0, 3.3).h, 6);
    expect(sampleSwell(0, 0, 1).h).not.toBeCloseTo(sampleSwell(9, 4, 1).h, 6);
  });

  it("stays within a plausible amplitude", () => {
    // Floating objects ride this, so a runaway value would launch the knot.
    let peak = 0;
    for (let i = 0; i < 2000; i++) {
      peak = Math.max(peak, Math.abs(sampleSwell(i * 0.7, i * 0.3, i * 0.05).h));
    }
    expect(peak).toBeLessThan(2);
  });
});
