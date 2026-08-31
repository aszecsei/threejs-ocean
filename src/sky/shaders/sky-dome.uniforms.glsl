// Sky dome: uniform and varying declarations.

        varying vec3 vDir;
        uniform vec3 uZenithColor;
        uniform vec3 uHorizonColor;
        uniform vec3 uGroundColor;
        uniform vec3 uSunColor;
        uniform vec3 uSunDirection;
        uniform float uMaskMode;
        #ifdef TAA_ENABLED
        varying vec4 vTaaCurrentClip;
        varying vec4 vTaaPreviousClip;
        #endif

#include "../../taa/shaders/contract.glsl";