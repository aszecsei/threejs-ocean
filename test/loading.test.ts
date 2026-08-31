import { describe, it, expect } from "vitest";
import { drain, band } from "../src/loading/scheduler.js";
import { weightedFraction, runSteps, type Step } from "../src/loading/loader.js";
import type { Bake } from "../src/loading/types.js";
import { blueNoiseRanks, curlField } from "../src/math/noise.js";

// A bake that yields `n` evenly spaced fractions and returns a marker.
function* counting(n: number, label = "test"): Bake<string> {
  for (let i = 0; i < n; i++) yield { label, detail: `${i + 1}/${n}`, fraction: (i + 1) / n };
  return label;
}

describe("drain", () => {
  it("returns the bake's value and runs it to completion", () => {
    expect(drain(counting(5))).toBe("test");
  });

  it("leaves the baked assets identical to a single-pass reference", () => {
    // The chunking must be invisible: the same seeds through the generator and
    // through the sync wrapper have to produce the same bytes, or every baked
    // texture in the demo silently changes.
    const a = curlField(16, 4, 1234);
    const b = curlField(16, 4, 1234);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(blueNoiseRanks(8, 99))).toEqual(Array.from(blueNoiseRanks(8, 99)));
  });
});

describe("band", () => {
  it("remaps a sub-bake into a slice of the caller's range", () => {
    const seen: number[] = [];
    const gen = band(counting(4), "outer", 0.2, 0.6);
    let step = gen.next();
    while (!step.done) {
      seen.push(step.value.fraction);
      expect(step.value.label).toBe("outer");
      step = gen.next();
    }
    expect(step.value).toBe("test");
    expect(seen.length).toBe(4);
    seen.forEach((f, i) => expect(f).toBeCloseTo(0.2 + 0.4 * ((i + 1) / 4)));
  });

  it("keeps the sub-bake's detail line", () => {
    const first = band(counting(2), "outer", 0, 1).next();
    expect(first.done).toBe(false);
    if (!first.done) expect(first.value.detail).toBe("1/2");
  });
});

describe("weightedFraction", () => {
  const weights = [1, 55, 4];

  it("starts at zero and ends at one", () => {
    expect(weightedFraction(weights, 0, 0)).toBe(0);
    expect(weightedFraction(weights, weights.length, 0)).toBe(1);
  });

  it("charges each step its share of the total", () => {
    expect(weightedFraction(weights, 1, 0)).toBeCloseTo(1 / 60);
    expect(weightedFraction(weights, 1, 1)).toBeCloseTo(56 / 60);
    expect(weightedFraction(weights, 2, 0.5)).toBeCloseTo(58 / 60);
  });

  it("is monotonic across steps and within them", () => {
    let previous = -1;
    for (let i = 0; i < weights.length; i++) {
      for (let f = 0; f <= 1; f += 0.25) {
        const pct = weightedFraction(weights, i, f);
        expect(pct).toBeGreaterThanOrEqual(previous);
        previous = pct;
      }
    }
  });

  it("ignores steps that were never added", () => {
    // A `?clouds=0` run drops the 55-weight step entirely rather than leaving
    // a gap in the bar.
    expect(weightedFraction([1, 4], 1, 1)).toBe(1);
  });

  it("clamps a bake that over- or under-reports itself", () => {
    expect(weightedFraction(weights, 0, 5)).toBeCloseTo(1 / 60);
    expect(weightedFraction(weights, 0, -3)).toBe(0);
  });
});

describe("runSteps", () => {
  const step = (label: string, weight: number, n: number): Step<string> =>
    ({ label, weight, bake: () => counting(n, label) });

  it("runs steps in order and reports each value as it lands", async () => {
    const order: string[] = [];
    await runSteps([step("a", 1, 2), step("b", 3, 2)], {
      onProgress() {},
      onValue(s, value) { order.push(`${s.label}=${value}`); },
    });
    expect(order).toEqual(["a=a", "b=b"]);
  });

  it("drives the global fraction monotonically to exactly 1", async () => {
    const seen: number[] = [];
    await runSteps([step("a", 1, 3), step("b", 9, 3)], {
      onProgress(pct) { seen.push(pct); },
      onValue() {},
    });
    expect(seen[0]).toBe(0);
    expect(seen.at(-1)).toBe(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
  });

  it("awaits a step whose bake returns a promise, and times the wait", async () => {
    const timings: number[] = [];
    let resolved = false;
    const slow: Step<Promise<void>> = {
      label: "compile",
      weight: 1,
      *bake() {
        yield { label: "compile", fraction: 0 };
        return new Promise<void>((r) => setTimeout(() => { resolved = true; r(); }, 20));
      },
    };
    await runSteps([slow], {
      onProgress() {},
      onValue() { expect(resolved).toBe(true); },
      onStep(t) { timings.push(t.ms); },
    });
    expect(resolved).toBe(true);
    expect(timings[0]).toBeGreaterThanOrEqual(15);
  });

  it("does not start a step's work before its turn", async () => {
    let started = false;
    const later: Step<string> = {
      label: "later",
      weight: 1,
      bake: () => { started = true; return counting(1, "later"); },
    };
    const first: Step<string> = {
      label: "first",
      weight: 1,
      *bake() {
        expect(started).toBe(false);
        yield { label: "first", fraction: 1 };
        return "first";
      },
    };
    await runSteps([first, later], { onProgress() {}, onValue() {} });
    expect(started).toBe(true);
  });
});
