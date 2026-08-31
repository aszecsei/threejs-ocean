// Cloud dome raymarch: lighting helpers (hgPhase, desat, coarseAmbient) then
// the march itself. skyColor() and the density field are injected ahead of
// this file; cirrus.glsl is included after the helpers it depends on.

    float lightOpticalDepth(vec3 p,int maxSteps){
      vec3 sd=normalize(uSunDirection);float od=0.0,t=0.0,stepLen=LIGHT_STEP0;
      for(int i=0;i<LIGHT_STEPS;i++){if(i>=maxSteps)break;vec3 sp=p+sd*(t+stepLen*0.5);if(sp.y>CB_TOP)break;
        od+=coarseCloudDensity(sp)*stepLen;if(od*EXTINCTION>6.0)break;t+=stepLen;stepLen*=LIGHT_GROWTH;}
      return od*EXTINCTION;
    }
    vec3 desat(vec3 c,float k){return mix(vec3(dot(c,LUMA)),c,k);}
    float hgPhase(float mu,float g){float g2=g*g;return(1.0-g2)/(12.5663706*pow(1.0+g2-2.0*g*mu,1.5));}
    vec3 coarseAmbient(vec3 p,CloudSample cloudPoint,out float localDensity,out vec3 bounce){
      float stepLen=120.0;
      float up=coarseCloudDensity(p+vec3(0,stepLen,0));
      float down=coarseCloudDensity(p-vec3(0,stepLen,0));
      float sideA=coarseCloudDensity(p+vec3(stepLen,0,0));
      float sideB=coarseCloudDensity(p+vec3(0,0,stepLen));
      localDensity=(up+down+sideA+sideB)*0.25;
      float heightExponent=mix(0.5,2.0,clamp((cloudPoint.height-0.30)/0.55,0.0,1.0));
      float pDepth=0.05+pow(clamp(localDensity,0.0,1.0),heightExponent);
      float pVertical=pow(clamp(cloudRemap(cloudPoint.height,0.07,0.14,0.10,1.0),0.0,1.0),0.8);
      float inscatter=clamp(pDepth*pVertical,0.0,1.0);
      float trUp=exp(-up*stepLen*EXTINCTION*0.55);
      float trDown=exp(-down*stepLen*EXTINCTION*0.55);
      vec3 sky=desat(mix(uHorizonColor,uZenithColor,cloudPoint.height),0.35)*trUp;
      vec3 ground=desat(uGroundColor,0.28)*trDown*0.58;
      // Faked sun-off-ground bounce for the undersides. Returned separately
      // so the caller can add it AFTER the direct-shadow collapse: bases sit
      // at large sun optical depth, and inside the shade mix this term would
      // be flattened to the same shadow tint as everything else. Downward
      // openness (trDown) keeps it local: tufts over open air glow, crevices
      // above other cloud stay dark.
      float sunUp=clamp(normalize(uSunDirection).y*1.8,0.0,1.0);
      bounce=desat(mix(uGroundColor,uSunColor,0.40),0.35)
        *(0.82*trDown*pow(clamp(1.0-cloudPoint.height,0.0,1.0),1.5)*sunUp);
      return (sky+ground+desat(mix(uZenithColor,uHorizonColor,0.72),0.25)*inscatter*0.42)*0.82+vec3(0.05);
    }
#include "cirrus.glsl";

    void main(){
      #ifdef CLOUD_INTERLEAVED
        ivec2 pixel=ivec2(gl_FragCoord.xy);
        int phase=(pixel.x&1)+2*(pixel.y&1);
        if(phase!=int(uUpdatePhase))discard;
      #endif
      vec3 dir=normalize(vDir),eye=cameraPosition,sd=normalize(uSunDirection);
      float t0=0.0,t1=-1.0;
      if(abs(dir.y)>1e-4){float ta=(CLOUD_BOTTOM-eye.y)/dir.y;float tb=(CB_TOP-eye.y)/dir.y;t0=max(min(ta,tb),0.0);t1=max(ta,tb);}
      else if(eye.y>CLOUD_BOTTOM&&eye.y<CB_TOP)t1=MAX_DIST;
      if(t1<=t0){
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
      t1=min(t1,t0+MAX_DIST);
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
      // Coarse stride capped at 1.4x: at 2x a far coarse step could leap
      // clean over a whole 100-300 unit clump, making it flicker with the
      // per-frame jitter phase in a way no history accumulation can fix.
      float baseStep=(t1-t0)/float(PRIMARY_STEPS),fineStep=baseStep*0.5,coarseStep=baseStep*1.4;
      float tStart=t0+jitter*fineStep,t=tStart;bool fine=false;int emptyRun=0;
      vec3 scattered=vec3(0);float transmittance=1.0,distanceSum=0.0,motionWeight=0.0,densitySum=0.0;
      float debugValue=0.0,debugWeight=0.0,cachedOd=0.0,cachedCoarse=0.0;vec3 cachedAmbient=vec3(0),cachedBounce=vec3(0);int odAge=99,ambientAge=99;
      vec3 shadowTintBase=desat(mix(uZenithColor,uHorizonColor,0.62),0.30)*0.42;
      for(int i=0;i<PRIMARY_STEPS;i++){
        if(t>t1||transmittance<0.02)break;vec3 p=eye+dir*t;float stepScale=1.0+t*FAR_STEP_GROWTH;
        if(!fine){
          CloudSample probe=sampleCloudDensity(p,2,uDebugMode==5.0);
          if(uDebugMode==1.0)debugValue=max(debugValue,probe.profile);
          else if(uDebugMode==2.0)debugValue=max(debugValue,probe.coverage);
          else if(uDebugMode==3.0)debugValue=max(debugValue,probe.type);
          else if(uDebugMode==4.0)debugValue=max(debugValue,probe.baseNoise);
          else if(uDebugMode==5.0)debugValue=max(debugValue,probe.detailNoise);
          else if(uDebugMode==6.0)debugValue=max(debugValue,probe.density);
          if(probe.density<=0.004){t+=coarseStep*stepScale;continue;}
          t=max(t-(coarseStep-fineStep)*stepScale,tStart);fine=true;emptyRun=0;odAge=ambientAge=99;continue;
        }
        float stepLen=fineStep*stepScale;float detailFade=1.0-smoothstep(DETAIL_FADE_START,DETAIL_FADE_END,t);CloudSample cloudPoint=sampleCloudDensityLod(p,5,true,detailFade);float d=cloudPoint.density;
        if(d<=0.004){emptyRun++;if(emptyRun>=4)fine=false;t+=stepLen;continue;}emptyRun=0;
        float sampleExt=d*EXTINCTION*stepLen;float contribution=transmittance*(1.0-exp(-sampleExt));
        distanceSum+=contribution*t;motionWeight+=contribution;densitySum+=contribution*d;
        if(uMaskMode>0.5){transmittance*=exp(-sampleExt);t+=stepLen;continue;}
        #ifdef LIGHT_REUSE
          if(odAge>=2){cachedOd=lightOpticalDepth(p,transmittance<0.3?LIGHT_STEPS/2:LIGHT_STEPS);odAge=0;}odAge++;float od=cachedOd;
        #else
          float od=lightOpticalDepth(p,LIGHT_STEPS);
        #endif
        // Short-range self-shadow at full detail frequency, never cached:
        // the coarse light march cannot see billow-scale density, so without
        // this every clump shades identically and the surface reads flat.
        // Differential form — only density in excess of the local sample
        // (a crevice behind an overhang) casts near shadow; an exposed
        // sun-facing billow stays bright even deep inside a dense mass.
        // Kept gentle and distance-faded: at full strength this term flips
        // pixels between lit and shadowed at detail frequency, which reads
        // as salt-and-pepper stipple on sunlit faces.
        float nbr=sampleCloudDensityLod(p+sd*(NEAR_SHADOW_STEP*0.6),5,true,detailFade).density;
        od+=clamp(nbr-d*0.6,0.0,0.9)*NEAR_SHADOW_STEP*EXTINCTION*0.6*(0.35+0.65*detailFade);
        float sun=0.0,ext=1.0,att=1.0;for(int j=0;j<3;j++){sun+=att*hgPhase(mu,0.55*pow(0.5,float(j)))*exp(-od*ext);ext*=0.55;att*=0.55;}
        sun+=0.08*hgPhase(mu,0.85)*exp(-od*0.5);
        // Nubis-style long-reach term: a weak, broad lobe with a quarter-rate
        // Beer exponent keeps thick interiors glowing instead of flat-ambient.
        sun+=0.15*hgPhase(mu,0.30)*exp(-od*0.22);float powder=1.0-exp(-od*2.0);sun*=mix(1.0,powder,0.6*(0.5-0.5*mu));
        #ifdef CLOUD_AMBIENT_COARSE
          if(ambientAge>=2){cachedAmbient=coarseAmbient(p,cloudPoint,cachedCoarse,cachedBounce);ambientAge=0;}ambientAge++;vec3 ambient=cachedAmbient;
        #else
          float hf=cloudPoint.height;vec3 ambient=desat(mix(uHorizonColor,uZenithColor,hf),0.35)*0.9+vec3(0.12)+vec3(0.30)*hf+vec3(0.42,0.50,0.62)*(1.0-hf);cachedCoarse=d;
        #endif
        float shade=exp(-od*0.9);vec3 shadowTint=shadowTintBase*mix(1.0,0.86,cloudPoint.tower);ambient=mix(shadowTint,ambient,shade);
        // Bounce added outside the shade mix so it survives on shadowed
        // bases; the soft od term varies it with the same optical depth
        // (including the near-shadow differential) that shades the sun term,
        // which is what puts texture back into the undersides.
        ambient+=cachedBounce*mix(0.22,1.0,exp(-od*0.30));
        vec3 luminance=ambient+uSunColor*sun*2.4;float haze=1.0-exp(-t*airMass/HAZE_DIST);luminance=mix(luminance,skyBehind,haze);
        scattered+=contribution*luminance;transmittance*=exp(-sampleExt);t+=stepLen;
        debugWeight+=contribution; if(uDebugMode==6.0)debugValue=max(debugValue,cachedCoarse); if(uDebugMode==10.0)debugValue=max(debugValue,dot(ambient,LUMA));
      }
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
      bool fieldDebug=uDebugMode>=1.0&&uDebugMode<=6.0||uDebugMode==10.0||uDebugMode>=12.0;
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
  