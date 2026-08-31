// Presents the resolved history, plus the ?taa=velocity/history/reactive
// diagnostic views.

          uniform sampler2D tHistoryColor;
          uniform sampler2D tHistoryData;
          uniform sampler2D tCurrentMotion;
          uniform vec2 uResolution;
          uniform int uMode;
          varying vec2 vUv;
          out highp vec4 outColor;
          void main() {
            vec4 motion = texture2D(tCurrentMotion, vUv);
            if (uMode == 1) {
              vec2 pixels = motion.xy * uResolution;
              float speed = clamp(length(pixels) / 24.0, 0.0, 1.0);
              outColor = vec4(0.5 + vec3(pixels.x / 24.0, pixels.y / 24.0, speed - 0.5), 1.0);
            } else if (uMode == 2) {
              float w = texture2D(tHistoryData, vUv).g;
              outColor = vec4(vec3(w), 1.0);
            } else if (uMode == 3) {
              outColor = vec4(vec3(clamp(motion.w, 0.0, 1.0)), 1.0);
            } else {
              outColor = texture2D(tHistoryColor, vUv);
            }
          }
        