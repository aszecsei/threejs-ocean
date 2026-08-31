// Top-down cloud shadow map: one light-direction march per texel, temporally
// accumulated across frames.

      varying vec2 vUv;
      uniform vec3 uSunDirection;
      uniform sampler2D tShadowHistory;
      uniform vec2 uShadowCenter,uPreviousShadowCenter;
      uniform float uShadowExtent,uShadowHistoryValid;
      #include "../../shaders/density.glsl";
      layout(location=0) out vec4 shadowColor;
      void main(){
        vec3 sd=normalize(uSunDirection);
        vec2 receiverXZ=uShadowCenter+(vUv-0.5)*uShadowExtent;
        float s0=(CLOUD_BOTTOM-0.0)/max(sd.y,1e-4);
        float s1=(CB_TOP-0.0)/max(sd.y,1e-4);
        float span=max(s1-s0,0.0);
        float stepLen=span/float(SHADOW_STEPS);
        // Centered strata stay fixed in receiver space. With sixteen slices
        // the slab is resolved without the sparkling caused by random ray
        // offsets on neighboring shadow texels.
        float jitter=0.5;
        float opticalDepth=0.0;
        for(int i=0;i<SHADOW_STEPS;i++){
          float rayS=s0+(float(i)+jitter)*stepLen;
          vec3 p=vec3(receiverXZ.x,0.0,receiverXZ.y)+sd*rayS;
          opticalDepth+=coarseCloudDensity(p)*stepLen;
        }
        float current=exp(-opticalDepth*EXTINCTION);
        vec2 worldXZ=uShadowCenter+(vUv-0.5)*uShadowExtent;
        vec2 previousUv=(worldXZ-uPreviousShadowCenter)/uShadowExtent+0.5;
        float inside=float(all(greaterThanEqual(previousUv,vec2(0.0)))&&all(lessThanEqual(previousUv,vec2(1.0))));
        float history=texture(tShadowHistory,previousUv).r;
        float blend=0.86*uShadowHistoryValid*inside;
        shadowColor=vec4(mix(current,history,blend),0.0,0.0,1.0);
      }
    