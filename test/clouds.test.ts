// The cloud shaders are assembled from chunks at runtime, and the edge
// refinement pass depends on two things that nothing else checks: the edge
// mask chunk actually resolving into the refinement shader, and the dome
// and refinement passes composing the same march core. A missing include
// would only surface as a GLSL compile error in the browser.
import { describe, expect, it } from "vitest";
import EDGE_MASK from "../src/clouds/shaders/edge-mask.glsl";
import REFINE_FRAG from "../src/clouds/refine/shaders/refine.frag.glsl";
import MARCH_CORE from "../src/clouds/shaders/march.core.glsl";
import MARCH_MAIN from "../src/clouds/shaders/march.main.glsl";
import DENSITY from "../src/clouds/shaders/density.glsl";

describe("edge refinement shader", () => {
  it("resolves the edge-mask include into the refinement shader", () => {
    // vite-plugin-glsl inlines #include at import time; the include line
    // itself must be gone or the browser sees an unknown directive.
    expect(REFINE_FRAG).not.toMatch(/#include\s+"[^"]*edge-mask/);
    expect(REFINE_FRAG).toContain(EDGE_MASK.trim());
  });

  it("declares cloudEdgeWeight exactly once", () => {
    const declarations = REFINE_FRAG.match(/float cloudEdgeWeight\(/g);
    expect(declarations).toHaveLength(1);
  });

  it("marches through the shared core, not a private loop", () => {
    for (const entry of [REFINE_FRAG, MARCH_MAIN]) {
      expect(entry).toContain("marchClouds(");
      expect(entry).toContain("occupancyNarrow(");
      expect(entry).toContain("cloudSlab(");
      expect(entry).not.toContain("for(int i=0;i<PRIMARY_STEPS;i++)");
    }
    expect(MARCH_CORE).toContain("for(int i=0;i<PRIMARY_STEPS;i++)");
  });

  it("scales the refinement step to the occupied span, and the dome's to the slab", () => {
    // The dome's step must stay slab-sized: ?cloud-occupancy=0 is a
    // pixel-exact A/B for prepass misses only while the sampling rate does
    // not depend on the narrowing. The refinement pass is where the freed
    // iterations are spent, behind a define the flag can compile out.
    expect(REFINE_FRAG).toContain("occupancySpanStep(slabStep,t0,t1)");
    expect(REFINE_FRAG).toContain("slabStep/baseStep");
    expect(MARCH_MAIN).not.toContain("occupancySpanStep(");
    expect(MARCH_MAIN).toContain("baseStep,1.0,");
    const helper = MARCH_CORE.slice(MARCH_CORE.indexOf("float occupancySpanStep("));
    const gate = helper.indexOf("#if defined(CLOUD_OCCUPANCY) && defined(OCCUPANCY_SPAN_STEPS)");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(helper.indexOf("OCCUPANCY_MIN_STEP"));
    // Finer primary steps must not multiply the light marches: the reuse
    // cadence scales with the step ratio.
    expect(MARCH_CORE).toContain("if(odAge>=odCadence)");
    expect(MARCH_CORE).toMatch(/int odCadence=int\(clamp\(2\.0\*stepRatio/);
  });

  it("keeps the wisp band out of the coarse density path", () => {
    // The shadow map and the occupancy prepass compile density.glsl without
    // CLOUD_WISP; the wisp block must be gated so they never pay for it.
    const block = DENSITY.slice(DENSITY.indexOf("#ifdef CLOUD_WISP", DENSITY.indexOf("float shell=")));
    expect(block).toMatch(/if \(erode && wispFade>0\.0/);
  });

  it("pays for the filament gradient only in the refinement pass, inside the shell gate", () => {
    // The gradient steering costs two extra base fetches per sample. It
    // must sit inside the wisp block (behind the shell gate) and behind
    // CLOUD_REFINE, so the half-res dome, the shadow map and the occupancy
    // prepass never compile it.
    const wispBlock = DENSITY.slice(DENSITY.indexOf("#ifdef CLOUD_WISP", DENSITY.indexOf("float shell=")));
    const gate = wispBlock.indexOf("if (erode && wispFade>0.0");
    const gradient = wispBlock.indexOf("WISP_GRADIENT_EPS");
    expect(gate).toBeGreaterThan(-1);
    expect(gradient).toBeGreaterThan(gate);
    const guard = wispBlock.lastIndexOf("#if defined(CLOUD_REFINE) && defined(CLOUD_WISP_GRADIENT)", gradient);
    expect(guard).toBeGreaterThan(gate);
    // The second, finer octave is refinement-only for the same reason.
    const octave = wispBlock.indexOf("wispN2");
    expect(wispBlock.lastIndexOf("#ifdef CLOUD_REFINE", octave)).toBeGreaterThan(gate);
  });

  it("keeps the base-shape gradient out of the shadow and occupancy density paths", () => {
    // Everything before the wisp block is shared with every caller; the
    // only base-signal reads there are the shape itself and the mid band.
    const shared = DENSITY.slice(0, DENSITY.indexOf("float shell="));
    expect(shared).not.toContain("WISP_GRADIENT");
    expect(shared).not.toContain("WISP_STRETCH");
  });
});
