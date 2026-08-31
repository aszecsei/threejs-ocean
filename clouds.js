import * as THREE from "three";
import { SKY_COLOR_GLSL } from "./sky.js";
import { TAA_FRAGMENT_GLSL, taaMaterialConfig } from "./taa.js";
import { createBlueNoiseTexture, createCirrusNoiseTexture, createCloudNoiseTextures, createCurlNoiseTexture } from "./cloud-noise.js";
import { CLOUD_CIRRUS_GLSL, CLOUD_DENSITY_GLSL } from "./cloud-density.glsl.js";
import { cloudTemporalMode, createCloudTemporal } from "./cloud-temporal.js";
import { createCloudShadows } from "./cloud-shadows.js";

export const CLOUD_SCALE = 60.0;
export const CLOUD_BOTTOM = 5.0 * CLOUD_SCALE;
export const CLOUD_TOP = 15.0 * CLOUD_SCALE;
export const TOWER_TOP = 33.0 * CLOUD_SCALE;

function query(name, fallback) {
  const value = new URLSearchParams(window.location.search).get(name);
  return value === null ? fallback : value;
}
function flagEnabled(name) {
  const value = query(name, null);
  return value === null || (value !== "0" && value !== "false");
}
export function cloudsEnabled() { return flagEnabled("clouds"); }
export function cloudResDivisor() {
  const n = parseInt(query("cloud-res", "2"), 10);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 8) : 2;
}
export function cloudLightReuse() { return flagEnabled("cloud-light"); }
export function cloudFarGrowth() {
  const n = Number(query("cloud-far", "1"));
  return Number.isFinite(n) ? Math.max(0, n) : 1;
}
// Mid-frequency shape band (?cloud-midband=0 disables, or a 0-2 strength
// multiplier). Fills the feature-size gap between the base billows and the
// detail erosion; on by default.
export function cloudMidBand() {
  const v = query("cloud-midband", "1");
  if (v === "" || v === "true") return 1;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(2, n)) : 0;
}

// High-altitude 2.5-D cirrus layer (?cirrus=0 compiles it out entirely).
export function cirrusEnabled() { return flagEnabled("cirrus"); }
function cirrusParam(name, fallback) {
  const n = Number(query(name, String(fallback)));
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}
function cirrusCoverage() { return cirrusParam("cirrus-coverage", 0.40); }
function cirrusType() { return cirrusParam("cirrus-type", 0.25); }

const DEBUG_MODES = ["", "profile", "coverage", "type", "base-noise", "detail-noise", "coarse-density", "cloud-depth", "cloud-reactive", "shadow", "ambient", "history", "cirrus-coverage", "cirrus-density"];
function debugMode() {
  const mode = query("cloud-debug", "");
  if (mode === "ambient-only") return DEBUG_MODES.indexOf("ambient");
  return Math.max(0, DEBUG_MODES.indexOf(mode));
}
function profileMode() { return query("cloud-profile", "dimensional") === "legacy" ? "legacy" : "dimensional"; }
function weatherMode() { return query("cloud-weather", "split") === "coupled" ? "coupled" : "split"; }
function noiseMode() { return query("cloud-noise", "texture") === "procedural" ? "procedural" : "texture"; }
function ambientMode() { return query("cloud-ambient", "coarse") === "legacy" ? "legacy" : "coarse"; }

export function createClouds(scene, skyUniforms, renderer, taa = null) {
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
  const len = k => (k * S).toFixed(1);
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

  const fragmentShader = /* glsl */ `
    varying vec3 vDir;
    uniform float uMaskMode,uFrameIndex,uUpdatePhase,uDebugMode;
    uniform sampler2D tCloudBlueNoise;
    uniform vec3 uSunDirection,uSunColor,uZenithColor,uHorizonColor,uGroundColor;
    uniform mat4 uCurrentViewProjection,uPreviousViewProjection;
    uniform float uTaaDeltaTime;
    #ifndef TAA_ENABLED
      layout(location=0) out highp vec4 cloudColor;
      #define gl_FragColor cloudColor
      #ifdef CLOUD_TEMPORAL
        layout(location=1) out highp vec4 cloudMeta;
      #endif
    #endif
    #ifdef CLOUD_TEMPORAL
      layout(location=2) out highp vec4 cloudSignature;
    #endif
    ${TAA_FRAGMENT_GLSL}
    ${SKY_COLOR_GLSL}
    ${CLOUD_DENSITY_GLSL}

    float lightOpticalDepth(vec3 p,int maxSteps){
      vec3 sd=normalize(uSunDirection);float od=0.0,t=0.0,stepLen=LIGHT_STEP0;
      for(int i=0;i<LIGHT_STEPS;i++){if(i>=maxSteps)break;vec3 sp=p+sd*(t+stepLen*0.5);if(sp.y>CB_TOP)break;
        od+=coarseCloudDensity(sp)*stepLen;if(od*EXTINCTION>6.0)break;t+=stepLen;stepLen*=LIGHT_GROWTH;}
      return od*EXTINCTION;
    }
    vec3 desat(vec3 c,float k){return mix(vec3(dot(c,LUMA)),c,k);}
    float hgPhase(float mu,float g){float g2=g*g;return(1.0-g2)/(12.5663706*pow(1.0+g2-2.0*g*mu,1.5));}
    vec3 coarseAmbient(vec3 p,CloudSample cloudPoint,out float localDensity,out vec3 bounce){
      float stepLen=120.0;
      float up=coarseCloudDensity(p+vec3(0,stepLen,0));
      float down=coarseCloudDensity(p-vec3(0,stepLen,0));
      float sideA=coarseCloudDensity(p+vec3(stepLen,0,0));
      float sideB=coarseCloudDensity(p+vec3(0,0,stepLen));
      localDensity=(up+down+sideA+sideB)*0.25;
      float heightExponent=mix(0.5,2.0,clamp((cloudPoint.height-0.30)/0.55,0.0,1.0));
      float pDepth=0.05+pow(clamp(localDensity,0.0,1.0),heightExponent);
      float pVertical=pow(clamp(cloudRemap(cloudPoint.height,0.07,0.14,0.10,1.0),0.0,1.0),0.8);
      float inscatter=clamp(pDepth*pVertical,0.0,1.0);
      float trUp=exp(-up*stepLen*EXTINCTION*0.55);
      float trDown=exp(-down*stepLen*EXTINCTION*0.55);
      vec3 sky=desat(mix(uHorizonColor,uZenithColor,cloudPoint.height),0.35)*trUp;
      vec3 ground=desat(uGroundColor,0.28)*trDown*0.58;
      // Faked sun-off-ground bounce for the undersides. Returned separately
      // so the caller can add it AFTER the direct-shadow collapse: bases sit
      // at large sun optical depth, and inside the shade mix this term would
      // be flattened to the same shadow tint as everything else. Downward
      // openness (trDown) keeps it local: tufts over open air glow, crevices
      // above other cloud stay dark.
      float sunUp=clamp(normalize(uSunDirection).y*1.8,0.0,1.0);
      bounce=desat(mix(uGroundColor,uSunColor,0.40),0.35)
        *(0.82*trDown*pow(clamp(1.0-cloudPoint.height,0.0,1.0),1.5)*sunUp);
      return (sky+ground+desat(mix(uZenithColor,uHorizonColor,0.72),0.25)*inscatter*0.42)*0.82+vec3(0.05);
    }
    ${CLOUD_CIRRUS_GLSL}

    void main(){
      #ifdef CLOUD_INTERLEAVED
        ivec2 pixel=ivec2(gl_FragCoord.xy);
        int phase=(pixel.x&1)+2*(pixel.y&1);
        if(phase!=int(uUpdatePhase))discard;
      #endif
      vec3 dir=normalize(vDir),eye=cameraPosition,sd=normalize(uSunDirection);
      float t0=0.0,t1=-1.0;
      if(abs(dir.y)>1e-4){float ta=(CLOUD_BOTTOM-eye.y)/dir.y;float tb=(CB_TOP-eye.y)/dir.y;t0=max(min(ta,tb),0.0);t1=max(ta,tb);}
      else if(eye.y>CLOUD_BOTTOM&&eye.y<CB_TOP)t1=MAX_DIST;
      if(t1<=t0){
        #ifdef CLOUD_TEMPORAL
          gl_FragColor=vec4(0.0);
          #ifdef TAA_ENABLED
            taaMotion=vec4(0.0);
          #else
            cloudMeta=vec4(0.0);
          #endif
          cloudSignature=vec4(0.0,1.0,0.0,1.0);
          return;
        #else
          discard;
        #endif
      }
      t1=min(t1,t0+MAX_DIST);
      float horizonFade=smoothstep(0.0,0.06,abs(dir.y));
      if(horizonFade<0.004){
        #ifdef CLOUD_TEMPORAL
          gl_FragColor=vec4(0.0);
          #ifdef TAA_ENABLED
            taaMotion=vec4(0.0);
          #else
            cloudMeta=vec4(0.0);
          #endif
          cloudSignature=vec4(0.0,1.0,0.0,1.0);
          return;
        #else
          discard;
        #endif
      }
      vec3 skyBehind=skyColor(dir,sd,uZenithColor,uHorizonColor,uGroundColor,uSunColor);
      // Void-and-cluster blue-noise march offsets (animated by golden-ratio
      // frame phase): the sampling error lands in frequencies the temporal
      // clamp and TAA absorb, instead of white-noise sparkle.
      float jitter=fract(texelFetch(tCloudBlueNoise,ivec2(gl_FragCoord.xy)&63,0).r+uFrameIndex*0.61803398875);
      float mu=dot(dir,sd),airMass=1.0-0.7*max(dir.y,0.0);
      // Coarse stride capped at 1.4x: at 2x a far coarse step could leap
      // clean over a whole 100-300 unit clump, making it flicker with the
      // per-frame jitter phase in a way no history accumulation can fix.
      float baseStep=(t1-t0)/float(PRIMARY_STEPS),fineStep=baseStep*0.5,coarseStep=baseStep*1.4;
      float tStart=t0+jitter*fineStep,t=tStart;bool fine=false;int emptyRun=0;
      vec3 scattered=vec3(0);float transmittance=1.0,distanceSum=0.0,motionWeight=0.0,densitySum=0.0;
      float debugValue=0.0,debugWeight=0.0,cachedOd=0.0,cachedCoarse=0.0;vec3 cachedAmbient=vec3(0),cachedBounce=vec3(0);int odAge=99,ambientAge=99;
      vec3 shadowTintBase=desat(mix(uZenithColor,uHorizonColor,0.62),0.30)*0.42;
      for(int i=0;i<PRIMARY_STEPS;i++){
        if(t>t1||transmittance<0.02)break;vec3 p=eye+dir*t;float stepScale=1.0+t*FAR_STEP_GROWTH;
        if(!fine){
          CloudSample probe=sampleCloudDensity(p,2,uDebugMode==5.0);
          if(uDebugMode==1.0)debugValue=max(debugValue,probe.profile);
          else if(uDebugMode==2.0)debugValue=max(debugValue,probe.coverage);
          else if(uDebugMode==3.0)debugValue=max(debugValue,probe.type);
          else if(uDebugMode==4.0)debugValue=max(debugValue,probe.baseNoise);
          else if(uDebugMode==5.0)debugValue=max(debugValue,probe.detailNoise);
          else if(uDebugMode==6.0)debugValue=max(debugValue,probe.density);
          if(probe.density<=0.004){t+=coarseStep*stepScale;continue;}
          t=max(t-(coarseStep-fineStep)*stepScale,tStart);fine=true;emptyRun=0;odAge=ambientAge=99;continue;
        }
        float stepLen=fineStep*stepScale;float detailFade=1.0-smoothstep(DETAIL_FADE_START,DETAIL_FADE_END,t);CloudSample cloudPoint=sampleCloudDensityLod(p,5,true,detailFade);float d=cloudPoint.density;
        if(d<=0.004){emptyRun++;if(emptyRun>=4)fine=false;t+=stepLen;continue;}emptyRun=0;
        float sampleExt=d*EXTINCTION*stepLen;float contribution=transmittance*(1.0-exp(-sampleExt));
        distanceSum+=contribution*t;motionWeight+=contribution;densitySum+=contribution*d;
        if(uMaskMode>0.5){transmittance*=exp(-sampleExt);t+=stepLen;continue;}
        #ifdef LIGHT_REUSE
          if(odAge>=2){cachedOd=lightOpticalDepth(p,transmittance<0.3?LIGHT_STEPS/2:LIGHT_STEPS);odAge=0;}odAge++;float od=cachedOd;
        #else
          float od=lightOpticalDepth(p,LIGHT_STEPS);
        #endif
        // Short-range self-shadow at full detail frequency, never cached:
        // the coarse light march cannot see billow-scale density, so without
        // this every clump shades identically and the surface reads flat.
        // Differential form — only density in excess of the local sample
        // (a crevice behind an overhang) casts near shadow; an exposed
        // sun-facing billow stays bright even deep inside a dense mass.
        // Kept gentle and distance-faded: at full strength this term flips
        // pixels between lit and shadowed at detail frequency, which reads
        // as salt-and-pepper stipple on sunlit faces.
        float nbr=sampleCloudDensityLod(p+sd*(NEAR_SHADOW_STEP*0.6),5,true,detailFade).density;
        od+=clamp(nbr-d*0.6,0.0,0.9)*NEAR_SHADOW_STEP*EXTINCTION*0.6*(0.35+0.65*detailFade);
        float sun=0.0,ext=1.0,att=1.0;for(int j=0;j<3;j++){sun+=att*hgPhase(mu,0.55*pow(0.5,float(j)))*exp(-od*ext);ext*=0.55;att*=0.55;}
        sun+=0.08*hgPhase(mu,0.85)*exp(-od*0.5);
        // Nubis-style long-reach term: a weak, broad lobe with a quarter-rate
        // Beer exponent keeps thick interiors glowing instead of flat-ambient.
        sun+=0.15*hgPhase(mu,0.30)*exp(-od*0.22);float powder=1.0-exp(-od*2.0);sun*=mix(1.0,powder,0.6*(0.5-0.5*mu));
        #ifdef CLOUD_AMBIENT_COARSE
          if(ambientAge>=2){cachedAmbient=coarseAmbient(p,cloudPoint,cachedCoarse,cachedBounce);ambientAge=0;}ambientAge++;vec3 ambient=cachedAmbient;
        #else
          float hf=cloudPoint.height;vec3 ambient=desat(mix(uHorizonColor,uZenithColor,hf),0.35)*0.9+vec3(0.12)+vec3(0.30)*hf+vec3(0.42,0.50,0.62)*(1.0-hf);cachedCoarse=d;
        #endif
        float shade=exp(-od*0.9);vec3 shadowTint=shadowTintBase*mix(1.0,0.86,cloudPoint.tower);ambient=mix(shadowTint,ambient,shade);
        // Bounce added outside the shade mix so it survives on shadowed
        // bases; the soft od term varies it with the same optical depth
        // (including the near-shadow differential) that shades the sun term,
        // which is what puts texture back into the undersides.
        ambient+=cachedBounce*mix(0.22,1.0,exp(-od*0.30));
        vec3 luminance=ambient+uSunColor*sun*2.4;float haze=1.0-exp(-t*airMass/HAZE_DIST);luminance=mix(luminance,skyBehind,haze);
        scattered+=contribution*luminance;transmittance*=exp(-sampleExt);t+=stepLen;
        debugWeight+=contribution; if(uDebugMode==6.0)debugValue=max(debugValue,cachedCoarse); if(uDebugMode==10.0)debugValue=max(debugValue,dot(ambient,LUMA));
      }
      // The cirrus layer sits behind and above everything the march covered,
      // so its lit color is attenuated by the remaining transmittance and it
      // folds into scattered/transmittance before opacity/alpha — every
      // downstream path (mask, premultiplied, straight-alpha) is unchanged.
      #ifdef CLOUD_CIRRUS
        float cirrusAlpha=0.0;
        if(transmittance>0.02||uDebugMode>=12.0){
          float tC=cirrusIntersect(eye,dir);
          if(tC>0.0){
            CirrusSample cirrusPoint=cirrusField(eye.xz+dir.xz*tC);
            if(uDebugMode==12.0)debugValue=cirrusPoint.coverage;
            else if(uDebugMode==13.0)debugValue=cirrusPoint.density;
            vec4 cirrus=cirrusApply(cirrusPoint,dir,tC,mu,airMass,skyBehind,uMaskMode>0.5);
            scattered+=transmittance*cirrus.rgb;
            transmittance*=1.0-cirrus.a;
            cirrusAlpha=cirrus.a;
          }
        }
      #endif
      float opacity=1.0-transmittance,alpha=opacity*horizonFade;
      bool fieldDebug=uDebugMode>=1.0&&uDebugMode<=6.0||uDebugMode==10.0||uDebugMode>=12.0;
      // A transparent full-update sample is still current information. Only
      // the interleaved phase discard above marks a ray as not rendered.
      #ifndef CLOUD_TEMPORAL
        if(alpha<0.004&&!fieldDebug)discard;
      #endif
      float cloudDistance=distanceSum/max(motionWeight,1e-5);
      // Cirrus stays out of the contribution-weighted distance: its 4k-60k
      // unit intersections would blow past MAX_DIST and wreck the resolve's
      // depth-validity test on mixed pixels. On cirrus-only pixels, though,
      // motionWeight~0 would reproject the camera position itself; a far
      // point is rotation-exact there and keeps meta.z stable at 1.0.
      #ifdef CLOUD_CIRRUS
        if(motionWeight<1e-4&&cirrusAlpha>0.004)cloudDistance=MAX_DIST;
      #endif
      vec3 world=eye+dir*cloudDistance;
      vec3 previousWorld=world;previousWorld.xz+=uTaaDeltaTime*(WIND_SPEED/NOISE_SCALE)*WIND_DIR;
      vec4 currentClip=uCurrentViewProjection*vec4(world,1),previousClip=uPreviousViewProjection*vec4(previousWorld,1);
      vec2 currentUv=currentClip.xy/max(currentClip.w,1e-6)*0.5+0.5;
      vec3 previousNdc=previousClip.xyz/max(previousClip.w,1e-6);vec2 velocity=currentUv-(previousNdc.xy*0.5+0.5);
      float previousDepth=previousNdc.z*0.5+0.5;
      if(alpha<0.004){velocity=vec2(0.0);previousDepth=1.0;}
      if(uMaskMode>0.5){gl_FragColor=vec4(0,0,0,alpha);
        #ifdef TAA_ENABLED
          taaMotion=vec4(velocity,previousNdc.z*0.5+0.5,alpha);
        #elif defined(CLOUD_TEMPORAL)
          cloudMeta=vec4(velocity,cloudDistance/MAX_DIST,alpha);
        #endif
        #ifdef CLOUD_TEMPORAL
          cloudSignature=vec4(densitySum/max(motionWeight,1e-5),1.0,alpha,previousDepth);
        #endif
        return;
      }
      if(fieldDebug){
        vec3 ramp=uDebugMode==3.0?mix(vec3(0.08,0.2,0.75),vec3(1.0,0.35,0.08),debugValue):vec3(debugValue);
        gl_FragColor=vec4(ramp,1.0);
      }else{
        vec3 straight=scattered/max(opacity,1e-5);
        #ifdef CLOUD_PREMULTIPLIED
          gl_FragColor=vec4(straight*alpha,alpha);
        #else
          gl_FragColor=vec4(straight,alpha);
        #endif
      }
      #ifdef CLOUD_TEMPORAL
        // Cloud-space history compares opacity and density itself. Keep
        // opacity out of instantaneous reactivity so opaque clouds can
        // accumulate. The small floor covers unresolved detail evolution.
        float instantaneousReactive=alpha>=0.004?0.04:0.0;
        #ifdef TAA_ENABLED
          taaMotion=vec4(velocity,cloudDistance/MAX_DIST,instantaneousReactive);
        #else
          cloudMeta=vec4(velocity,cloudDistance/MAX_DIST,instantaneousReactive);
        #endif
        cloudSignature=vec4(densitySum/max(motionWeight,1e-5),1.0,alpha,previousDepth);
      #elif defined(TAA_ENABLED)
        taaMotion=vec4(velocity,previousNdc.z*0.5+0.5,alpha);
      #endif
    }
  `;

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(58,32,16), new THREE.ShaderMaterial({
    uniforms,
    side: THREE.BackSide,
    transparent: divisor === 0,
    depthWrite: false,
    blending: divisor === 0 ? THREE.NormalBlending : THREE.NoBlending,
    glslVersion: THREE.GLSL3,
    defines: materialDefines,
    vertexShader: /* glsl */ `varying vec3 vDir;void main(){vDir=position;gl_Position=projectionMatrix*viewMatrix*modelMatrix*vec4(position,1.0);}`,
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
    vertexShader:/* glsl */`varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.99985,1.0);}`,
    fragmentShader:/* glsl */`uniform sampler2D tClouds,tCloudMeta,tCloudSignature;uniform float uDebugMode;varying vec2 vUv;${TAA_FRAGMENT_GLSL}
      void main(){vec4 c=texture2D(tClouds,vUv);vec4 m=texture2D(tCloudMeta,vUv);
        if(uDebugMode==7.0)c=vec4(vec3(m.z),1.0);else if(uDebugMode==8.0)c=vec4(vec3(m.a),1.0);
        // History confidence = mix(0.45,1,historyWeight): a non-invasive
        // window onto temporal accumulation (reading it can't poison it).
        else if(uDebugMode==11.0)c=vec4(vec3(texture2D(tCloudSignature,vUv).g),1.0);gl_FragColor=c;
        #ifdef TAA_ENABLED
          vec3 globalData=m.xyz;
          #ifdef CLOUD_COMPOSITE_TEMPORAL
            // Temporal metadata keeps representative cloud distance in m.z;
            // signature.a carries the previous clip-space depth required by
            // the global TAA contract.
            globalData.z=texture2D(tCloudSignature,vUv).a;
          #endif
          // The same source-over equation now has valid semantics for both
          // attachments: color is premultiplied by cloud alpha, while motion
          // data is premultiplied by resolved global reactivity.
          taaMotion=vec4(globalData*m.a,m.a);
        #endif
      }
    `,
  });
  const compositeScene=new THREE.Scene(),compositeCamera=new THREE.OrthographicCamera(-1,1,1,-1,0,1);
  const compositeQuad=new THREE.Mesh(new THREE.PlaneGeometry(2,2),compositeMaterial);compositeQuad.frustumCulled=false;compositeScene.add(compositeQuad);
  const size=new THREE.Vector2();let rawTarget=null,temporal=null,frameIndex=0,lastTime=0;
  const previousCameraPosition=new THREE.Vector3(),previousCameraQuaternion=new THREE.Quaternion(),previousProjection=new THREE.Matrix4();let cameraValid=false;
  const prevClearColor=new THREE.Color();
  function makeRawTarget(w,h){
    const count=temporalMode!=="off"?3:(taa?.enabled?2:1);
    const target=new THREE.WebGLRenderTarget(w,h,{...(count>1?{count}:{}),type:THREE.HalfFloatType,minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter,depthBuffer:false,stencilBuffer:false});
    target.textures[0].name="Cloud.rawColor";if(count>1)target.textures[1].name="Cloud.rawMeta";if(count>2)target.textures[2].name="Cloud.rawSignature";return target;
  }
  const pass={
    resize(){renderer.getDrawingBufferSize(size);const w=Math.max(1,Math.floor(size.x/divisor)),h=Math.max(1,Math.floor(size.y/divisor));rawTarget?.dispose();rawTarget=makeRawTarget(w,h);if(temporal)temporal.resize(w,h);else temporal=createCloudTemporal(renderer,temporalMode,w,h);cameraValid=false;},
    get texture(){return temporal?.texture??rawTarget.texture;},
    get motionTexture(){return temporal?.metaTexture??(rawTarget.textures[1]??null);},
    get signatureTexture(){return temporal?.signatureTexture??(rawTarget.textures[2]??null);},
    get rawTarget(){return rawTarget;},
    get resolvedTarget(){return temporal;},
    render(camera){
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
      if(temporal)temporal.resolve(rawTarget);
      renderer.setClearColor(prevClearColor,previousAlpha);renderer.setRenderTarget(previousTarget);
      if(!taa?.enabled)ownPreviousVP.copy(ownCurrentVP);
      previousCameraPosition.copy(camera.position);previousCameraQuaternion.copy(camera.quaternion);previousProjection.copy(camera.projectionMatrix);cameraValid=true;frameIndex++;
    },
    composite(r){const prev=r.autoClear;r.autoClear=false;compositeMaterial.uniforms.tClouds.value=pass.texture;compositeMaterial.uniforms.tCloudMeta.value=pass.motionTexture;compositeMaterial.uniforms.tCloudSignature.value=pass.signatureTexture;r.render(compositeScene,compositeCamera);r.autoClear=prev;},
    reset(){temporal?.reset();cameraValid=false;frameIndex=0;},
    dispose(){rawTarget?.dispose();temporal?.dispose();compositeMaterial.dispose();compositeQuad.geometry.dispose();},
  };
  pass.resize();
  const rig={mesh,uniforms,pass,shadows,noise:noiseResources,modes:{profile:profileMode(),weather:weatherMode(),noise:activeNoise,temporal:temporalMode,ambient:ambientMode(),cirrus:cirrusOn,shadows:shadows?.mode??"off",debug:DEBUG_MODES[debugMode()]},reset(){pass.reset();shadows?.reset();taa?.reset();},dispose(){pass.dispose();shadows?.dispose();noiseResources?.dispose();curlNoise.dispose();cirrusNoise?.dispose();mesh.geometry.dispose();mesh.material.dispose();}};
  return rig;
}
