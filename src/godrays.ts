import * as THREE from "three";
import * as flags from "./flags.js";
import { TAA_FRAGMENT_GLSL, taaMaterialConfig, type TaaHandle } from "./taa.js";
import type { Uniform } from "./core/types.js";

// --- Screen-space crepuscular rays ----------------------------------------
// Three passes after the main frame:
//   1. Occlusion mask at 1/MASK_DIVISOR resolution: only the sky and cloud
//      domes are drawn (MASK_LAYER) with uMaskMode = 1, so the sky writes a
//      soft sun blob and the clouds write black at their real alpha with all
//      lighting skipped. Everything else (knot, ocean) is ignored; the sun
//      sits well above the horizon, so the ocean never occludes it.
//   2. Radial blur toward the sun's screen position, iterated BLUR_PASSES
//      times with growing reach (a few dozen taps behave like hundreds).
//   3. Additive composite into the linear HDR frame (post.js), tinted by
//      the sun color; bloom and tone mapping run afterwards.
// Rays only exist while the sun is on or near the screen -- the inherent
// limitation of the screen-space approach, chosen for its cost.
//
// `?rays=0` disables the effect, `?rays=<k>` scales its strength (default 1),
// `?rays=debug` shows the blurred occlusion mask instead of compositing it.
export function raysStrength() {
  if (flags.is("rays", "false")) return 0;
  if (flags.is("rays", "debug")) return 1;
  return flags.num("rays", 1, { min: 0 });
}

export function raysDebug() {
  return flags.is("rays", "debug");
}

export const MASK_LAYER = 2;
const MASK_DIVISOR = 4;
const BLUR_PASSES = 3;
const BLUR_SAMPLES = 12;
// Per-tap weight decay: makes the rays fall off with distance from the sun
// instead of spreading the sun's energy evenly over the whole screen.
const BLUR_DECAY = 0.86;
// Composite strength at `?rays=1`. The rays add in linear light now (before
// tone mapping), which reads weaker than the old gamma-space add.
const STRENGTH_BASE = 1.0;

const QUAD_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/** What god rays need from the sky rig. */
export interface GodRaySky {
  mesh: THREE.Object3D;
  uniforms: {
    uSunColor: Uniform<THREE.Color>;
    uSunDirection: Uniform<THREE.Vector3>;
    uMaskMode: Uniform<number>;
  };
}

/**
 * What god rays need from the cloud rig. `pass` is the offscreen cloud buffer;
 * when it is null the in-scene dome is masked by layer instead.
 */
export interface GodRayClouds {
  mesh: THREE.Object3D;
  uniforms: { uMaskMode: Uniform<number> };
  pass: { texture: THREE.Texture } | null;
}

export function createGodRays(
  renderer: THREE.WebGLRenderer,
  camera: THREE.PerspectiveCamera,
  scene: THREE.Scene,
  sky: GodRaySky,
  clouds: GodRayClouds | null,
  { strength = 1, taa = null }: { strength?: number; taa?: TaaHandle | null } = {}
) {
  const taaConfig = taaMaterialConfig(taa);
  // The mask needs the sky dome; everything else stays off MASK_LAYER.
  // Clouds: with the offscreen cloud pass (clouds.pass) the occlusion comes
  // from that buffer's alpha instead of re-marching the dome -- only the
  // legacy in-scene dome (`?cloud-res=0`) joins the mask render.
  sky.mesh.layers.enable(MASK_LAYER);
  const cloudPass = clouds ? clouds.pass : null;
  if (clouds && !cloudPass) clouds.mesh.layers.enable(MASK_LAYER);

  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const makeTarget = () =>
    new THREE.WebGLRenderTarget(
      Math.max(1, Math.floor(size.x / MASK_DIVISOR)),
      Math.max(1, Math.floor(size.y / MASK_DIVISOR)),
      {
        type: THREE.HalfFloatType,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
      }
    );
  let targets = [makeTarget(), makeTarget()];

  const quadScene = new THREE.Scene();
  const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  quad.frustumCulled = false;
  quadScene.add(quad);

  const blurMaterial = new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse: { value: null },
      uSunUv: { value: new THREE.Vector2() },
      uReach: { value: 1.0 },
    },
    depthTest: false,
    depthWrite: false,
    vertexShader: QUAD_VERT,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDiffuse;
      uniform vec2 uSunUv;
      uniform float uReach;
      varying vec2 vUv;
      void main() {
        vec2 delta = (uSunUv - vUv) * uReach / float(${BLUR_SAMPLES});
        vec2 uv = vUv;
        vec3 sum = vec3(0.0);
        float w = 1.0;
        for (int i = 0; i < ${BLUR_SAMPLES}; i++) {
          sum += texture2D(tDiffuse, uv).rgb * w;
          uv += delta;
          w *= ${BLUR_DECAY};
        }
        gl_FragColor = vec4(sum / float(${BLUR_SAMPLES}), 1.0);
      }
    `,
  });

  // Multiplies the mask by the cloud buffer's transmittance: with blending
  // (Zero, OneMinusSrcAlpha) the blob becomes blob * (1 - cloudAlpha) --
  // exactly what alpha-blending the mask-mode dome (black at its real
  // alpha) over the blob computed in the legacy path.
  const cloudMaskMaterial = cloudPass
    ? new THREE.ShaderMaterial({
        uniforms: { tClouds: { value: null } },
        transparent: true,
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.ZeroFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        depthTest: false,
        depthWrite: false,
        vertexShader: QUAD_VERT,
        fragmentShader: /* glsl */ `
          uniform sampler2D tClouds;
          varying vec2 vUv;
          void main() {
            gl_FragColor = vec4(0.0, 0.0, 0.0, texture2D(tClouds, vUv).a);
          }
        `,
      })
    : null;

  const compositeMaterial = new THREE.ShaderMaterial({
    uniforms: {
      tRays: { value: null },
      uSunColor: sky.uniforms.uSunColor,
      uStrength: { value: strength * STRENGTH_BASE },
      uDebug: { value: raysDebug() ? 1 : 0 },
    },
    transparent: true,
    // One/One preserves scene velocity while adding ray intensity only to
    // the reactive channel. With alpha 1 it matches the old color add.
    blending: raysDebug()
      ? THREE.NoBlending
      : taa?.enabled
        ? THREE.CustomBlending
        : THREE.AdditiveBlending,
    ...(taa?.enabled && !raysDebug()
      ? {
          blendEquation: THREE.AddEquation,
          blendSrc: THREE.OneFactor,
          blendDst: THREE.OneFactor,
        }
      : {}),
    glslVersion: taaConfig.glslVersion,
    defines: taaConfig.defines,
    depthTest: false,
    depthWrite: false,
    vertexShader: QUAD_VERT,
    fragmentShader: /* glsl */ `
      uniform sampler2D tRays;
      uniform vec3 uSunColor;
      uniform float uStrength;
      uniform float uDebug;
      varying vec2 vUv;
      ${TAA_FRAGMENT_GLSL}
      void main() {
        float r = texture2D(tRays, vUv).r;
        if (uDebug > 0.5) {
          gl_FragColor = vec4(vec3(r), 1.0);
          #ifdef TAA_ENABLED
          taaMotion = vec4(0.0);
          #endif
          return;
        }
        gl_FragColor = vec4(uSunColor * r * uStrength, 1.0);
        #ifdef TAA_ENABLED
        // Rays are reconstructed in screen space and do not have one exact
        // world velocity. Reduce history where they are visible instead.
        taaMotion = vec4(0.0, 0.0, 0.0, clamp(r * uStrength, 0.0, 1.0));
        #endif
      }
    `,
  });

  const sunView = new THREE.Vector3();
  const sunUv = new THREE.Vector2();

  return {
    resize() {
      renderer.getDrawingBufferSize(size);
      for (const t of targets) t.dispose();
      targets = [makeTarget(), makeTarget()];
    },

    // Call after the frame has been drawn into `frame` (the linear HDR
    // target from post.js). Composites additively into that same target.
    render(frame: THREE.WebGLRenderTarget) {
      // Sun in NDC. Skip entirely when it is behind the camera or far off
      // screen -- nothing would radiate from there.
      sunView.copy(sky.uniforms.uSunDirection.value).add(camera.position).project(camera);
      if (sunView.z > 1.0 || Math.abs(sunView.x) > 1.6 || Math.abs(sunView.y) > 1.6) return;
      sunUv.set(sunView.x * 0.5 + 0.5, sunView.y * 0.5 + 0.5);
      // Fade out as the sun leaves the frame so it doesn't pop.
      const edge = Math.max(Math.abs(sunView.x), Math.abs(sunView.y));
      const fade = 1.0 - THREE.MathUtils.smoothstep(edge, 1.0, 1.6);
      if (fade <= 0.0) return;

      const prevAutoClear = renderer.autoClear;
      const prevLayers = camera.layers.mask;
      const prevBackground = scene.background;

      // 1. Occlusion mask.
      sky.uniforms.uMaskMode.value = 1;
      if (clouds && !cloudPass) clouds.uniforms.uMaskMode.value = 1;
      scene.background = null;
      camera.layers.set(MASK_LAYER);
      renderer.autoClear = true;
      renderer.setRenderTarget(targets[0]);
      renderer.clear();
      renderer.render(scene, camera);
      sky.uniforms.uMaskMode.value = 0;
      if (clouds && !cloudPass) clouds.uniforms.uMaskMode.value = 0;
      scene.background = prevBackground;
      camera.layers.mask = prevLayers;

      // Cloud occlusion from the offscreen buffer (no second dome march).
      // cloudMaskMaterial is created iff cloudPass exists.
      if (cloudPass && cloudMaskMaterial) {
        renderer.autoClear = false;
        cloudMaskMaterial.uniforms.tClouds.value = cloudPass.texture;
        quad.material = cloudMaskMaterial;
        renderer.render(quadScene, quadCamera);
      }

      // 2. Radial blur, growing reach: 1/9, 1/3, 1 of the way to the sun.
      quad.material = blurMaterial;
      blurMaterial.uniforms.uSunUv.value.copy(sunUv);
      let src = 0;
      for (let i = 0; i < BLUR_PASSES; i++) {
        blurMaterial.uniforms.uReach.value = Math.pow(3, i - (BLUR_PASSES - 1));
        blurMaterial.uniforms.tDiffuse.value = targets[src].texture;
        renderer.setRenderTarget(targets[1 - src]);
        renderer.render(quadScene, quadCamera);
        src = 1 - src;
      }

      // 3. Additive composite into the HDR frame (linear light: this is
      //    weaker than the old add-after-sRGB, hence the higher base).
      quad.material = compositeMaterial;
      compositeMaterial.uniforms.tRays.value = targets[src].texture;
      compositeMaterial.uniforms.uStrength.value = strength * STRENGTH_BASE * fade;
      renderer.setRenderTarget(frame);
      renderer.autoClear = false;
      renderer.render(quadScene, quadCamera);
      renderer.autoClear = prevAutoClear;
    },
  };
}

/** The god-ray rig returned by {@link createGodRays}. */
export type GodRays = ReturnType<typeof createGodRays>;
