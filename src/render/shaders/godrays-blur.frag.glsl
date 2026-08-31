// Radial blur toward the sun. BLUR_SAMPLES and BLUR_DECAY arrive as #defines
// from the material so the loop bound stays a compile-time constant.

      uniform sampler2D tDiffuse;
      uniform vec2 uSunUv;
      uniform float uReach;
      varying vec2 vUv;
      void main() {
        vec2 delta = (uSunUv - vUv) * uReach / float(BLUR_SAMPLES);
        vec2 uv = vUv;
        vec3 sum = vec3(0.0);
        float w = 1.0;
        for (int i = 0; i < BLUR_SAMPLES; i++) {
          sum += texture2D(tDiffuse, uv).rgb * w;
          uv += delta;
          w *= BLUR_DECAY;
        }
        gl_FragColor = vec4(sum / float(BLUR_SAMPLES), 1.0);
      }
    