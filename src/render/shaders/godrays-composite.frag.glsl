// Composites the blurred mask over the finished frame (?rays=debug shows the
// mask instead).

      uniform sampler2D tRays;
      uniform vec3 uSunColor;
      uniform float uStrength;
      uniform float uDebug;
      varying vec2 vUv;
      #include "../../taa/shaders/contract.glsl";
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
    