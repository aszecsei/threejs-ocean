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

  it("keeps the wisp band out of the coarse density path", () => {
    // The shadow map and the occupancy prepass compile density.glsl without
    // CLOUD_WISP; the wisp block must be gated so they never pay for it.
    const block = DENSITY.slice(DENSITY.indexOf("#ifdef CLOUD_WISP", DENSITY.indexOf("float shell=")));
    expect(block).toMatch(/if \(erode && wispFade>0\.0/);
  });
});
