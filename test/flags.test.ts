// Flag parsing is where a refactor quietly changes behavior: every reader has
// its own tolerance for absent, empty, negative and junk values, and getting
// one wrong silently selects a different render path rather than failing.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as flags from "../src/flags.js";

/** Runs `fn` as if the page had been loaded with `search`. */
function withSearch<T>(search: string, fn: () => T): T {
  vi.stubGlobal("window", { location: { search } });
  return fn();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("enabled", () => {
  it("defaults to on when absent", () => {
    expect(withSearch("", () => flags.enabled("x"))).toBe(true);
  });

  it("treats a bare flag as on", () => {
    expect(withSearch("?x", () => flags.enabled("x"))).toBe(true);
    expect(withSearch("?x=", () => flags.enabled("x"))).toBe(true);
  });

  it("is off only for 0 and false", () => {
    expect(withSearch("?x=0", () => flags.enabled("x"))).toBe(false);
    expect(withSearch("?x=false", () => flags.enabled("x"))).toBe(false);
    for (const v of ["1", "true", "no", "off", "-1"]) {
      expect(withSearch(`?x=${v}`, () => flags.enabled("x"))).toBe(true);
    }
  });
});

describe("num", () => {
  it("falls back when absent or unparseable", () => {
    expect(withSearch("", () => flags.num("x", 7))).toBe(7);
    expect(withSearch("?x=abc", () => flags.num("x", 7))).toBe(7);
  });

  it("reads an empty value as 0, not as the fallback", () => {
    // Number("") is 0, and the readers this replaced behaved the same way, so
    // `?bloom=` has always meant "no bloom" rather than "default bloom".
    expect(withSearch("?x=", () => flags.num("x", 7))).toBe(0);
  });

  it("clamps rather than rejecting out-of-range values", () => {
    expect(withSearch("?x=-5", () => flags.num("x", 1, { min: 0 }))).toBe(0);
    expect(withSearch("?x=99", () => flags.num("x", 1, { max: 2 }))).toBe(2);
  });

  it("accepts fractions and negatives", () => {
    expect(withSearch("?x=0.25", () => flags.num("x", 1))).toBe(0.25);
    expect(withSearch("?x=-3", () => flags.num("x", 1))).toBe(-3);
  });

  it("rejects Infinity, which would poison whatever it scales", () => {
    expect(withSearch("?x=Infinity", () => flags.num("x", 7))).toBe(7);
  });
});

describe("int", () => {
  it("parses a leading integer and ignores the rest", () => {
    expect(withSearch("?x=12px", () => flags.int("x", 0))).toBe(12);
  });

  it("falls back on a non-numeric value", () => {
    expect(withSearch("?x=abc", () => flags.int("x", 4))).toBe(4);
  });
});

describe("oneOf", () => {
  const modes = ["velocity", "history"] as const;

  it("accepts a listed value", () => {
    expect(withSearch("?x=history", () => flags.oneOf("x", modes, "velocity"))).toBe("history");
  });

  it("falls back for anything else, including absent", () => {
    expect(withSearch("?x=nope", () => flags.oneOf("x", modes, "velocity"))).toBe("velocity");
    expect(withSearch("", () => flags.oneOf("x", modes, "velocity"))).toBe("velocity");
  });
});

describe("is and raw and str", () => {
  it("compares exactly", () => {
    expect(withSearch("?x=debug", () => flags.is("x", "debug"))).toBe(true);
    expect(withSearch("?x=Debug", () => flags.is("x", "debug"))).toBe(false);
    expect(withSearch("", () => flags.is("x", "debug"))).toBe(false);
  });

  it("distinguishes absent from empty", () => {
    expect(withSearch("", () => flags.raw("x"))).toBeNull();
    expect(withSearch("?x=", () => flags.raw("x"))).toBe("");
    // str's fallback applies only when absent, so an empty flag stays empty.
    expect(withSearch("", () => flags.str("x", "d"))).toBe("d");
    expect(withSearch("?x=", () => flags.str("x", "d"))).toBe("");
  });
});

describe("reader quirks worth not 'fixing'", () => {
  it("reads the search string per call, so it is never stale", () => {
    expect(withSearch("?x=1", () => flags.raw("x"))).toBe("1");
    expect(withSearch("?x=2", () => flags.raw("x"))).toBe("2");
  });
});
