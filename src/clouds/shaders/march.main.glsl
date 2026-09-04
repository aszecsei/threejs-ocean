// Cloud dome raymarch entry point. Uniforms, skyColor(), the density field,
// march.lighting.glsl and march.core.glsl are injected ahead of this file.

    void main(){
      #ifdef CLOUD_INTERLEAVED
        ivec2 pixel=ivec2(gl_FragCoord.xy);
        int phase=(pixel.x&1)+2*(pixel.y&1);
        if(phase!=int(uUpdatePhase))discard;
      #endif
      vec3 dir=normalize(vDir),eye=cameraPosition,sd=normalize(uSunDirection);
      float t0,t1;
      if(!cloudSlab(eye,dir,t0,t1)){
        #ifdef CLOUD_TEMPORAL
          gl_FragColor=vec4(0.0);
          #ifdef TAA_ENABLED
            taaMotion=vec4(0.0);
          #else
            cloudMeta=vec4(0.0);
          #endif
          cloudSignature=vec4(0.0,1.0,0.0,1.0);
          return;
        #else
          discard;
        #endif
      }
      float horizonFade=smoothstep(0.0,0.06,abs(dir.y));
      if(horizonFade<0.004){
        #ifdef CLOUD_TEMPORAL
          gl_FragColor=vec4(0.0);
          #ifdef TAA_ENABLED
            taaMotion=vec4(0.0);
          #else
            cloudMeta=vec4(0.0);
          #endif
          cloudSignature=vec4(0.0,1.0,0.0,1.0);
          return;
        #else
          discard;
        #endif
      }
      vec3 skyBehind=skyColor(dir,sd,uZenithColor,uHorizonColor,uGroundColor,uSunColor);
      // Void-and-cluster blue-noise march offsets (animated by golden-ratio
      // frame phase): the sampling error lands in frequencies the temporal
      // clamp and TAA absorb, instead of white-noise sparkle.
      float jitter=fract(texelFetch(tCloudBlueNoise,ivec2(gl_FragCoord.xy)&63,0).r+uFrameIndex*0.61803398875);
      float mu=dot(dir,sd),airMass=1.0-0.7*max(dir.y,0.0);
      float baseStep=(t1-t0)/float(PRIMARY_STEPS);
      vec2 screenUv=gl_FragCoord.xy*uInvResolution;
      #ifdef CLOUD_OCCUPANCY
        if(uDebugMode==14.0){
          gl_FragColor=vec4(occupancyFetch(screenUv),1.0);
          #ifdef CLOUD_TEMPORAL
            #ifdef TAA_ENABLED
              taaMotion=vec4(0.0);
            #else
              cloudMeta=vec4(0.0);
            #endif
            cloudSignature=vec4(0.0,1.0,1.0,1.0);
          #endif
          return;
        }
      #endif
      occupancyNarrow(screenUv,t0,t1);
      MarchResult r=marchClouds(eye,dir,t0,t1,baseStep,jitter,mu,airMass,skyBehind);
      vec3 scattered=r.scattered;float transmittance=r.transmittance,distanceSum=r.distanceSum,motionWeight=r.motionWeight,densitySum=r.densitySum,debugValue=r.debugValue;
      // The cirrus layer sits behind and above everything the march covered,
      // so its lit color is attenuated by the remaining transmittance and it
      // folds into scattered/transmittance before opacity/alpha — every
      // downstream path (mask, premultiplied, straight-alpha) is unchanged.
      #ifdef CLOUD_CIRRUS
        float cirrusAlpha=0.0;
        if(transmittance>0.02||uDebugMode>=12.0){
          float tC=cirrusIntersect(eye,dir);
          if(tC>0.0){
            CirrusSample cirrusPoint=cirrusField(eye.xz+dir.xz*tC);
            if(uDebugMode==12.0)debugValue=cirrusPoint.coverage;
            else if(uDebugMode==13.0)debugValue=cirrusPoint.density;
            vec4 cirrus=cirrusApply(cirrusPoint,dir,tC,mu,airMass,skyBehind,uMaskMode>0.5);
            scattered+=transmittance*cirrus.rgb;
            transmittance*=1.0-cirrus.a;
            cirrusAlpha=cirrus.a;
          }
        }
      #endif
      float opacity=1.0-transmittance,alpha=opacity*horizonFade;
      bool fieldDebug=uDebugMode>=1.0&&uDebugMode<=6.0||uDebugMode==10.0||(uDebugMode>=12.0&&uDebugMode<=13.0);
      // A transparent full-update sample is still current information. Only
      // the interleaved phase discard above marks a ray as not rendered.
      #ifndef CLOUD_TEMPORAL
        if(alpha<0.004&&!fieldDebug)discard;
      #endif
      float cloudDistance=distanceSum/max(motionWeight,1e-5);
      // Cirrus stays out of the contribution-weighted distance: its 4k-60k
      // unit intersections would blow past MAX_DIST and wreck the resolve's
      // depth-validity test on mixed pixels. On cirrus-only pixels, though,
      // motionWeight~0 would reproject the camera position itself; a far
      // point is rotation-exact there and keeps meta.z stable at 1.0.
      #ifdef CLOUD_CIRRUS
        if(motionWeight<1e-4&&cirrusAlpha>0.004)cloudDistance=MAX_DIST;
      #endif
      vec3 world=eye+dir*cloudDistance;
      vec3 previousWorld=world;previousWorld.xz+=uTaaDeltaTime*(WIND_SPEED/NOISE_SCALE)*WIND_DIR;
      vec4 currentClip=uCurrentViewProjection*vec4(world,1),previousClip=uPreviousViewProjection*vec4(previousWorld,1);
      vec2 currentUv=currentClip.xy/max(currentClip.w,1e-6)*0.5+0.5;
      vec3 previousNdc=previousClip.xyz/max(previousClip.w,1e-6);vec2 velocity=currentUv-(previousNdc.xy*0.5+0.5);
      float previousDepth=previousNdc.z*0.5+0.5;
      if(alpha<0.004){velocity=vec2(0.0);previousDepth=1.0;}
      if(uMaskMode>0.5){gl_FragColor=vec4(0,0,0,alpha);
        #ifdef TAA_ENABLED
          taaMotion=vec4(velocity,previousNdc.z*0.5+0.5,alpha);
        #elif defined(CLOUD_TEMPORAL)
          cloudMeta=vec4(velocity,cloudDistance/MAX_DIST,alpha);
        #endif
        #ifdef CLOUD_TEMPORAL
          cloudSignature=vec4(densitySum/max(motionWeight,1e-5),1.0,alpha,previousDepth);
        #endif
        return;
      }
      if(fieldDebug){
        vec3 ramp=uDebugMode==3.0?mix(vec3(0.08,0.2,0.75),vec3(1.0,0.35,0.08),debugValue):vec3(debugValue);
        gl_FragColor=vec4(ramp,1.0);
      }else{
        vec3 straight=scattered/max(opacity,1e-5);
        #ifdef CLOUD_PREMULTIPLIED
          gl_FragColor=vec4(straight*alpha,alpha);
        #else
          gl_FragColor=vec4(straight,alpha);
        #endif
      }
      #ifdef CLOUD_TEMPORAL
        // Cloud-space history compares opacity and density itself. Keep
        // opacity out of instantaneous reactivity so opaque clouds can
        // accumulate. The small floor covers unresolved detail evolution.
        float instantaneousReactive=alpha>=0.004?0.04:0.0;
        #ifdef TAA_ENABLED
          taaMotion=vec4(velocity,cloudDistance/MAX_DIST,instantaneousReactive);
        #else
          cloudMeta=vec4(velocity,cloudDistance/MAX_DIST,instantaneousReactive);
        #endif
        cloudSignature=vec4(densitySum/max(motionWeight,1e-5),1.0,alpha,previousDepth);
      #elif defined(TAA_ENABLED)
        taaMotion=vec4(velocity,previousNdc.z*0.5+0.5,alpha);
      #endif
    }