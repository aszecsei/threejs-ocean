// The TAA contract every scene shader must satisfy.
//
// Under TAA_ENABLED a material writes colour to location 0 and packed motion
// data to location 1. Included by sky, clouds, ocean, god rays and the cloud
// shadow pass so all of them agree on the MRT layout.

  #ifdef TAA_ENABLED
  layout(location = 0) out highp vec4 taaColor;
  layout(location = 1) out highp vec4 taaMotion;
  #define gl_FragColor taaColor

  vec4 taaPackMotion(vec4 currentClip, vec4 previousClip, float reactive) {
    vec2 currentUv = currentClip.xy / max(currentClip.w, 1e-6) * 0.5 + 0.5;
    vec3 previousNdc = previousClip.xyz / max(previousClip.w, 1e-6);
    vec2 previousUv = previousNdc.xy * 0.5 + 0.5;
    return vec4(currentUv - previousUv,
                previousNdc.z * 0.5 + 0.5,
                clamp(reactive, 0.0, 1.0));
  }
  #endif
