import * as THREE from "three";
import * as flags from "../../flags.js";
import type { Defines, Uniform } from "../../core/types.js";
import CLOUD_DENSITY_GLSL from "../shaders/density.glsl";
import DOME_VERT from "../shaders/dome.vert.glsl";
import OCCUPANCY_FRAG from "./shaders/occupancy.frag.glsl";

// One occupancy texel per TILE x TILE drawing-buffer pixels. The dome passes
// gather 3x3 texels, so a tile edge never produces a hole.
const TILE = 8;

// `?cloud-occupancy=0` drops the prepass (the march covers the whole slab
// again, which is the A/B for "did the prepass miss anything").
export function cloudOccupancyEnabled() { return flags.enabled("cloud-occupancy"); }

export function createCloudOccupancy(
  renderer: THREE.WebGLRenderer,
  geometry: THREE.BufferGeometry,
  densityUniforms: Record<string, Uniform<unknown>>,
  densityDefines: Defines
) {
  const size = new THREE.Vector2(1, 1);
  // Shared by identity with every march material that narrows on this map.
  const uniforms = {
    tCloudOccupancy: { value: null as THREE.Texture | null },
    uOccupancySize: { value: size },
  };
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    // OCCUPANCY_MARGIN widens the coverage threshold so 64 fixed strata
    // bound everything the jittered fine march can find (see density.glsl).
    defines: { ...densityDefines, CLOUD_OCCUPANCY_MAP: "", OCCUPANCY_STEPS: "64", OCCUPANCY_MARGIN: "0.12" },
    uniforms: { ...densityUniforms },
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
    vertexShader: DOME_VERT,
    fragmentShader: [CLOUD_DENSITY_GLSL, OCCUPANCY_FRAG].join("\n"),
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  let target: THREE.WebGLRenderTarget | null = null;
  const api = {
    tile: TILE,
    uniforms,
    material,
    get texture() { return target?.texture ?? null; },
    get target() { return target; },
    /** Sizes the map from the drawing-buffer size, not the dome target's. */
    resize(width: number, height: number) {
      const w = Math.max(1, Math.floor(width / TILE)), h = Math.max(1, Math.floor(height / TILE));
      target?.dispose();
      // Read with texelFetch: filtering a [entry, exit] pair would invent
      // spans that neither neighbour has.
      target = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: false,
        stencilBuffer: false,
      });
      target.texture.name = "Cloud.occupancy";
      size.set(w, h);
      uniforms.tCloudOccupancy.value = target.texture;
    },
    /** Renders with the frame's (jittered) camera so tiles line up with the march. */
    render(camera: THREE.Camera, domePosition: THREE.Vector3) {
      mesh.position.copy(domePosition);
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
    },
    dispose() { target?.dispose(); material.dispose(); },
  };
  return api;
}

/** The occupancy prepass rig returned by {@link createCloudOccupancy}. */
export type CloudOccupancy = ReturnType<typeof createCloudOccupancy>;
