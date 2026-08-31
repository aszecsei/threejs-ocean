// Composites the offscreen cloud buffer over the frame, and serves the
// ?cloud-debug views.
uniform sampler2D tClouds,tCloudMeta,tCloudSignature;uniform float uDebugMode;varying vec2 vUv;
#include "../../taa/shaders/contract.glsl";

      void main(){vec4 c=texture2D(tClouds,vUv);vec4 m=texture2D(tCloudMeta,vUv);
        if(uDebugMode==7.0)c=vec4(vec3(m.z),1.0);else if(uDebugMode==8.0)c=vec4(vec3(m.a),1.0);
        // History confidence = mix(0.45,1,historyWeight): a non-invasive
        // window onto temporal accumulation (reading it can't poison it).
        else if(uDebugMode==11.0)c=vec4(vec3(texture2D(tCloudSignature,vUv).g),1.0);gl_FragColor=c;
        #ifdef TAA_ENABLED
          vec3 globalData=m.xyz;
          #ifdef CLOUD_COMPOSITE_TEMPORAL
            // Temporal metadata keeps representative cloud distance in m.z;
            // signature.a carries the previous clip-space depth required by
            // the global TAA contract.
            globalData.z=texture2D(tCloudSignature,vUv).a;
          #endif
          // The same source-over equation now has valid semantics for both
          // attachments: color is premultiplied by cloud alpha, while motion
          // data is premultiplied by resolved global reactivity.
          taaMotion=vec4(globalData*m.a,m.a);
        #endif
      }
    