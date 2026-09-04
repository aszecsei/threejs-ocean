import * as THREE from "three";
import * as flags from "../../flags.js";
import type { Defines, Uniform } from "../../core/types.js";
import FULLSCREEN_VERT from "../../shaders/common/fullscreen.vert.glsl";
import DOME_VERT from "../shaders/dome.vert.glsl";
import REFINE_FRAG from "./shaders/refine.frag.glsl";
import REFINE_RESOLVE_FRAG from "./shaders/refine-resolve.frag.glsl";

// `?cloud-refine=0` drops the full-res edge pass; the composite then reads
// the half-res image as before.
export function cloudRefineEnabled() { return flags.enabled("cloud-refine"); }

// Defines that describe the dome's MRT/temporal contract and must not reach
// the refinement march, which has one output and its own history.
const DOME_ONLY_DEFINES = new Set(["TAA_ENABLED", "CLOUD_TEMPORAL", "CLOUD_INTERLEAVED"]);

/**
 * Full-res edge refinement rig. `marchChunks` is the dome's fragment chunk
 * list up to and including march.core.glsl; `domeUniforms` are shared by
 * identity, with this pass's own resolution and inputs layered on top.
 */
export function createCloudRefine(
  renderer: THREE.WebGLRenderer,
  geometry: THREE.BufferGeometry,
  marchChunks: string[],
  domeUniforms: Record<string, Uniform<unknown>>,
  // The dome assembles its defines from conditional spreads, so the type
  // carries optional keys; undefined here means "not defined".
  domeDefines: Record<string, string | undefined>
) {
  const invResolution = new THREE.Vector2(1, 1);
  const invHalfResolution = new THREE.Vector2(1, 1);
  const defines: Defines = { CLOUD_REFINE: "", CLOUD_PREMULTIPLIED: "", EDGE_RANGE_LO: "0.05", EDGE_RANGE_HI: "0.22", EDGE_THIN_WEIGHT: "0.6" };
  for (const [key, value] of Object.entries(domeDefines)) if (value !== undefined && !DOME_ONLY_DEFINES.has(key)) defines[key] = value;
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    defines,
    uniforms: {
      ...domeUniforms,
      uInvResolution: { value: invResolution },
      uInvHalfResolution: { value: invHalfResolution },
      tCloudHalf: { value: null },
      tCloudHalfDisplay: { value: null },
    },
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
    vertexShader: DOME_VERT,
    fragmentShader: [...marchChunks, REFINE_FRAG].join("\n"),
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  const resolveMaterial = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    defines: { REFINE_HISTORY: "0.9" },
    uniforms: {
      tCurrent: { value: null }, tHistory: { value: null }, tHalfMeta: { value: null },
      uInvResolution: { value: invResolution }, uHistoryValid: { value: 0 },
    },
    depthTest: false,
    depthWrite: false,
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: REFINE_RESOLVE_FRAG,
  });
  const resolveScene = new THREE.Scene();
  const resolveCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), resolveMaterial);
  resolveScene.add(quad);
  const makeTarget = (w: number, h: number, name: string) => {
    const target = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    target.texture.name = name;
    return target;
  };
  let raw: THREE.WebGLRenderTarget | null = null;
  let histories: THREE.WebGLRenderTarget[] = [];
  let readIndex = 0, valid = false;
  const api = {
    material,
    resolveMaterial,
    /** The accumulated full-res image; what the composite should draw. */
    get texture() { return histories[readIndex]?.texture ?? null; },
    get historyValid() { return valid; },
    resize(width: number, height: number, halfWidth: number, halfHeight: number) {
      raw?.dispose(); for (const t of histories) t.dispose();
      raw = makeTarget(width, height, "CloudRefine.raw");
      histories = [makeTarget(width, height, "CloudRefine.history0"), makeTarget(width, height, "CloudRefine.history1")];
      invResolution.set(1 / width, 1 / height);
      invHalfResolution.set(1 / halfWidth, 1 / halfHeight);
      api.reset();
    },
    /**
     * `half` is the unblurred resolved half-res image (edge detection),
     * `display` the blurred one (fallback), `meta` its velocity buffer.
     */
    render(camera: THREE.Camera, domePosition: THREE.Vector3, inputs: { half: THREE.Texture; display: THREE.Texture; meta: THREE.Texture }) {
      mesh.position.copy(domePosition);
      material.uniforms.tCloudHalf.value = inputs.half;
      material.uniforms.tCloudHalfDisplay.value = inputs.display;
      renderer.setRenderTarget(raw);
      renderer.render(scene, camera);
      const writeIndex = 1 - readIndex;
      resolveMaterial.uniforms.tCurrent.value = raw!.texture;
      resolveMaterial.uniforms.tHistory.value = histories[readIndex].texture;
      resolveMaterial.uniforms.tHalfMeta.value = inputs.meta;
      resolveMaterial.uniforms.uHistoryValid.value = valid ? 1 : 0;
      renderer.setRenderTarget(histories[writeIndex]);
      renderer.render(resolveScene, resolveCamera);
      readIndex = writeIndex; valid = true;
    },
    reset() { valid = false; readIndex = 0; },
    dispose() {
      raw?.dispose(); for (const t of histories) t.dispose();
      material.dispose(); resolveMaterial.dispose(); quad.geometry.dispose();
    },
  };
  return api;
}

/** The refinement rig returned by {@link createCloudRefine}. */
export type CloudRefine = ReturnType<typeof createCloudRefine>;
