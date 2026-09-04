import * as THREE from "three";
import { SKY_COLOR_GLSL } from "../sky/index.js";
import { taaMaterialConfig, type TaaApi } from "../taa/index.js";
import type { Uniform } from "../core/types.js";
import * as flags from "../flags.js";
import { bakeBlueNoiseTexture, bakeCirrusNoiseTexture, bakeCloudNoiseTextures, bakeCurlNoiseTexture } from "./noise-textures.js";
import { band, drain } from "../loading/scheduler.js";
import CLOUD_DENSITY_GLSL from "./shaders/density.glsl";
import { cloudTemporalMode, createCloudTemporal, type CloudTemporal } from "./temporal/index.js";
import { createCloudShadows } from "./shadows/index.js";
import { cloudOccupancyEnabled, createCloudOccupancy } from "./occupancy/index.js";
import { cloudRefineEnabled, createCloudRefine, type CloudRefine } from "./refine/index.js";
import MARCH_UNIFORMS from "./shaders/march.uniforms.glsl";
import MARCH_LIGHTING from "./shaders/march.lighting.glsl";
import MARCH_CORE from "./shaders/march.core.glsl";
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
// Span-scaled march steps in the refinement pass (?cloud-span-steps=0 falls
// back to the slab step there too): a ray the occupancy prepass narrowed
// marches its span at up to 4x the slab's sampling rate.
export function cloudSpanSteps() { return flags.enabled("cloud-span-steps"); }
export function cloudFarGrowth() { return flags.num("cloud-far", 1, { min: 0 }); }
// Mid-frequency shape band (?cloud-midband=0 disables, or a 0-2 strength
// multiplier). Fills the feature-size gap between the base billows and the
// detail erosion; on by default.
export function cloudMidBand() { return flags.strength("cloud-midband"); }
// High-frequency wisp band eroding the thin shell of every edge
// (?cloud-wisp=0 disables, or a 0-2 strength multiplier).
export function cloudWisp() { return flags.strength("cloud-wisp"); }
// Silver-lining rim term plus the fine-LOD first light step it depends on
// (?cloud-rim=0 disables, or a 0-2 strength multiplier).
export function cloudRim() { return flags.strength("cloud-rim"); }

// High-altitude 2.5-D cirrus layer (?cirrus=0 compiles it out entirely).
export function cirrusEnabled() { return flags.enabled("cirrus"); }
function cirrusParam(name: string, fallback: number): number {
  return flags.num(name, fallback, { min: 0, max: 1 });
}
function cirrusCoverage() { return cirrusParam("cirrus-coverage", 0.40); }
function cirrusType() { return cirrusParam("cirrus-type", 0.25); }

const DEBUG_MODES = ["", "profile", "coverage", "type", "base-noise", "detail-noise", "coarse-density", "cloud-depth", "cloud-reactive", "shadow", "ambient", "history", "cirrus-coverage", "cirrus-density", "occupancy", "edge-mask", "refined"];
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

// The resumable form. Its four noise bakes are the bulk of the demo's startup
// cost, so they are composed into one 0..1 band the loading screen can follow;
// everything after them is allocation and shader assembly.
export function* buildClouds(
  scene: THREE.Scene,
  skyUniforms: Record<string, Uniform<unknown>>,
  renderer: THREE.WebGLRenderer,
  taa: TaaApi | null = null
) {
  const divisor = renderer ? cloudResDivisor() : 0;
  const requestedNoise = noiseMode();
  const noiseResources = requestedNoise === "texture"
    ? yield* band(bakeCloudNoiseTextures(renderer), "Cloud noise", 0, 0.78)
    : null;
  const activeNoise = noiseResources ? "texture" : "procedural";
  if (requestedNoise === "texture" && !noiseResources) console.warn("Cloud texture noise unsupported; using procedural noise");
  const curlNoise = yield* band(bakeCurlNoiseTexture(), "Curl noise", 0.78, 0.84);
  const blueNoise = yield* band(bakeBlueNoiseTexture(), "Blue noise", 0.84, 0.92);
  const cirrusOn = cirrusEnabled();
  const cirrusNoise = cirrusOn ? yield* band(bakeCirrusNoiseTexture(), "Cirrus noise", 0.92, 0.99) : null;
  yield { label: "Cloud materials", detail: "assembling shaders", fraction: 0.99 };
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
    uInvResolution: { value: new THREE.Vector2(1, 1) },
    ...(skyUniforms.uGradeLUT ? { uGradeLUT: skyUniforms.uGradeLUT } : {}),
  };
  const densityUniforms = {
    uTime: uniforms.uTime, tCloudBaseNoise: uniforms.tCloudBaseNoise, tCloudDetailNoise: uniforms.tCloudDetailNoise,
    tCloudCurlNoise: uniforms.tCloudCurlNoise, uSunDirection: uniforms.uSunDirection,
  };
  const domeGeometry = new THREE.SphereGeometry(58,32,16);

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
    // Shape-signal depth over which the wisp perturbation and wispness fade
    // to zero. Not thin: with EROSION at 0.95 the visible surface sits near
    // d0~0.45, so a 0.45 shell never reached it (measured: no visible
    // change at any strength). density.glsl reads this on every path, so
    // it lives here even though only the view shader uses it.
    WISP_SHELL: "1.0",
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
  // The occupancy prepass exists only for the offscreen path: the in-scene
  // dome has no pass object to schedule it from. Its uniform objects are
  // shared by identity with every material that narrows on the map.
  const occupancy = divisor > 0 && cloudOccupancyEnabled()
    ? createCloudOccupancy(renderer, domeGeometry, densityUniforms, densityDefines)
    : null;
  if (occupancy) Object.assign(uniforms, occupancy.uniforms);
  const materialDefines = {
    ...densityDefines,
    ...cirrusDefines,
    ...(occupancy ? { CLOUD_OCCUPANCY: "" } : {}),
    PRIMARY_STEPS: "160", LIGHT_STEPS: "8", LIGHT_STEP0: len(1), LIGHT_GROWTH: "1.6",
    FAR_STEP_GROWTH: (cloudFarGrowth() / 9000).toFixed(8),
    // Shade collapse rate of the ambient term; pushing it up darkens a
    // shadowed near edge against a lit far mass (layer separation).
    SHADE_FALLOFF: "0.9",
    // Span-scaled steps (march.core.glsl, occupancySpanStep). Only the
    // refinement pass calls it so far: its history is simple and it marches
    // only edge pixels, where finer sampling shows. The dome feeds the
    // temporal resolve, whose prefilter is tuned to the current noise
    // floor; calling it there means re-tuning preNoise/boxNoise. The floor
    // (3 world units) bounds the cost of a short span; the ratio cap keeps
    // neighbouring tiles' noise character within what the resolve hides.
    ...(occupancy && cloudSpanSteps() ? { OCCUPANCY_SPAN_STEPS: "", OCCUPANCY_MIN_STEP: len(0.05), OCCUPANCY_MAX_RATIO_LOG2: "2.0" } : {}),
    // Wisp band: view-shader only. The shadow map compiles densityDefines and
    // must never pay for it; the coarse path ignores it anyway. The shell
    // width and fade range are emitted unconditionally because wispness
    // (used by the rim term) and the march's wispFade read them regardless.
    WISP_FADE_START: len(18), WISP_FADE_END: len(55),
    // Scale 2.0 puts a wisp cell at ~6 world units, about 8 px on a cloud
    // 500 units away; finer than that the temporal filters average it into
    // a uniform fuzz. Strength 0.85 is just under where the fringe turns
    // grainy at full res.
    ...(cloudWisp() > 0 ? {
      CLOUD_WISP: "", WISP_STRENGTH: (0.85 * cloudWisp()).toFixed(3),
      WISP_SCALE: "2.0", WISP_CURL: "1.8", WISP_SQUASH: "1.6", WISP_PUFF: "1.0",
    } : {}),
    ...(cloudRim() > 0 ? {
      CLOUD_RIM: "", RIM_STRENGTH: (0.25 * cloudRim()).toFixed(3),
      RIM_G: "0.90", RIM_OD: "0.35", RIM_CLAMP: "1.5",
    } : {}),
    ...(cloudLightReuse() ? { LIGHT_REUSE: "" } : {}),
    ...(ambientMode() === "coarse" ? { CLOUD_AMBIENT_COARSE: "" } : {}),
    ...(temporalMode !== "off" ? { CLOUD_TEMPORAL: "" } : {}),
    ...(temporalMode === "interleaved" ? { CLOUD_INTERLEAVED: "" } : {}),
    ...(divisor > 0 ? { CLOUD_PREMULTIPLIED: "" } : {}),
    ...(skyUniforms.uGradeLUT ? { SKY_GRADE_LUT: "" } : {}),
    ...taaConfig.defines,
  };

  // Everything up to the march core is shared with the refinement pass;
  // only the entry point differs.
  const marchChunks = [MARCH_UNIFORMS, SKY_COLOR_GLSL, CLOUD_DENSITY_GLSL, MARCH_LIGHTING, MARCH_CORE];
  const fragmentShader = [...marchChunks, MARCH_MAIN].join("\n");

  const mesh = new THREE.Mesh(domeGeometry, new THREE.ShaderMaterial({
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

  const shadows = createCloudShadows(renderer, densityUniforms, densityDefines, taa);

  if(divisor===0){
    scene.add(mesh);
    return { mesh, uniforms, pass:null, shadows, noise:noiseResources, modes:{ profile:profileMode(),weather:weatherMode(),noise:activeNoise,temporal:"off",ambient:ambientMode(),cirrus:cirrusOn,shadows:shadows?.mode??"off",debug:DEBUG_MODES[debugMode()] }, reset(){shadows?.reset();taa?.reset();}, dispose(){shadows?.dispose();noiseResources?.dispose();curlNoise.dispose();cirrusNoise?.dispose();mesh.geometry.dispose();mesh.material.dispose();} };
  }

  const cloudScene=new THREE.Scene();cloudScene.add(mesh);
  // The refinement pass needs the resolved half-res alpha and velocity, so
  // it exists only with cloud-space reprojection on.
  const refineRequested=cloudRefineEnabled();
  if(refineRequested&&temporalMode==="off")console.warn("Cloud edge refinement needs cloud temporal reprojection; skipped");
  const refine: CloudRefine | null = refineRequested&&temporalMode!=="off"?createCloudRefine(renderer,domeGeometry,marchChunks,uniforms,materialDefines):null;
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
    resize(){renderer.getDrawingBufferSize(size);const w=Math.max(1,Math.floor(size.x/divisor)),h=Math.max(1,Math.floor(size.y/divisor));rawTarget?.dispose();rawTarget=makeRawTarget(w,h);uniforms.uInvResolution.value.set(1/w,1/h);occupancy?.resize(size.x,size.y);refine?.resize(size.x,size.y,w,h);if(temporal)temporal.resize(w,h);else temporal=createCloudTemporal(renderer,temporalMode,w,h);cameraValid=false;},
    get occupancy(){return occupancy;},
    get refine(){return refine;},
    // What the composite draws: the full-res refined image when the pass
    // exists, else the half-res one. `texture` stays half-res for the
    // god-ray mask, which wants the coarse alpha.
    get displayTexture(){return refine?.texture??pass.texture;},
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
      if(cut){temporal?.reset();refine?.reset();shadows?.reset();}
      uniforms.uFrameIndex.value=frameIndex;uniforms.uUpdatePhase.value=frameIndex%4;
      const previousTarget=renderer.getRenderTarget();renderer.getClearColor(prevClearColor);const previousAlpha=renderer.getClearAlpha();
      // Clear colour goes first: the occupancy scene render autoClears with it.
      renderer.setClearColor(0,0);
      occupancy?.render(camera,mesh.position);
      renderer.setRenderTarget(rawTarget);renderer.clear();renderer.render(cloudScene,camera);
      if(temporal&&rawTarget)temporal.resolve(rawTarget);
      if(refine&&temporal)refine.render(camera,mesh.position,{half:temporal.target.textures[0],display:temporal.texture,meta:temporal.metaTexture});
      renderer.setClearColor(prevClearColor,previousAlpha);renderer.setRenderTarget(previousTarget);
      if(!taa?.enabled)ownPreviousVP.copy(ownCurrentVP);
      previousCameraPosition.copy(camera.position);previousCameraQuaternion.copy(camera.quaternion);previousProjection.copy(camera.projectionMatrix);cameraValid=true;frameIndex++;
    },
    composite(r: THREE.WebGLRenderer){const prev=r.autoClear;r.autoClear=false;compositeMaterial.uniforms.tClouds.value=pass.displayTexture;compositeMaterial.uniforms.tCloudMeta.value=pass.motionTexture;compositeMaterial.uniforms.tCloudSignature.value=pass.signatureTexture;r.render(compositeScene,compositeCamera);r.autoClear=prev;},
    reset(){temporal?.reset();refine?.reset();cameraValid=false;frameIndex=0;},
    dispose(){rawTarget?.dispose();temporal?.dispose();occupancy?.dispose();refine?.dispose();compositeMaterial.dispose();compositeQuad.geometry.dispose();},
  };
  pass.resize();
  const rig={mesh,uniforms,pass,shadows,noise:noiseResources,modes:{profile:profileMode(),weather:weatherMode(),noise:activeNoise,temporal:temporalMode,ambient:ambientMode(),cirrus:cirrusOn,shadows:shadows?.mode??"off",occupancy:occupancy!==null,refine:refine!==null,wisp:cloudWisp(),rim:cloudRim(),debug:DEBUG_MODES[debugMode()]},reset(){pass.reset();shadows?.reset();taa?.reset();},dispose(){pass.dispose();shadows?.dispose();noiseResources?.dispose();curlNoise.dispose();cirrusNoise?.dispose();mesh.geometry.dispose();mesh.material.dispose();}};
  return rig;
}

/** Builds the cloud rig in one blocking task. See {@link buildClouds}. */
export function createClouds(
  scene: THREE.Scene,
  skyUniforms: Record<string, Uniform<unknown>>,
  renderer: THREE.WebGLRenderer,
  taa: TaaApi | null = null
) {
  return drain(buildClouds(scene, skyUniforms, renderer, taa));
}

/** The cloud rig returned by {@link createClouds}. */
export type CloudRig = ReturnType<typeof createClouds>;
/** The offscreen cloud pass; null when the in-scene dome is used. */
export type CloudPass = NonNullable<CloudRig["pass"]>;
