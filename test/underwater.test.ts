// The underwater feature's CPU half. Almost all of it is shader code that
// only a screenshot can check, so what is worth testing here is the small
// amount that decides *which* shader path runs and what the medium is made
// of -- getting either wrong changes the render silently rather than failing.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { submersion, SUBMERSION_MARGIN } from "../src/ocean/underwater/state.js";
import {
  WATER_TYPES,
  WATER_DEFAULTS,
  waterTypeName,
  waterFresnel,
  refractSun,
} from "../src/ocean/underwater/water.js";
import { sampleSwell } from "../src/ocean/index.js";

/** Runs `fn` as if the page had been loaded with `search`. */
function withSearch<T>(search: string, fn: () => T): T {
  vi.stubGlobal("window", { location: { search } });
  return fn();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("submersion", () => {
  const at = (y: number, t = 0) => submersion(3, y, 5, t);

  it("reports the swell height under the camera", () => {
    expect(at(0).waterY).toBeCloseTo(sampleSwell(3, 5, 0).h, 12);
  });

  it("is submerged exactly below the surface", () => {
    const w = at(0).waterY;
    expect(at(w + 0.01).submerged).toBe(false);
    expect(at(w - 0.01).submerged).toBe(true);
  });

  it("clamps depth to zero above the surface", () => {
    const w = at(0).waterY;
    expect(at(w + 3).depth).toBe(0);
    expect(at(w - 3).depth).toBeCloseTo(3, 10);
  });

  // The passes switching on late is a visible pop; switching on early costs a
  // fraction of a millisecond on a full-screen pass that turns out to be a
  // no-op. So `active` deliberately leads `submerged` by the margin.
  it("activates before the camera is actually under", () => {
    const w = at(0).waterY;
    expect(at(w + SUBMERSION_MARGIN - 0.01).active).toBe(true);
    expect(at(w + SUBMERSION_MARGIN + 0.01).active).toBe(false);
    expect(at(w + 0.5).submerged).toBe(false);
  });

  it("takes a measured surface height over the estimate", () => {
    const measured = submersion(3, 0, 5, 0, () => 4);
    expect(measured.waterY).toBe(4);
    expect(measured.depth).toBe(4);
    expect(measured.submerged).toBe(true);
  });

  // The probe only runs once the passes are on, so gating the passes on the
  // probe's own answer would be circular -- `active` has to stay on the
  // estimate even when a measurement is available.
  it("gates activation on the estimate, not the measurement", () => {
    const farAbove = at(0).waterY + 100;
    expect(submersion(3, farAbove, 5, 0, () => farAbove).active).toBe(false);
  });
});

describe("water types", () => {
  it("is selected by ?water, defaulting to clear open ocean", () => {
    expect(withSearch("", waterTypeName)).toBe("II");
    expect(withSearch("?water=I", waterTypeName)).toBe("I");
    expect(withSearch("?water=3C", waterTypeName)).toBe("3C");
    expect(withSearch("?water=nonsense", waterTypeName)).toBe("II");
  });

  // waterMultiScatter divides by (Kd * dirY - sigma_t), and relies on that
  // never reaching zero. dirY is at most 1, so the guarantee it needs is
  // Kd < sigma_t in every channel of every preset. The shader clamps as
  // well, but the clamp is insurance -- this is the actual invariant.
  it("keeps Kd below the extinction coefficient in every channel", () => {
    for (const [name, type] of Object.entries(WATER_TYPES)) {
      for (let c = 0; c < 3; c++) {
        const sigmaT = type.sigmaA[c] + type.sigmaS[c];
        expect(type.kd[c], `${name} channel ${c}`).toBeLessThan(sigmaT);
      }
    }
  });

  it("absorbs red faster than blue in every preset", () => {
    for (const [name, type] of Object.entries(WATER_TYPES)) {
      expect(type.sigmaA[0], `${name} red`).toBeGreaterThan(type.sigmaA[2]);
    }
  });
});

describe("refractSun", () => {
  const dir = (x: number, y: number, z: number) =>
    refractSun(new THREE.Vector3(x, y, z).normalize());

  it("sends an overhead sun straight down", () => {
    const t = dir(0, 1, 0);
    expect(t.x).toBeCloseTo(0, 10);
    expect(t.y).toBeCloseTo(-1, 10);
    expect(t.z).toBeCloseTo(0, 10);
  });

  it("obeys Snell's law", () => {
    // 45 degrees in air refracts to asin(sin(45)/1.333) = 32.0 degrees.
    const t = dir(1, 1, 0);
    const fromVertical = Math.atan2(Math.hypot(t.x, t.z), -t.y);
    expect(fromVertical).toBeCloseTo(
      Math.asin(Math.SQRT1_2 / WATER_DEFAULTS.IOR), 10);
  });

  it("always points downward, even for a sun on the horizon", () => {
    for (const elevation of [1, 0.5, 0.1, 0.01, 0]) {
      const t = dir(1, elevation, 0.3);
      expect(t.y).toBeLessThan(0);
      expect(t.length()).toBeCloseTo(1, 10);
    }
  });
});

describe("waterFresnel", () => {
  it("reflects almost nothing head-on and everything at grazing", () => {
    expect(waterFresnel(1)).toBeCloseTo(0.02, 10);
    expect(waterFresnel(0)).toBeCloseTo(1, 10);
  });

  it("is monotonic and clamped outside [0, 1]", () => {
    expect(waterFresnel(-5)).toBeCloseTo(waterFresnel(0), 10);
    expect(waterFresnel(5)).toBeCloseTo(waterFresnel(1), 10);
    expect(waterFresnel(0.3)).toBeGreaterThan(waterFresnel(0.7));
  });
});
