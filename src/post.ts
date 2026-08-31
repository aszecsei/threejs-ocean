import * as THREE from "three";
import * as flags from "./flags.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { createTemporalAA } from "./taa.js";

// --- Post pipeline -----------------------------------------------------------
// Every draw targets `frame` in linear HDR. With TAA, attachment 1 carries
// velocity, previous depth, and reactivity while a float depth texture holds
// current depth. finish() resolves unbloomed temporal history into a separate
// display target, adds bloom there, then OutputPass applies ACES and sRGB once.
// ?taa=0 keeps the original single-attachment path. three.js only honors
// renderer.toneMapping/outputColorSpace for canvas output, so intermediate
// materials remain linear.
//
// `?bloom=0` disables bloom (tone mapping stays), `?bloom=<k>` scales it.
export const POST_DEFAULTS = {
  BLOOM_STRENGTH: 0.25, // subtle: reads as haze around the sun and glints
  BLOOM_RADIUS: 0.4,
  BLOOM_THRESHOLD: 2.0, // linear luma; above the sun-side sky, so only the
                        // sun disc, ocean/knot glints and bright cloud rims bloom
};

export function bloomStrength() {
  if (flags.is("bloom", "false")) return 0;
  return flags.num("bloom", 1, { min: 0 });
}

export interface PostPipelineOptions {
  /** Bloom strength multiplier; 0 disables the pass. */
  bloom?: number;
  camera: THREE.PerspectiveCamera;
}

export function createPostPipeline(
  renderer: THREE.WebGLRenderer,
  { bloom = 1, camera }: PostPipelineOptions
) {
  if (!camera) throw new Error("createPostPipeline requires the scene camera");
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const taa = createTemporalAA(renderer, camera);

  // TAA adds a motion-data attachment and a sampleable depth texture. The
  // fallback stays identical to the old single-attachment HDR target.
  const makeFrame = () => {
    const target = new THREE.WebGLRenderTarget(size.x, size.y, {
      ...(taa.enabled ? { count: 2 } : {}),
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      ...(taa.enabled
        ? { depthTexture: new THREE.DepthTexture(size.x, size.y, THREE.FloatType) }
        : {}),
      depthBuffer: true,
      stencilBuffer: false,
    });
    target.textures[0].name = "Post.currentColor";
    if (taa.enabled) target.textures[1].name = "Post.currentMotion";
    return target;
  };
  let frame = makeFrame();

  const bloomPass =
    bloom > 0
      ? new UnrealBloomPass(
          size.clone(),
          POST_DEFAULTS.BLOOM_STRENGTH * bloom,
          POST_DEFAULTS.BLOOM_RADIUS,
          POST_DEFAULTS.BLOOM_THRESHOLD
        )
      : null;
  const outputPass = new OutputPass();
  outputPass.renderToScreen = true;

  return {
    get frame() { return frame; },
    taa,
    bloomPass,
    resize() {
      renderer.getDrawingBufferSize(size);
      frame.dispose();
      frame = makeFrame();
      taa.resize();
      if (bloomPass) bloomPass.setSize(size.x, size.y);
    },
    // Resolve the linear HDR frame first. Bloom works on the disposable TAA
    // display target, never on the pre-bloom temporal history.
    finish() {
      const display = taa.enabled ? taa.resolve(frame) : frame;
      // Diagnostic views show raw motion/history data and deliberately skip
      // bloom, while OutputPass still gives them normal display encoding.
      if (bloomPass && !taa.diagnostic) bloomPass.render(renderer, null!, display, 0, false);
      outputPass.render(renderer, null!, display, 0, false);
      renderer.setRenderTarget(null);
    },
    dispose() {
      frame.dispose();
      taa.dispose();
      bloomPass?.dispose();
      outputPass.dispose();
    },
  };
}

/** The post pipeline returned by {@link createPostPipeline}. */
export type PostPipeline = ReturnType<typeof createPostPipeline>;
