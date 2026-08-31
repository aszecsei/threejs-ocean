import * as THREE from "three";
import * as flags from "./flags.js";
import type { TaaMaterialConfig, Uniform } from "./core/types.js";
import FULLSCREEN_VERT from "./shaders/common/fullscreen.vert.glsl";
import TAA_FRAGMENT_GLSL_SRC from "./taa/shaders/contract.glsl";
import RESOLVE_FRAG from "./taa/shaders/resolve.frag.glsl";
import DISPLAY_FRAG from "./taa/shaders/display.frag.glsl";

// Full-image temporal AA. The current frame uses two MRT attachments:
//   0: linear HDR color
//   1: velocity.xy, expected previous depth, reactive mask
// The history stays pre-bloom so bright post effects cannot feed back.
const HALTON_8 = [
  [-0.25,  0.1666667],
  [ 0.25, -0.3888889],
  [-0.375, -0.0555556],
  [ 0.125,  0.2777778],
  [-0.125, -0.2777778],
  [ 0.375,  0.0555556],
  [-0.4375, 0.3888889],
  [ 0.0625, -0.4629630],
];

// Include in custom fragment shaders. TAA materials use GLSL 3 so they can
// name both MRT outputs; the block compiles away on the ?taa=0 fallback.
export const TAA_FRAGMENT_GLSL = TAA_FRAGMENT_GLSL_SRC;

/** TAA off, on, or one of the diagnostic visualisations. */
export type TaaMode = "off" | "on" | "velocity" | "history" | "reactive";

/**
 * The part of the TAA rig that materials need. Kept structural (rather than
 * the full api type) so sky/clouds/ocean/godrays do not depend on the whole
 * resolver just to configure a material.
 */
export interface TaaHandle {
  enabled: boolean;
  uniforms: Record<string, Uniform<unknown>>;
}

interface TaaTracker {
  object: THREE.Object3D;
  previousMatrix: THREE.Matrix4;
  initialized: boolean;
  reactive: number;
}

export function taaQueryMode(): TaaMode {
  if (!flags.enabled("taa")) return "off";
  return flags.oneOf("taa", ["velocity", "history", "reactive"] as const, "on");
}

export function taaMaterialConfig(taa: TaaHandle | null | undefined): TaaMaterialConfig {
  if (!taa || !taa.enabled) return { glslVersion: null, defines: {}, uniforms: {} };
  return {
    glslVersion: THREE.GLSL3,
    defines: { TAA_ENABLED: "" },
    uniforms: taa.uniforms,
  };
}

function appendBeforeFinalBrace(source: string, code: string): string {
  const i = source.lastIndexOf("}");
  if (i < 0) throw new Error("TAA shader injection could not find main() terminator");
  return `${source.slice(0, i)}\n${code}\n${source.slice(i)}`;
}

export function createTemporalAA(
  renderer: THREE.WebGLRenderer,
  camera: THREE.PerspectiveCamera,
  { mode = taaQueryMode() }: { mode?: TaaMode } = {}
) {
  const enabled = mode !== "off";
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const currentViewProjection = new THREE.Matrix4();
  const previousViewProjection = new THREE.Matrix4();
  const baseProjection = new THREE.Matrix4();
  const currentCameraPosition = new THREE.Vector3();
  const previousCameraPosition = new THREE.Vector3();
  const committedPosition = new THREE.Vector3();
  const committedQuaternion = new THREE.Quaternion();
  const committedProjection = new THREE.Matrix4();
  const trackers: TaaTracker[] = [];

  const uniforms = {
    uCurrentViewProjection: { value: currentViewProjection },
    uPreviousViewProjection: { value: previousViewProjection },
    uCurrentCameraPosition: { value: currentCameraPosition },
    uPreviousCameraPosition: { value: previousCameraPosition },
    uTaaInvResolution: { value: new THREE.Vector2(1 / size.x, 1 / size.y) },
    uTaaDeltaTime: { value: 1 / 60 },
  };

  let histories: THREE.WebGLRenderTarget[] = [];
  let displayTarget: THREE.WebGLRenderTarget | null = null;
  let readIndex = 0;
  let historyValid = false;
  let forcePreviousCurrent = true;
  let hasCommittedFrame = false;
  let frameIndex = 0;
  let frameBegun = false;

  const makeHistoryTarget = () => {
    const target = new THREE.WebGLRenderTarget(size.x, size.y, {
      count: 2,
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    target.textures[0].name = "TAA.historyColor";
    target.textures[1].name = "TAA.historyData";
    target.textures[1].minFilter = THREE.NearestFilter;
    target.textures[1].magFilter = THREE.NearestFilter;
    return target;
  };

  const makeDisplayTarget = () => {
    const target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    target.texture.name = "TAA.display";
    return target;
  };

  if (enabled) {
    histories = [makeHistoryTarget(), makeHistoryTarget()];
    displayTarget = makeDisplayTarget();
  }

  const quadScene = new THREE.Scene();
  const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  quad.frustumCulled = false;
  quadScene.add(quad);

  const resolveMaterial = enabled
    ? new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: {
          tCurrentColor: { value: null },
          tCurrentMotion: { value: null },
          tCurrentDepth: { value: null },
          tHistoryColor: { value: null },
          tHistoryData: { value: null },
          uInvResolution: uniforms.uTaaInvResolution,
          uCameraNear: { value: camera.near },
          uCameraFar: { value: camera.far },
          uHistoryValid: { value: 0 },
        },
        depthTest: false,
        depthWrite: false,
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: RESOLVE_FRAG,
      })
    : null;

  const displayMaterial = enabled
    ? new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: {
          tHistoryColor: { value: null },
          tHistoryData: { value: null },
          tCurrentMotion: { value: null },
          uResolution: { value: size.clone() },
          uMode: {
            value: mode === "velocity" ? 1 : mode === "history" ? 2 : mode === "reactive" ? 3 : 0,
          },
        },
        depthTest: false,
        depthWrite: false,
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: DISPLAY_FRAG,
      })
    : null;

  function clearHistories() {
    if (!enabled) return;
    const previousTarget = renderer.getRenderTarget();
    for (const target of histories) {
      renderer.setRenderTarget(target);
      renderer.clear();
    }
    renderer.setRenderTarget(previousTarget);
  }

  const api = {
    enabled,
    mode,
    uniforms,
    get diagnostic() { return enabled && mode !== "on"; },
    get displayTarget() { return displayTarget; },
    get historyColor() { return enabled ? histories[readIndex].textures[0] : null; },
    get historyData() { return enabled ? histories[readIndex].textures[1] : null; },

    // Built-in materials keep their normal lighting shader. This hook only
    // adds previous clip coordinates and a second MRT output.
    trackObject(
      // Any object with material(s), not just Mesh: the ?ocean=0 fallback
      // tracks a GridHelper, which is LineSegments.
      object: THREE.Object3D & { material: THREE.Material | THREE.Material[] },
      { reactive = 0 }: { reactive?: number } = {}
    ) {
      if (!enabled) return null;
      const tracker = {
        object,
        previousMatrix: new THREE.Matrix4(),
        initialized: false,
        reactive,
      };
      trackers.push(tracker);
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!material) continue;
        // WebGLProgram reads glslVersion off any material, but three only
        // declares it on ShaderMaterial. Forcing GLSL3 on a built-in material
        // is exactly what makes the second MRT output below legal.
        (material as THREE.Material & { glslVersion: THREE.GLSLVersion }).glslVersion = THREE.GLSL3;
        // Preserve feature hooks installed before TAA, such as world-space
        // cloud-shadow injection on standard materials.
        const priorCompile = material.onBeforeCompile?.bind(material);
        material.onBeforeCompile = (shader: THREE.WebGLProgramParametersWithUniforms, renderer: THREE.WebGLRenderer) => {
          if (priorCompile) priorCompile(shader, renderer);
          shader.uniforms.uPreviousViewProjection = uniforms.uPreviousViewProjection;
          shader.uniforms.uPreviousModelMatrix = { value: tracker.previousMatrix };
          shader.vertexShader = shader.vertexShader.replace(
            "void main() {",
            `uniform mat4 uPreviousViewProjection;\nuniform mat4 uPreviousModelMatrix;\nvarying vec4 vTaaCurrentClip;\nvarying vec4 vTaaPreviousClip;\nvoid main() {`
          );
          shader.vertexShader = shader.vertexShader.replace(
            "#include <project_vertex>",
            `#include <project_vertex>\n  vTaaCurrentClip = gl_Position;\n  vTaaPreviousClip = uPreviousViewProjection * uPreviousModelMatrix * vec4(position, 1.0);`
          );
          shader.fragmentShader = shader.fragmentShader.replace(
            "void main() {",
            `layout(location = 0) out highp vec4 taaColor;\nlayout(location = 1) out highp vec4 taaMotion;\n#define gl_FragColor taaColor\nvarying vec4 vTaaCurrentClip;\nvarying vec4 vTaaPreviousClip;\nvoid main() {`
          );
          shader.fragmentShader = appendBeforeFinalBrace(
            shader.fragmentShader,
            `  vec2 taaCurrentUv = vTaaCurrentClip.xy / max(vTaaCurrentClip.w, 1e-6) * 0.5 + 0.5;\n  vec3 taaPreviousNdc = vTaaPreviousClip.xyz / max(vTaaPreviousClip.w, 1e-6);\n  taaMotion = vec4(taaCurrentUv - (taaPreviousNdc.xy * 0.5 + 0.5),\n                   taaPreviousNdc.z * 0.5 + 0.5, ${Number(reactive).toFixed(6)});`
          );
        };
        const priorCacheKey = material.customProgramCacheKey?.bind(material);
        material.customProgramCacheKey = () => `${priorCacheKey ? priorCacheKey() : ""}|taa-motion-v1`;
        material.needsUpdate = true;
      }
      return tracker;
    },

    beginFrame(dt: number, scene: THREE.Scene) {
      if (!enabled) return;
      if (frameBegun) throw new Error("TAA beginFrame called twice without endFrame");
      frameBegun = true;
      uniforms.uTaaDeltaTime.value = Math.min(Math.max(dt, 0), 0.1);

      camera.updateMatrixWorld();
      scene.updateMatrixWorld(true);
      currentCameraPosition.setFromMatrixPosition(camera.matrixWorld);

      baseProjection.copy(camera.projectionMatrix);
      if (hasCommittedFrame) {
        const positionJump = currentCameraPosition.distanceToSquared(committedPosition) > 100.0;
        const rotationJump = 2.0 * Math.acos(Math.min(1.0, Math.abs(camera.quaternion.dot(committedQuaternion)))) > Math.PI / 3;
        let projectionJump = false;
        for (let i = 0; i < 16; i++) {
          if (Math.abs(baseProjection.elements[i] - committedProjection.elements[i]) > 1e-5) {
            projectionJump = true;
            break;
          }
        }
        if (positionJump || rotationJump || projectionJump) api.reset();
      }

      const jitter = HALTON_8[frameIndex % HALTON_8.length];
      camera.projectionMatrix.elements[8] += (2 * jitter[0]) / size.x;
      camera.projectionMatrix.elements[9] += (2 * jitter[1]) / size.y;
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
      currentViewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

      for (const tracker of trackers) {
        if (!tracker.initialized || forcePreviousCurrent) {
          tracker.previousMatrix.copy(tracker.object.matrixWorld);
          tracker.initialized = true;
        }
      }
      if (!hasCommittedFrame || forcePreviousCurrent) {
        previousViewProjection.copy(currentViewProjection);
        previousCameraPosition.copy(currentCameraPosition);
      }
      forcePreviousCurrent = false;
    },

    endFrame() {
      if (!enabled) return;
      if (!frameBegun) return;
      previousViewProjection.copy(currentViewProjection);
      previousCameraPosition.copy(currentCameraPosition);
      for (const tracker of trackers) tracker.previousMatrix.copy(tracker.object.matrixWorld);
      committedPosition.copy(currentCameraPosition);
      committedQuaternion.copy(camera.quaternion);
      committedProjection.copy(baseProjection);
      camera.projectionMatrix.copy(baseProjection);
      camera.projectionMatrixInverse.copy(baseProjection).invert();
      hasCommittedFrame = true;
      frameIndex++;
      frameBegun = false;
    },

    resolve(currentTarget: THREE.WebGLRenderTarget): THREE.WebGLRenderTarget {
      // These three are created together iff `enabled`; the guard restates
      // that invariant for the type checker.
      if (!enabled || !resolveMaterial || !displayMaterial || !displayTarget) return currentTarget;
      const writeIndex = 1 - readIndex;
      const historyRead = histories[readIndex];
      const historyWrite = histories[writeIndex];

      resolveMaterial.uniforms.tCurrentColor.value = currentTarget.textures[0];
      resolveMaterial.uniforms.tCurrentMotion.value = currentTarget.textures[1];
      resolveMaterial.uniforms.tCurrentDepth.value = currentTarget.depthTexture;
      resolveMaterial.uniforms.tHistoryColor.value = historyRead.textures[0];
      resolveMaterial.uniforms.tHistoryData.value = historyRead.textures[1];
      resolveMaterial.uniforms.uCameraNear.value = camera.near;
      resolveMaterial.uniforms.uCameraFar.value = camera.far;
      resolveMaterial.uniforms.uHistoryValid.value = historyValid ? 1 : 0;
      quad.material = resolveMaterial;
      renderer.setRenderTarget(historyWrite);
      renderer.render(quadScene, quadCamera);

      readIndex = writeIndex;
      historyValid = true;
      displayMaterial.uniforms.tHistoryColor.value = historyWrite.textures[0];
      displayMaterial.uniforms.tHistoryData.value = historyWrite.textures[1];
      displayMaterial.uniforms.tCurrentMotion.value = currentTarget.textures[1];
      quad.material = displayMaterial;
      renderer.setRenderTarget(displayTarget);
      renderer.render(quadScene, quadCamera);
      return displayTarget;
    },

    reset() {
      if (!enabled) return;
      historyValid = false;
      forcePreviousCurrent = true;
      frameIndex = 0;
      clearHistories();
    },

    resize() {
      renderer.getDrawingBufferSize(size);
      uniforms.uTaaInvResolution.value.set(1 / size.x, 1 / size.y);
      if (!enabled || !displayTarget || !displayMaterial) return;
      for (const target of histories) target.setSize(size.x, size.y);
      displayTarget.setSize(size.x, size.y);
      displayMaterial.uniforms.uResolution.value.copy(size);
      api.reset();
    },

    dispose() {
      for (const target of histories) target.dispose();
      if (displayTarget) displayTarget.dispose();
      resolveMaterial?.dispose();
      displayMaterial?.dispose();
      quad.geometry.dispose();
    },
  };

  if (enabled) clearHistories();
  return api;
}

/** The full temporal-AA rig returned by {@link createTemporalAA}. */
export type TaaApi = ReturnType<typeof createTemporalAA>;
