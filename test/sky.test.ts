// The sky is written twice: once in GLSL (sky-color.glsl) and once in JS
// (skyPhysicalJS), because fog, background and light colors are derived on the
// CPU from the same model the shader draws. The only thing holding the two
// together is that the GLSL constants are generated from SKY_CONSTS. These
// tests guard that generation, and the scene colors that fall out of it.
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  GRADE_LUT_SIZE,
  PALETTE_GAIN,
  SKY_COLOR_GLSL,
  SKY_CONSTS,
  SKY_PALETTE,
  deriveSceneColors,
  gradePalette,
  sampleSkyColor,
} from "../src/sky/index.js";

const SUN = new THREE.Vector3(0.45, 0.62, -0.65).normalize();

describe("generated GLSL constants", () => {
  it("declares every SKY_CONSTS entry", () => {
    // A key added to SKY_CONSTS but not reaching the shader would silently
    // leave the GPU and CPU skies describing different atmospheres.
    for (const key of Object.keys(SKY_CONSTS)) {
      expect(SKY_COLOR_GLSL).toContain(`const float ${key} =`);
    }
  });

  it("declares each one exactly once", () => {
    for (const key of Object.keys(SKY_CONSTS)) {
      const hits = SKY_COLOR_GLSL.match(new RegExp(`const float ${key} =`, "g"));
      expect(hits).toHaveLength(1);
    }
  });

  it("emits values that round-trip back to SKY_CONSTS", () => {
    for (const [key, value] of Object.entries(SKY_CONSTS)) {
      const m = SKY_COLOR_GLSL.match(new RegExp(`const float ${key} = ([^;]+);`));
      expect(m).not.toBeNull();
      expect(Number(m![1])).toBeCloseTo(value, 10);
    }
  });

  it("writes every float with a decimal point or exponent", () => {
    // `const float X = 1;` is a type error in GLSL, so an integer-valued
    // constant has to come out as `1.0`.
    for (const [, literal] of SKY_COLOR_GLSL.matchAll(/const float \w+ = ([^;]+);/g)) {
      expect(literal).toMatch(/[.e]/);
    }
  });

  it("derives the grade LUT sampling from GRADE_LUT_SIZE", () => {
    const scale = SKY_COLOR_GLSL.match(/GRADE_LUT_SCALE = ([^;]+);/);
    const offset = SKY_COLOR_GLSL.match(/GRADE_LUT_OFFSET = ([^;]+);/);
    expect(Number(scale![1])).toBeCloseTo((GRADE_LUT_SIZE - 1) / GRADE_LUT_SIZE, 12);
    expect(Number(offset![1])).toBeCloseTo(0.5 / GRADE_LUT_SIZE, 12);
  });
});

describe("gradePalette", () => {
  it("applies the gain per channel and leaves the sun alone", () => {
    const p = gradePalette();
    const zenith = new THREE.Color(SKY_PALETTE.zenith);
    expect(p.zenith.r).toBeCloseTo(zenith.r * PALETTE_GAIN.zenith, 10);
    // The sun is a light color, not a graded gradient stop.
    expect(p.sun.getHex()).toBe(new THREE.Color(SKY_PALETTE.sun).getHex());
  });
});

describe("deriveSceneColors", () => {
  const colors = deriveSceneColors(SUN);

  it("is deterministic", () => {
    const again = deriveSceneColors(SUN);
    expect(colors.horizon.getHex()).toBe(again.horizon.getHex());
    expect(colors.zenith.getHex()).toBe(again.zenith.getHex());
  });

  it("returns finite, non-negative linear colors", () => {
    for (const c of [colors.horizon, colors.zenith, colors.ground]) {
      for (const ch of [c.r, c.g, c.b]) {
        expect(Number.isFinite(ch)).toBe(true);
        expect(ch).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("keeps the sky blue: more blue than red, at the horizon and the zenith", () => {
    expect(colors.horizon.b).toBeGreaterThan(colors.horizon.r);
    expect(colors.zenith.b).toBeGreaterThan(colors.zenith.r);
  });

  it("makes the zenith deeper than the horizon", () => {
    // Rayleigh depth: looking up is a shorter path, so less scattered light.
    const luma = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    expect(luma(colors.zenith)).toBeLessThan(luma(colors.horizon));
  });
});

describe("sampleSkyColor", () => {
  it("brightens toward the sun", () => {
    const at = sampleSkyColor(SUN.clone(), SUN);
    const away = sampleSkyColor(SUN.clone().negate(), SUN);
    const luma = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    expect(luma(at)).toBeGreaterThan(luma(away));
  });

  it("does not mutate the direction it is given", () => {
    const dir = new THREE.Vector3(0, 1, 0);
    sampleSkyColor(dir, SUN);
    expect(dir.toArray()).toEqual([0, 1, 0]);
  });
});
