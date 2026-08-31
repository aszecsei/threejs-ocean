// ?cloud-debug=shadow -- draws the shadow map itself over the frame.

      uniform sampler2D tShadow; varying vec2 vUv;
      #include "../../../taa/shaders/contract.glsl";
      void main(){ float s=texture2D(tShadow,vUv).r; gl_FragColor=vec4(vec3(s),1.0);
      #ifdef TAA_ENABLED
        taaMotion=vec4(0.0,0.0,0.0,1.0);
      #endif
      }
    