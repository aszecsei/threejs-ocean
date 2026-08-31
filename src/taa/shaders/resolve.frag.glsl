// Temporal resolve: reproject history, clip it to the neighbourhood of the
// current sample in YCoCg, and blend.

          uniform sampler2D tCurrentColor;
          uniform sampler2D tCurrentMotion;
          uniform sampler2D tCurrentDepth;
          uniform sampler2D tHistoryColor;
          uniform sampler2D tHistoryData;
          uniform vec2 uInvResolution;
          uniform float uCameraNear;
          uniform float uCameraFar;
          uniform float uHistoryValid;
          varying vec2 vUv;
          layout(location = 0) out highp vec4 outHistoryColor;
          layout(location = 1) out highp vec4 outHistoryData;

          vec3 rgbToYCoCg(vec3 c) {
            return vec3(c.r * 0.25 + c.g * 0.5 + c.b * 0.25,
                        c.r * 0.5 - c.b * 0.5,
                       -c.r * 0.25 + c.g * 0.5 - c.b * 0.25);
          }
          vec3 yCoCgToRgb(vec3 c) {
            return vec3(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z);
          }
          float viewDepth(float d) {
            float z = d * 2.0 - 1.0;
            return (2.0 * uCameraNear * uCameraFar) /
                   max(uCameraFar + uCameraNear - z * (uCameraFar - uCameraNear), 1e-5);
          }

          void main() {
            vec4 motion = texture2D(tCurrentMotion, vUv);
            vec2 previousUv = vUv - motion.xy;
            bool inBounds = all(greaterThanEqual(previousUv, vec2(0.0))) &&
                            all(lessThanEqual(previousUv, vec2(1.0)));

            vec3 current = texture2D(tCurrentColor, vUv).rgb;
            vec3 history = inBounds ? texture2D(tHistoryColor, previousUv).rgb : current;
            vec2 previousData = inBounds ? texture2D(tHistoryData, previousUv).rg : vec2(0.0);

            float expectedDepth = viewDepth(clamp(motion.z, 0.0, 1.0));
            float storedDepth = viewDepth(clamp(previousData.x, 0.0, 1.0));
            float relativeDepthError = abs(expectedDepth - storedDepth) /
                                       max(min(expectedDepth, storedDepth), 1.0);
            float depthValid = 1.0 - smoothstep(0.015, 0.04, relativeDepthError);

            vec3 lo = vec3(1e20);
            vec3 hi = vec3(-1e20);
            for (int y = -1; y <= 1; y++) {
              for (int x = -1; x <= 1; x++) {
                vec2 suv = clamp(vUv + vec2(float(x), float(y)) * uInvResolution,
                                 vec2(0.0), vec2(1.0));
                vec3 yc = rgbToYCoCg(texture2D(tCurrentColor, suv).rgb);
                lo = min(lo, yc);
                hi = max(hi, yc);
              }
            }
            vec3 extent = (hi - lo) * 0.08 + vec3(0.004, 0.002, 0.002);
            history = yCoCgToRgb(clamp(rgbToYCoCg(history), lo - extent, hi + extent));

            float velocityPixels = length(motion.xy / uInvResolution);
            float motionTrust = exp(-velocityPixels * 0.025);
            float reactiveTrust = 1.0 - clamp(motion.w, 0.0, 1.0);
            float weight = 0.92 * motionTrust * reactiveTrust * depthValid;
            weight *= uHistoryValid * (inBounds ? 1.0 : 0.0);

            vec3 resolved = mix(current, history, weight);
            float currentDepth = texture2D(tCurrentDepth, vUv).r;
            outHistoryColor = vec4(resolved, 1.0);
            outHistoryData = vec4(currentDepth, weight, 0.0, 1.0);
          }
        