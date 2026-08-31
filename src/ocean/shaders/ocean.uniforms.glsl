// Ocean surface: uniform, varying and helper declarations.

  uniform sampler2D uFoam;
  uniform float uFoamSize;
  #ifdef OCEAN_CASCADE2
    uniform sampler2D uFoam2;
    uniform float uFoamSize2;
    varying vec2 vUv2;
    varying float vFade2;
  #endif
  uniform vec3 uSunDirection;
  uniform vec3 uSunColor;
  uniform vec3 uZenithColor;
  uniform vec3 uHorizonColor;
  uniform vec3 uGroundColor;
  uniform vec3 uDeepColor;
  uniform vec3 uSSSColor;
  uniform float uSSSStrength;
  uniform float uSSSPower;
  uniform float uSSSDistort;
  uniform float uRoughness;
  uniform float uTime;
  uniform float uFogNear;
  uniform float uFogFar;
  #ifdef CLOUD_SHADOWS
    uniform sampler2D tCloudShadow;
    uniform vec2 uCloudShadowCenter;
    uniform float uCloudShadowExtent;
    uniform float uCloudShadowEnabled;
  #endif

  // Baked detail texture: RG normal xy, B foam churn, A bubble speckle.
  uniform sampler2D uDetailTex;
  uniform vec2 uDetailScale;
  uniform float uDetailStrength;
  uniform vec4 uDetailPan;
  uniform vec4 uDetailMacro; // scale, strength, warp, unused
  uniform vec2 uDetailMacroPan;
  uniform float uFoamChurnScale;
  uniform float uFoamEdge;
  uniform float uFoamOpacity;
  uniform float uFoamMacroWarp;
  uniform float uFoamBump;

  // Screen-space reflection inputs (scene without the ocean).
  uniform sampler2D uSceneColor;
  uniform sampler2D uSceneDepth;
  uniform mat4 uProjection;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform float uSsrThickness;
  uniform float uSsrEdgeFade;
  // Bounding sphere (center xyz, radius) of the captured geometry (the
  // knot); updated per frame by main.js. Gates the SSR march.
  uniform vec4 uReflectBound;
  // Contact foam: (width, strength, ripple, pulse); 1 / drawing-buffer size.
  uniform vec4 uContact;
  uniform vec2 uInvResolution;

  varying vec2 vUv;
  varying vec3 vWorldPos;
  varying float vHeight;
  varying float vDist;
  #ifdef TAA_ENABLED
    varying vec4 vTaaCurrentClip;
    varying vec4 vTaaPreviousClip;
  #endif

#include "../../taa/shaders/contract.glsl";