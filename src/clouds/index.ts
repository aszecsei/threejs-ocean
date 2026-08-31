import * as THREE from "three";
import { SKY_COLOR_GLSL } from "../sky/index.js";
import { taaMaterialConfig, type TaaApi } from "../taa/index.js";
import type { Uniform } from "../core/types.js";
import * as flags from "../flags.js";
import { createBlueNoiseTexture, createCirrusNoiseTexture, createCloudNoiseTextures, createCurlNoiseTexture } from "./noise-textures.js";
import CLOUD_DENSITY_GLSL from "./shaders/density.glsl";
import { cloudTemporalMode, createCloudTemporal, type CloudTemporal } from "./temporal/index.js";
import { createCloudShadows } from "./shadows/index.js";
import MARCH_UNIFORMS from "./shaders/march.uniforms.glsl";
import MARCH_MAIN from "./shaders/march.main.glsl";
import DOME_VERT from "./shaders/dome.vert.glsl";
import COMPOSITE_VERT from "./shaders/composite.vert.glsl";
import COMPOSITE_FRAG from "./shaders/composite.frag.glsl";

export const CLOUD_SCALE = 60.0;
export const CLOUD_BOTTOM = 5.0 * CLOUD_SCALE;
export const CLOUD_TOP = 15.0 * CLOUD_SCALE;
export const TOWER_TOP = 33.0 * CLOUD_SCALE;

export function cloudsEnabled() { return flags.enabled("clouds"); }
export function cloudResDivisor() {
  // A negative divisor falls back to the default rather than clamping to 0,
  // because 0 means something else here (render the dome in-scene).
  const n = flags.int("cloud-res", 2);
  return n >= 0 ? Math.min(n, 8) : 2;
}
export function cloudLightReuse() { return flags.enabled("cloud-light"); }
export function cloudFarGrowth() { return flags.num("cloud-far", 1, { min: 0 }); }
// Mid-frequency shape band (?cloud-midband=0 disables, or a 0-2 strength
// multiplier). Fills the feature-size gap between the base billows and the
// detail erosion; on by default.
export function cloudMidBand() {
  // A bare `?cloud-midband` (or `=true`) means full strength; anything
  // unparseable means off, unlike the clamp-to-default flags elsewhere.
  const v = flags.str("cloud-midband", "1");
  if (v === "" || v === "true") return 1;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(2, n)) : 0;
}

// High-altitude 2.5-D cirrus layer (?cirrus=0 compiles it out entirely).
export function cirrusEnabled() { return flags.enabled("cirrus"); }
function cirrusParam(name: string, fallback: number): number {
  return flags.num(name, fallback, { min: 0, max: 1 });
}
function cirrusCoverage() { return cirrusParam("cirrus-coverage", 0.40); }
function cirrusType() { return cirrusParam("cirrus-type", 0.25); }

const DEBUG_MODES = ["", "profile", "coverage", "type", "base-noise", "detail-noise", "coarse-density", "cloud-depth", "cloud-reactive", "shadow", "ambient", "history", "cirrus-coverage", "cirrus-density"];
function debugMode() {
  const mode = flags.str("cloud-debug", "");
  // "ambient-only" is a legacy alias for the "ambient" view.
  if (mode === "ambient-only") return DEBUG_MODES.indexOf("ambient");
  // An unknown mode falls back to 0 ("" = off) rather than -1.
  return Math.max(0, DEBUG_MODES.indexOf(mode));
}
function profileMode() { return flags.is("cloud-profile", "legacy") ? "legacy" : "dimensional"; }
function weatherMode() { return flags.is("cloud-weather", "coupled") ? "coupled" : "split"; }
function noiseMode() { return flags.is("cloud-noise", "procedural") ? "procedural" : "texture"; }
function ambientMode() { return flags.is("cloud-ambient", "legacy") ? "legacy" : "coarse"; }

export function createClouds(
  scene: THREE.Scene,
  skyUniforms: Record<string, Uniform<unknown>>,
  renderer: THREE.WebGLRenderer,
  taa: TaaApi | null = null
) {
  const divisor = renderer ? cloudResDivisor() : 0;
  const requestedNoise = noiseMode();
  const noiseResources = requestedNoise === "texture" ? createCloudNoiseTextures(renderer) : null;
  const activeNoise = noiseResources ? "texture" : "procedural";
  if (requestedNoise === "texture" && !noiseResources) console.warn("Cloud texture noise unsupported; using procedural noise");
  const curlNoise = createCurlNoiseTexture();
  const blueNoise = createBlueNoiseTexture();
  const cirrusOn = cirrusEnabled();
  const cirrusNoise = cirrusOn ? createCirrusNoiseTexture() : null;
  const temporalMode = divisor > 0 ? cloudTemporalMode(renderer) : "off";
  const taaConfig = taaMaterialConfig(taa);
  const ownCurrentVP = new THREE.Matrix4();
  const ownPreviousVP = new THREE.Matrix4();
  const ownDelta = { value: 1 / 60 };
  const currentVP = taa?.enabled ? taa.uniforms.uCurrentViewProjection : { value: ownCurrentVP };
  const previousVP = taa?.enabled ? taa.uniforms.uPreviousViewProjection : { value: ownPreviousVP };
  const deltaUniform = taa?.enabled ? taa.uniforms.uTaaDeltaTime : ownDelta;
  const uniforms = {
    uTime: { value: 0 },
    uFrameIndex: { value: 0 },
    uUpdatePhase: { value: 0 },
    uMaskMode: { value: 0 },
    uDebugMode: { value: debugMode() },
    tCloudBaseNoise: { value: noiseResources?.base ?? null },
    tCloudDetailNoise: { value: noiseResources?.detail ?? null },
    tCloudCurlNoise: { value: curlNoise },
    tCloudBlueNoise: { value: blueNoise },
    ...(cirrusOn ? { tCloudCirrusNoise: { value: cirrusNoise } } : {}),
    uSunDirection: skyUniforms.uSunDirection,
    uSunColor: skyUniforms.uSunColor,
    uZenithColor: skyUniforms.uZenithColor,
    uHorizonColor: skyUniforms.uHorizonColor,
    uGroundColor: skyUniforms.uGroundColor,
    uCurrentViewProjection: currentVP,
    uPreviousViewProjection: previousVP,
    uTaaDeltaTime: deltaUniform,
    ...(skyUniforms.uGradeLUT ? { uGradeLUT: skyUniforms.uGradeLUT } : {}),
  };

  const S = CLOUD_SCALE;
  const len = (k: number) => (k * S).toFixed(1);
  const densityDefines = {
    CLOUD_BOTTOM: CLOUD_BOTTOM.toFixed(1), CU_TOP: CLOUD_TOP.toFixed(1), CB_TOP: TOWER_TOP.toFixed(1),
    CU_HEIGHT: (CLOUD_TOP - CLOUD_BOTTOM).toFixed(1), MAX_DIST: len(160),
    NOISE_SCALE: (0.26 / S).toFixed(6), WEATHER_SCALE: (1 / (48 * S)).toFixed(8),
    EXTINCTION: (3.6 / S).toFixed(6), HAZE_DIST: len(140),
    COVERAGE: "0.70", SHAPE_WIDTH: profileMode() === "dimensional" ? "0.30" : "0.20",
    TOWER_THRESHOLD: "0.66", TOWER_BAND: "0.20", ANVIL_SPREAD: "0.30", ANVIL_BIAS: "0.70", ANVIL_SHEAR: "0.12",
    EROSION: "0.95", EROSION_SCALE: "2.0", WIND_SPEED: "0.05", CUMULUS_GAIN: "1.35", TOWER_GAIN: "2.30",
    DENSITY_SHAPE: "1.35", CURL_STRENGTH: "0.55",
    DETAIL_FADE_START: len(55), DETAIL_FADE_END: len(120), NEAR_SHADOW_STEP: len(0.8),
    COVERAGE_CLEAR: "0.15", COVERAGE_OVERCAST: "0.90", TYPE_LOW: "0.25", TYPE_HIGH: "0.78", TYPE_CORRELATION: "0.35",
    AIRMASS_CLEAR: "0.38", AIRMASS_FULL: "0.75", BREAKUP: "0.45",
    TYPE_STRATO: "0.28", TYPE_CUMULUS: "0.62", TOWER_TYPE_START: "0.60", TOWER_TYPE_FULL: "0.86",
    TOWER_COVERAGE_MIN: "0.34", TOWER_COVERAGE_FULL: "0.72",
    ...(profileMode() === "dimensional" ? { CLOUD_PROFILE_DIMENSIONAL: "" } : {}),
    ...(weatherMode() === "split" ? { CLOUD_WEATHER_SPLIT: "" } : {}),
    ...(activeNoise === "texture" ? { CLOUD_NOISE_TEXTURE: "" } : {}),
    // The mid band carries usable silhouette detail further out than the fine
    // erosion can, so its variant also pushes the erosion fade range out.
    ...(cloudMidBand() > 0 ? {
      CLOUD_MID_BAND: "", MID_BAND_STRENGTH: (0.30 * cloudMidBand()).toFixed(3),
      DETAIL_FADE_START: len(70), DETAIL_FADE_END: len(160),
    } : {}),
  };
  // Cirrus defines are view-shader-only by design: they must never reach
  // densityDefines, which the shadow map compiles — the thin high layer
  // casts no meaningful ground shadow and must not slow that march.
  const cirrusWind = new THREE.Vector2(0.83, 0.55).normalize();
  const cirrusDefines = cirrusOn ? {
    CLOUD_CIRRUS: "",
    CIRRUS_ALT: len(63),
    CIRRUS_WEATHER_SCALE: (1 / (96 * S)).toFixed(8),
    CIRRUS_NOISE_SCALE: (1 / (30 * S)).toFixed(8),
    CIRRUS_STRETCH: "11.0",
    CIRRUS_CURL_STRENGTH: "0.10",
    CIRRUS_WIND_SPEED: "0.03",
    CIRRUS_WIND_DIR: `vec2(${cirrusWind.x.toFixed(4)},${cirrusWind.y.toFixed(4)})`,
    // Rotates the wind direction onto +x so the streak stretch axis and the
    // scroll both live on one axis of the basis lookup frame.
    CIRRUS_WIND_ROT: `mat2(${cirrusWind.x.toFixed(4)},${(-cirrusWind.y).toFixed(4)},${cirrusWind.y.toFixed(4)},${cirrusWind.x.toFixed(4)})`,
    CIRRUS_COVERAGE: cirrusCoverage().toFixed(3),
    CIRRUS_TYPE: cirrusType().toFixed(3),
    CIRRUS_OPTICAL_DEPTH: "0.55",
  } : {};
  const materialDefines = {
    ...densityDefines,
    ...cirrusDefines,
    PRIMARY_STEPS: "160", LIGHT_STEPS: "8", LIGHT_STEP0: len(1), LIGHT_GROWTH: "1.6",
    FAR_STEP_GROWTH: (cloudFarGrowth() / 9000).toFixed(8),
    ...(cloudLightReuse() ? { LIGHT_REUSE: "" } : {}),
    ...(ambientMode() === "coarse" ? { CLOUD_AMBIENT_COARSE: "" } : {}),
    ...(temporalMode !== "off" ? { CLOUD_TEMPORAL: "" } : {}),
    ...(temporalMode === "interleaved" ? { CLOUD_INTERLEAVED: "" } : {}),
    ...(divisor > 0 ? { CLOUD_PREMULTIPLIED: "" } : {}),
    ...(skyUniforms.uGradeLUT ? { SKY_GRADE_LUT: "" } : {}),
    ...taaConfig.defines,
  };

  const fragmentShader = [MARCH_UNIFORMS, SKY_COLOR_GLSL, CLOUD_DENSITY_GLSL, MARCH_MAIN].join("\n");

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(58,32,16), new THREE.ShaderMaterial({
    uniforms,
    side: THREE.BackSide,
    transparent: divisor === 0,
    depthWrite: false,
    blending: divisor === 0 ? THREE.NormalBlending : THREE.NoBlending,
    glslVersion: THREE.GLSL3,
    defines: materialDefines,
    vertexShader: DOME_VERT,
    fragmentShader,
  }));
  mesh.frustumCulled=false;

  const densityUniforms = {
    uTime: uniforms.uTime, tCloudBaseNoise: uniforms.tCloudBaseNoise, tCloudDetailNoise: uniforms.tCloudDetailNoise,
    tCloudCurlNoise: uniforms.tCloudCurlNoise, uSunDirection: uniforms.uSunDirection,
  };
  const shadows = createCloudShadows(renderer, densityUniforms, densityDefines, taa);

  if(divisor===0){
    scene.add(mesh);
    return { mesh, uniforms, pass:null, shadows, noise:noiseResources, modes:{ profile:profileMode(),weather:weatherMode(),noise:activeNoise,temporal:"off",ambient:ambientMode(),cirrus:cirrusOn,shadows:shadows?.mode??"off",debug:DEBUG_MODES[debugMode()] }, reset(){shadows?.reset();taa?.reset();}, dispose(){shadows?.dispose();noiseResources?.dispose();curlNoise.dispose();cirrusNoise?.dispose();mesh.geometry.dispose();mesh.material.dispose();} };
  }

  const cloudScene=new THREE.Scene();cloudScene.add(mesh);
  const compositeMaterial=new THREE.ShaderMaterial({
    uniforms:{tClouds:{value:null},tCloudMeta:{value:null},tCloudSignature:{value:null},uDebugMode:{value:debugMode()}},
    transparent:true,blending:THREE.CustomBlending,blendEquation:THREE.AddEquation,blendSrc:THREE.OneFactor,blendDst:THREE.OneMinusSrcAlphaFactor,
    depthTest:true,depthWrite:false,glslVersion:taaConfig.glslVersion,defines:{...taaConfig.defines,...(temporalMode!=="off"?{CLOUD_COMPOSITE_TEMPORAL:""}:{})},
    vertexShader:COMPOSITE_VERT,
    fragmentShader:COMPOSITE_FRAG,
  });
  const compositeScene=new THREE.Scene(),compositeCamera=new THREE.OrthographicCamera(-1,1,1,-1,0,1);
  const compositeQuad=new THREE.Mesh(new THREE.PlaneGeometry(2,2),compositeMaterial);compositeQuad.frustumCulled=false;compositeScene.add(compositeQuad);
  const size=new THREE.Vector2();
  let rawTarget: THREE.WebGLRenderTarget | null = null;
  let temporal: CloudTemporal | null = null;
  let frameIndex=0,lastTime=0;
  const previousCameraPosition=new THREE.Vector3(),previousCameraQuaternion=new THREE.Quaternion(),previousProjection=new THREE.Matrix4();let cameraValid=false;
  const prevClearColor=new THREE.Color();
  function makeRawTarget(w: number, h: number){
    const count=temporalMode!=="off"?3:(taa?.enabled?2:1);
    const target=new THREE.WebGLRenderTarget(w,h,{...(count>1?{count}:{}),type:THREE.HalfFloatType,minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter,depthBuffer:false,stencilBuffer:false});
    target.textures[0].name="Cloud.rawColor";if(count>1)target.textures[1].name="Cloud.rawMeta";if(count>2)target.textures[2].name="Cloud.rawSignature";return target;
  }
  // rawTarget is null only between here and the pass.resize() call below,
  // which runs during construction -- no member can observe it null.
  const pass={
    resize(){renderer.getDrawingBufferSize(size);const w=Math.max(1,Math.floor(size.x/divisor)),h=Math.max(1,Math.floor(size.y/divisor));rawTarget?.dispose();rawTarget=makeRawTarget(w,h);if(temporal)temporal.resize(w,h);else temporal=createCloudTemporal(renderer,temporalMode,w,h);cameraValid=false;},
    get texture(){return temporal?.texture??rawTarget!.texture;},
    get motionTexture(){return temporal?.metaTexture??(rawTarget!.textures[1]??null);},
    get signatureTexture(){return temporal?.signatureTexture??(rawTarget!.textures[2]??null);},
    get rawTarget(){return rawTarget;},
    get resolvedTarget(){return temporal;},
    render(camera: THREE.PerspectiveCamera){
      const now=uniforms.uTime.value;ownDelta.value=Math.min(Math.max(now-lastTime,0),0.1);lastTime=now;
      camera.updateMatrixWorld();
      if(!taa?.enabled){ownCurrentVP.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);if(!cameraValid)ownPreviousVP.copy(ownCurrentVP);}
      let projectionChanged=false;
      if(cameraValid){
        const currentElements=camera.projectionMatrix.elements,previousElements=previousProjection.elements;
        for(let i=0;i<16;i++){
          // Global TAA jitter changes only these two terms every frame.
          if(i!==8&&i!==9&&Math.abs(currentElements[i]-previousElements[i])>1e-5){projectionChanged=true;break;}
        }
      }
      const cut=cameraValid&&(camera.position.distanceToSquared(previousCameraPosition)>100||2*Math.acos(Math.min(1,Math.abs(camera.quaternion.dot(previousCameraQuaternion))))>Math.PI/3||projectionChanged);
      if(cut){temporal?.reset();shadows?.reset();}
      uniforms.uFrameIndex.value=frameIndex;uniforms.uUpdatePhase.value=frameIndex%4;
      const previousTarget=renderer.getRenderTarget();renderer.getClearColor(prevClearColor);const previousAlpha=renderer.getClearAlpha();
      renderer.setRenderTarget(rawTarget);renderer.setClearColor(0,0);renderer.clear();renderer.render(cloudScene,camera);
      if(temporal&&rawTarget)temporal.resolve(rawTarget);
      renderer.setClearColor(prevClearColor,previousAlpha);renderer.setRenderTarget(previousTarget);
      if(!taa?.enabled)ownPreviousVP.copy(ownCurrentVP);
      previousCameraPosition.copy(camera.position);previousCameraQuaternion.copy(camera.quaternion);previousProjection.copy(camera.projectionMatrix);cameraValid=true;frameIndex++;
    },
    composite(r: THREE.WebGLRenderer){const prev=r.autoClear;r.autoClear=false;compositeMaterial.uniforms.tClouds.value=pass.texture;compositeMaterial.uniforms.tCloudMeta.value=pass.motionTexture;compositeMaterial.uniforms.tCloudSignature.value=pass.signatureTexture;r.render(compositeScene,compositeCamera);r.autoClear=prev;},
    reset(){temporal?.reset();cameraValid=false;frameIndex=0;},
    dispose(){rawTarget?.dispose();temporal?.dispose();compositeMaterial.dispose();compositeQuad.geometry.dispose();},
  };
  pass.resize();
  const rig={mesh,uniforms,pass,shadows,noise:noiseResources,modes:{profile:profileMode(),weather:weatherMode(),noise:activeNoise,temporal:temporalMode,ambient:ambientMode(),cirrus:cirrusOn,shadows:shadows?.mode??"off",debug:DEBUG_MODES[debugMode()]},reset(){pass.reset();shadows?.reset();taa?.reset();},dispose(){pass.dispose();shadows?.dispose();noiseResources?.dispose();curlNoise.dispose();cirrusNoise?.dispose();mesh.geometry.dispose();mesh.material.dispose();}};
  return rig;
}

/** The cloud rig returned by {@link createClouds}. */
export type CloudRig = ReturnType<typeof createClouds>;
/** The offscreen cloud pass; null when the in-scene dome is used. */
export type CloudPass = NonNullable<CloudRig["pass"]>;
