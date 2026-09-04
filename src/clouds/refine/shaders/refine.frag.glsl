// Full-res edge refinement: re-marches only the pixels the half-res image
// flags as edges, and carries the blurred half-res image through everywhere
// else, so the output is a dense full-res cloud image the composite can read
// directly. Never discards: its temporal history needs a value at every
// texel, and a reprojected edge that lands on an unrefined pixel must read
// the half-res image, not a stale one.
//
// Uniforms, skyColor(), the density field, march.lighting.glsl and
// march.core.glsl are injected ahead of this file, exactly as for the dome.
    uniform sampler2D tCloudHalf,tCloudHalfDisplay;
    uniform vec2 uInvHalfResolution;
#include "../../shaders/edge-mask.glsl";
    void main(){
      vec2 uv=gl_FragCoord.xy*uInvResolution;
      float w=cloudEdgeWeight(tCloudHalf,uv,uInvHalfResolution);
      vec4 fallback=texture(tCloudHalfDisplay,uv);
      if(uDebugMode==15.0){gl_FragColor=vec4(vec3(w),1.0);return;}
      if(uDebugMode==16.0)fallback=vec4(0.0);
      // Most of the frame leaves here: nine alpha taps and one fetch.
      if(w<=0.0){gl_FragColor=fallback;return;}
      vec3 dir=normalize(vDir),eye=cameraPosition,sd=normalize(uSunDirection);
      float t0,t1;
      float horizonFade=smoothstep(0.0,0.06,abs(dir.y));
      if(!cloudSlab(eye,dir,t0,t1)||horizonFade<0.004){gl_FragColor=fallback;return;}
      vec3 skyBehind=skyColor(dir,sd,uZenithColor,uHorizonColor,uGroundColor,uSunColor);
      // Same blue-noise offsets as the dome, on this pass's own pixel grid.
      // The phase differs from the half-res ray through the same spot; that
      // is fine, each accumulator averages its own.
      float jitter=fract(texelFetch(tCloudBlueNoise,ivec2(gl_FragCoord.xy)&63,0).r+uFrameIndex*0.61803398875);
      float mu=dot(dir,sd),airMass=1.0-0.7*max(dir.y,0.0);
      // Same step sizing as the dome so per-sample energy matches: a refined
      // pixel must converge to the same value as its half-res neighbour.
      float baseStep=(t1-t0)/float(PRIMARY_STEPS);
      occupancyNarrow(uv,t0,t1);
      MarchResult r=marchClouds(eye,dir,t0,t1,baseStep,jitter,mu,airMass,skyBehind);
      vec3 scattered=r.scattered;float transmittance=r.transmittance;
      #ifdef CLOUD_CIRRUS
        if(transmittance>0.02){
          float tC=cirrusIntersect(eye,dir);
          if(tC>0.0){
            vec4 cirrus=cirrusApply(cirrusField(eye.xz+dir.xz*tC),dir,tC,mu,airMass,skyBehind,false);
            scattered+=transmittance*cirrus.rgb;
            transmittance*=1.0-cirrus.a;
          }
        }
      #endif
      float opacity=1.0-transmittance,alpha=opacity*horizonFade;
      vec4 refined=vec4(scattered/max(opacity,1e-5)*alpha,alpha);
      gl_FragColor=mix(fallback,refined,w);
    }
