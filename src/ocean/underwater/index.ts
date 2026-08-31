import * as THREE from "three";
import * as flags from "../../flags.js";
import { OCEAN_LAYER } from "../index.js";
import { taaMaterialConfig, type TaaApi } from "../../taa/index.js";
import type { OceanRig } from "../index.js";
import type { WaterMedium } from "./water.js";
import FULLSCREEN_VERT from "../../shaders/common/fullscreen.vert.glsl";
import OCEAN_VERT from "../shaders/ocean.vert.glsl";
import MASK_FRAG from "./shaders/mask.frag.glsl";
import UNDERWATER_FRAG from "./shaders/underwater.frag.glsl";

// --- Underwater rendering ----------------------------------------------------
// Two passes around the existing frame:
//
//   1. The water mask, before the scene is drawn: the ocean mesh alone, with
//      the ocean's own vertex shader and back faces enabled, into a target
//      that records which side of the surface each ray meets first and how
//      far away it is.
//   2. The resolve, after the ocean has drawn: one full-screen pass that
//      grades the finished frame through the water column -- Beer-Lambert
//      extinction plus the closed-form multiple-scattering term from
//      scatter.glsl -- and writes to the post pipeline's scratch target.
//
// Both are skipped whenever the camera is well clear of the surface, so the
// above-water frame is untouched and costs nothing.

export const UNDERWATER_DEFAULTS = {
  // Meniscus. PORT is the notional radius of the camera housing's front
  // element: the only length scale over which a waterline can be partway up
  // the glass, and so the only thing that decides how long the crossing
  // lasts. Everything else is look.
  MENISCUS_PORT: 0.15,     // metres
  MENISCUS_WIDTH: 0.05,    // half-width of the band, in ray dir.y
  MENISCUS_SMEAR: 0.035,   // how far across the line the film drags, uv
  MENISCUS_LIFT: 1.1,      // brightness of the rim above the lip
  MENISCUS_STRENGTH: 0.9,

  // Single-scattering shafts.
  SHAFT_STEPS: 16,
  /** How far along the view ray the march goes, metres. Past this the water
   *  has taken the light anyway, and it bounds the cost of a ray that looks
   *  down the length of the sea. */
  SHAFT_RANGE: 70.0,
  /** Art control on the shafts. The physical integral lands where the rest of
   *  the scene's calibration puts it, which is brighter than reads well
   *  against an ACES curve; this is the one knob that says so honestly. */
  SHAFT_STRENGTH: 0.4,
};

export const UNDERWATER_DEBUG_MODES = ["mask", "depth", "caustics"] as const;
export type UnderwaterDebugMode = (typeof UNDERWATER_DEBUG_MODES)[number] | "off";

/** `?underwater=0` restores the pre-feature behaviour (a hole in the sea). */
export function underwaterEnabled() {
  return flags.enabled("underwater");
}

/** `?underwater-debug=mask|depth|caustics` shows an intermediate. */
export function underwaterDebug(): UnderwaterDebugMode {
  return flags.oneOf("underwater-debug", UNDERWATER_DEBUG_MODES, "off");
}

/** `?meniscus=0` drops the waterline film. */
export function meniscusEnabled() {
  return flags.enabled("meniscus");
}

/** `?shafts=0` drops single scattering; `?shafts=<n>` sets the step count. */
export function shaftSteps() {
  if (!flags.enabled("shafts")) return 0;
  return flags.int("shafts", UNDERWATER_DEFAULTS.SHAFT_STEPS, { min: 1, max: 64 });
}

export interface UnderwaterOptions extends Partial<typeof UNDERWATER_DEFAULTS> {
  taa?: TaaApi | null;
  debug?: UnderwaterDebugMode;
  /** The waterline film; defaults to the `?meniscus` flag. */
  meniscus?: boolean;
  /** Shaft march steps; 0 disables. Defaults to the `?shafts` flag. */
  shafts?: number;
  /** Whether a caustic map exists to band the shafts with. */
  caustics?: boolean;
}

export function createUnderwater(
  renderer: THREE.WebGLRenderer,
  camera: THREE.PerspectiveCamera,
  ocean: OceanRig,
  medium: WaterMedium,
  opts: UnderwaterOptions = {}
) {
  const o = { ...UNDERWATER_DEFAULTS, ...opts };
  const taa = opts.taa ?? null;
  const debug = opts.debug ?? underwaterDebug();
  const meniscus = opts.meniscus ?? meniscusEnabled();
  const shafts = opts.shafts ?? shaftSteps();
  const caustics = opts.caustics ?? false;
  const taaConfig = taaMaterialConfig(taa);
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());

  // Full resolution: the mask's front/back boundary *is* the waterline, and
  // the meniscus is drawn on it, so a half-res edge would read as a staircase
  // across the lens.
  const makeMask = () =>
    new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      stencilBuffer: false,
    });
  let maskTarget = makeMask();
  maskTarget.texture.name = "Underwater.mask";

  // The ocean's own vertex stage, so the mask lands on the displaced surface
  // rather than a wave-height away from it. No TAA defines: the mask has no
  // motion attachment, which also compiles away the previous-frame block.
  const cascade2 = "uDisplace2" in ocean.uniforms;
  const maskMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uDisplace: ocean.uniforms.uDisplace,
      uPatchSize: ocean.uniforms.uPatchSize,
      ...(cascade2
        ? {
            uDisplace2: ocean.uniforms.uDisplace2!,
            uPatchSize2: ocean.uniforms.uPatchSize2!,
            uCascade2Fade: ocean.uniforms.uCascade2Fade!,
          }
        : {}),
    },
    defines: cascade2 ? { OCEAN_CASCADE2: "" } : {},
    // The whole point: from below, the surface is a back face.
    side: THREE.DoubleSide,
    vertexShader: OCEAN_VERT,
    fragmentShader: MASK_FRAG,
  });

  const quadScene = new THREE.Scene();
  const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  quad.frustumCulled = false;
  quadScene.add(quad);

  const resolveMaterial = new THREE.ShaderMaterial({
    uniforms: {
      tFrame: { value: null as THREE.Texture | null },
      tSceneDepth: { value: null as THREE.Texture | null },
      tMask: { value: maskTarget.texture },
      ...(taa?.enabled
        ? {
            tFrameMotion: { value: null as THREE.Texture | null },
            tFrameDepth: { value: null as THREE.Texture | null },
          }
        : {}),
      uInverseProjection: { value: new THREE.Matrix4() },
      uCameraWorld: { value: new THREE.Matrix4() },
      uCameraPosition: { value: new THREE.Vector3() },
      uCameraNear: { value: camera.near },
      uCameraFar: { value: camera.far },
      uCameraSubmerged: { value: 0 },
      uMeniscusHeight: { value: 1 },
      ...(shafts > 0 ? { uShaftFrame: { value: 0 } } : {}),
      ...medium.uniforms,
    },
    glslVersion: taaConfig.glslVersion,
    defines: {
      ...taaConfig.defines,
      ...(meniscus
        ? {
            WATER_MENISCUS: "",
            MENISCUS_PORT: o.MENISCUS_PORT.toFixed(4),
            MENISCUS_WIDTH: o.MENISCUS_WIDTH.toFixed(4),
            MENISCUS_SMEAR: o.MENISCUS_SMEAR.toFixed(4),
            MENISCUS_LIFT: o.MENISCUS_LIFT.toFixed(3),
            MENISCUS_STRENGTH: o.MENISCUS_STRENGTH.toFixed(3),
          }
        : {}),
      ...(shafts > 0
        ? {
            WATER_SHAFTS: "",
            WATER_SHAFT_STEPS: String(shafts),
            WATER_SHAFT_RANGE: o.SHAFT_RANGE.toFixed(2),
            WATER_SHAFT_STRENGTH: o.SHAFT_STRENGTH.toFixed(4),
          }
        : {}),
      ...(caustics ? { WATER_CAUSTICS: "" } : {}),
      // Always defined: the GLSL ES preprocessor rejects an unknown
      // identifier in `#if`, where C would have quietly substituted 0.
      UNDERWATER_DEBUG:
        debug === "mask" ? "1" : debug === "depth" ? "2" : debug === "caustics" ? "3" : "0",
    },
    // Matches capture-blit: the pass owns every pixel and carries the frame's
    // depth across for the TAA resolve that reads it next.
    depthTest: true,
    depthWrite: true,
    depthFunc: THREE.AlwaysDepth,
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: UNDERWATER_FRAG,
  });

  const u = resolveMaterial.uniforms;
  // Rotates the shaft march's dither. Reset with the temporal history, so a
  // deterministic capture always dithers the same way.
  let shaftFrame = 0;

  return {
    get maskTexture() { return maskTarget.texture; },

    /** Drops the frame-varying dither, alongside the other temporal state. */
    reset() { shaftFrame = 0; },

    resize() {
      renderer.getDrawingBufferSize(size);
      maskTarget.dispose();
      maskTarget = makeMask();
      maskTarget.texture.name = "Underwater.mask";
      u.tMask.value = maskTarget.texture;
    },

    /**
     * Per-frame CPU state. `height` is the camera's signed height above the
     * water surface; `submerged` is the CPU swell's guess at the camera
     * itself, which the resolve falls back on only for rays that miss the
     * ocean disc.
     */
    update(height: number, submerged: boolean) {
      medium.update(-height);
      u.uCameraSubmerged.value = submerged ? 1 : 0;
      u.uMeniscusHeight.value = height;
    },

    /**
     * The mask pass. Must run after `taa.beginFrame` so it is drawn with the
     * same jitter as the frame it will be sampled against.
     */
    renderMask(scene: THREE.Scene) {
      const previousMaterial = ocean.mesh.material;
      const previousLayers = camera.layers.mask;
      const previousBackground = scene.background;
      const previousVisible = ocean.mesh.visible;
      // A Color background makes three force-clear to it, which would set the
      // "ocean was here" flag everywhere.
      scene.background = null;
      ocean.mesh.material = maskMaterial;
      ocean.mesh.visible = true;
      camera.layers.set(OCEAN_LAYER);
      renderer.setRenderTarget(maskTarget);
      renderer.clear();
      renderer.render(scene, camera);
      ocean.mesh.material = previousMaterial;
      ocean.mesh.visible = previousVisible;
      camera.layers.mask = previousLayers;
      scene.background = previousBackground;
    },

    /**
     * Grades `frame` through the water into `scratch`, and returns whichever
     * target the post pipeline should now resolve.
     */
    resolve(
      frame: THREE.WebGLRenderTarget,
      scratch: THREE.WebGLRenderTarget,
      sceneDepth: THREE.Texture
    ): THREE.WebGLRenderTarget {
      u.tFrame.value = frame.textures[0];
      u.tSceneDepth.value = sceneDepth;
      if (taa?.enabled) {
        u.tFrameMotion!.value = frame.textures[1];
        u.tFrameDepth!.value = frame.depthTexture;
      }
      u.uInverseProjection.value.copy(camera.projectionMatrixInverse);
      u.uCameraWorld.value.copy(camera.matrixWorld);
      u.uCameraPosition.value.setFromMatrixPosition(camera.matrixWorld);
      u.uCameraNear.value = camera.near;
      u.uCameraFar.value = camera.far;
      if (u.uShaftFrame) u.uShaftFrame.value = shaftFrame++;

      quad.material = resolveMaterial;
      renderer.setRenderTarget(scratch);
      renderer.render(quadScene, quadCamera);
      return scratch;
    },

    dispose() {
      maskTarget.dispose();
      maskMaterial.dispose();
      resolveMaterial.dispose();
      quad.geometry.dispose();
    },
  };
}

/** The underwater rig returned by {@link createUnderwater}. */
export type UnderwaterRig = ReturnType<typeof createUnderwater>;
