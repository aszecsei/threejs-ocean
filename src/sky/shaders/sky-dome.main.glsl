// Sky dome shading. skyColor() is injected between the declarations and this
// file (see SKY_COLOR_GLSL in sky.ts).

        void main() {
          vec3 dir = normalize(vDir);
          if (uMaskMode > 0.5) {
            // Soft blob a few degrees across around the sun: the light
            // source the screen-space rays radiate from.
            float mu = dot(dir, normalize(uSunDirection));
            // Bright core plus a dim wide skirt: the skirt is what clouds carve
            // streaks out of.
            float m = max(mu, 0.0);
            gl_FragColor = vec4(vec3(0.5 * pow(m, 600.0) + 0.3 * pow(m, 40.0)), 1.0);
            #ifdef TAA_ENABLED
            taaMotion = taaPackMotion(vTaaCurrentClip, vTaaPreviousClip, 0.0);
            taaMotion.z = 1.0;
            #endif
            return;
          }
          vec3 col = skyColor(dir, normalize(uSunDirection), uZenithColor, uHorizonColor, uGroundColor, uSunColor);

          // Linear output: color space and tone mapping are applied once by
          // the post pipeline (post.js).
          gl_FragColor = vec4(col, 1.0);
          #ifdef TAA_ENABLED
          taaMotion = taaPackMotion(vTaaCurrentClip, vTaaPreviousClip, 0.0);
          // The dome does not write depth, so history stores the clear depth.
          taaMotion.z = 1.0;
          #endif
        }
      