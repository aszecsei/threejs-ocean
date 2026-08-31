// Copies the captured colour, depth and motion into the frame target so the
// ocean pass can march SSR rays against them.

      uniform sampler2D tColor;
      uniform sampler2D tDepth;
      #ifdef TAA_ENABLED
      uniform sampler2D tMotion;
      #endif
      varying vec2 vUv;
      #include "../../taa/shaders/contract.glsl";
      void main() {
        // RT-to-RT copy: stays linear (post.js converts once at the end).
        gl_FragColor = vec4(texture2D(tColor, vUv).rgb, 1.0);
        #ifdef TAA_ENABLED
        taaMotion = texture2D(tMotion, vUv);
        #endif
        gl_FragDepthEXT = texture2D(tDepth, vUv).r;
      }
    