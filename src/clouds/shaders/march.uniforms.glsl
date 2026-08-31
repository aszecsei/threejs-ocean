// Cloud dome march: uniform and varying declarations.

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
#include "../../taa/shaders/contract.glsl";