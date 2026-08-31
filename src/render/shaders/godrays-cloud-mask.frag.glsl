// Folds the offscreen cloud buffer into the occlusion mask, so the dome does
// not have to be marched a second time.

          uniform sampler2D tClouds;
          varying vec2 vUv;
          void main() {
            gl_FragColor = vec4(0.0, 0.0, 0.0, texture2D(tClouds, vUv).a);
          }
        