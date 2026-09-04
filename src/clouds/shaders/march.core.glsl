// Cloud march core, shared by the half-res dome pass and the full-res edge
// refinement pass: slab intersection, the occupancy narrowing hook, and the
// loop itself. Requires march.lighting.glsl ahead of it.

    struct MarchResult{vec3 scattered;float transmittance,distanceSum,motionWeight,densitySum,debugValue,debugWeight;};
    // Slab entry/exit along the ray, capped to MAX_DIST. False when the ray
    // never enters the slab (nothing to march, but cirrus may still apply).
    bool cloudSlab(vec3 eye,vec3 dir,out float t0,out float t1){
      t0=0.0;t1=-1.0;
      if(abs(dir.y)>1e-4){float ta=(CLOUD_BOTTOM-eye.y)/dir.y;float tb=(CB_TOP-eye.y)/dir.y;t0=max(min(ta,tb),0.0);t1=max(ta,tb);}
      else if(eye.y>CLOUD_BOTTOM&&eye.y<CB_TOP)t1=MAX_DIST;
      if(t1<=t0)return false;
      t1=min(t1,t0+MAX_DIST);
      return true;
    }
    // Occupied span for this ray's tile as (entry, exit, maxDensity)/MAX_DIST,
    // gathered over 3x3 tiles: a ray footprint near a tile border can
    // straddle it, and half- and full-res rays must agree on what they skip.
    // entry >= exit means empty.
    vec3 occupancyFetch(vec2 uv){
      #ifdef CLOUD_OCCUPANCY
        ivec2 tile=ivec2(uv*uOccupancySize),hi=ivec2(uOccupancySize)-1;
        float entry=1.0,exit=0.0,maxD=0.0;
        for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){
          vec4 o=texelFetch(tCloudOccupancy,clamp(tile+ivec2(x,y),ivec2(0),hi),0);
          entry=min(entry,o.r);exit=max(exit,o.g);maxD=max(maxD,o.b);
        }
        return vec3(entry,exit,maxD);
      #else
        return vec3(0.0,1.0,1.0);
      #endif
    }
    // Narrows [t0,t1] to the occupied span; collapses it to nothing on an
    // empty tile. A no-op until CLOUD_OCCUPANCY is compiled in.
    void occupancyNarrow(vec2 uv,inout float t0,inout float t1){
      #ifdef CLOUD_OCCUPANCY
        vec3 o=occupancyFetch(uv);
        if(o.y<=o.x){t1=t0;return;}
        t0=max(t0,o.x*MAX_DIST);t1=min(t1,o.y*MAX_DIST);
      #endif
    }
    // Step size for a narrowed [t0,t1] (OCCUPANCY_SPAN_STEPS): the iterations
    // the prepass freed buy finer sampling on exactly the rays with cloud in
    // them. Never coarser than slabStep, never finer than the span's own
    // PRIMARY_STEPS stride or OCCUPANCY_MIN_STEP (a short span must not turn
    // into 160 sub-unit strides; below the floor the loop still breaks on
    // t>t1). The span is constant per 8x8 tile, so the step is quantised to
    // slabStep/2^k: neighbouring tiles then share a step or differ by exactly
    // 2x, and since the jitter is scaled by fineStep their sample sets nest
    // (mip-level reasoning) instead of the tile grid showing as a change in
    // noise character. The ratio is capped at 2^OCCUPANCY_MAX_RATIO_LOG2;
    // beyond 4x the resolve's 3x3 clamp cannot hide the difference. Returns
    // slabStep when compiled out, so callers need no #ifdef.
    float occupancySpanStep(float slabStep,float t0,float t1){
      #if defined(CLOUD_OCCUPANCY) && defined(OCCUPANCY_SPAN_STEPS)
        if(t1<=t0)return slabStep;
        float spanStep=max((t1-t0)/float(PRIMARY_STEPS),OCCUPANCY_MIN_STEP);
        float k=clamp(floor(log2(slabStep/spanStep)),0.0,OCCUPANCY_MAX_RATIO_LOG2);
        return slabStep*exp2(-k);
      #else
        return slabStep;
      #endif
    }
    // baseStep comes from the caller. The dome sizes it on the un-narrowed
    // slab, so the narrowing only shortens its loop and never changes its
    // sampling rate (?cloud-occupancy=0 is then a pixel-exact A/B for prepass
    // misses); the refinement pass sizes it on the span via
    // occupancySpanStep. stepRatio is slabStep/baseStep (1 when unscaled):
    // it stretches the light-march reuse cadence so that finer primary steps
    // do not multiply the light marches along with them.
    MarchResult marchClouds(vec3 eye,vec3 dir,float t0,float t1,float baseStep,float stepRatio,float jitter,float mu,float airMass,vec3 skyBehind){
      vec3 sd=normalize(uSunDirection);
      if(t1<=t0)return MarchResult(vec3(0.0),1.0,0.0,0.0,0.0,0.0,0.0);
      // Coarse stride capped at 1.4x: at 2x a far coarse step could leap
      // clean over a whole 100-300 unit clump, making it flicker with the
      // per-frame jitter phase in a way no history accumulation can fix.
      float fineStep=baseStep*0.5,coarseStep=baseStep*1.4;
      float tStart=t0+jitter*fineStep,t=tStart;bool fine=false;int emptyRun=0;
      vec3 scattered=vec3(0);float transmittance=1.0,distanceSum=0.0,motionWeight=0.0,densitySum=0.0;
      float debugValue=0.0,debugWeight=0.0,cachedOd=0.0,cachedOd0=0.0,cachedCoarse=0.0;vec3 cachedAmbient=vec3(0),cachedBounce=vec3(0);int odAge=99,ambientAge=99;
      // Light-march and coarse-ambient reuse cadence in samples: 2 at the
      // slab step, scaled with the step ratio so the light marches (and
      // coarse fetches) per world unit stay constant when the step shrinks.
      int odCadence=int(clamp(2.0*stepRatio,2.0,8.0));
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
        float stepLen=fineStep*stepScale;float detailFade=1.0-smoothstep(DETAIL_FADE_START,DETAIL_FADE_END,t);float wispFade=1.0-smoothstep(WISP_FADE_START,WISP_FADE_END,t);CloudSample cloudPoint=sampleCloudDensityLod(p,5,true,detailFade,wispFade);float d=cloudPoint.density;
        if(d<=0.004){emptyRun++;if(emptyRun>=4)fine=false;t+=stepLen;continue;}emptyRun=0;
        float sampleExt=d*EXTINCTION*stepLen;float contribution=transmittance*(1.0-exp(-sampleExt));
        distanceSum+=contribution*t;motionWeight+=contribution;densitySum+=contribution*d;
        if(uMaskMode>0.5){transmittance*=exp(-sampleExt);t+=stepLen;continue;}
        #ifdef LIGHT_REUSE
          if(odAge>=odCadence){cachedOd=lightOpticalDepth(p,transmittance<0.3?LIGHT_STEPS/2:LIGHT_STEPS,cachedOd0);odAge=0;}odAge++;float od=cachedOd,od0=cachedOd0;
        #else
          float od0;float od=lightOpticalDepth(p,LIGHT_STEPS,od0);
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
        float nbr=sampleCloudDensityLod(p+sd*(NEAR_SHADOW_STEP*0.6),5,true,detailFade,wispFade).density;
        #ifdef CLOUD_RIM
          // The first LIGHT_STEP0 units toward the sun are re-priced at fine
          // LOD from the near-shadow sample, which sits at the same point.
          // Coarse density there overstates the depth of a thin eroded edge
          // by up to a few od, which is exactly what buries the silver lining.
          od+=mix(od0,nbr*LIGHT_STEP0*EXTINCTION,detailFade);
        #else
          od+=od0;
        #endif
        od+=clamp(nbr-d*0.6,0.0,0.9)*NEAR_SHADOW_STEP*EXTINCTION*0.6*(0.35+0.65*detailFade);
        float sun=0.0,ext=1.0,att=1.0;for(int j=0;j<3;j++){sun+=att*hgPhase(mu,0.55*pow(0.5,float(j)))*exp(-od*ext);ext*=0.55;att*=0.55;}
        sun+=0.08*hgPhase(mu,0.85)*exp(-od*0.5);
        // Nubis-style long-reach term: a weak, broad lobe with a quarter-rate
        // Beer exponent keeps thick interiors glowing instead of flat-ambient.
        sun+=0.15*hgPhase(mu,0.30)*exp(-od*0.22);float powder=1.0-exp(-od*2.0);sun*=mix(1.0,powder,0.6*(0.5-0.5*mu));
        #ifdef CLOUD_RIM
          // Silver lining: a tight forward lobe that only the thin shell of
          // an edge (wispness) with a short sun path gets. hg(1,0.9) is 15.1,
          // so the clamp is load-bearing near mu=1; the near edge of a mass
          // in front of a lit far mass is what this separates into layers.
          float rim=RIM_STRENGTH*hgPhase(mu,RIM_G)*exp(-od*RIM_OD)*cloudPoint.wispness;
          sun+=min(rim,RIM_CLAMP);
        #endif
        #ifdef CLOUD_AMBIENT_COARSE
          if(ambientAge>=odCadence){cachedAmbient=coarseAmbient(p,cloudPoint,cachedCoarse,cachedBounce);ambientAge=0;}ambientAge++;vec3 ambient=cachedAmbient;
        #else
          float hf=cloudPoint.height;vec3 ambient=desat(mix(uHorizonColor,uZenithColor,hf),0.35)*0.9+vec3(0.12)+vec3(0.30)*hf+vec3(0.42,0.50,0.62)*(1.0-hf);cachedCoarse=d;
        #endif
        float shade=exp(-od*SHADE_FALLOFF);vec3 shadowTint=shadowTintBase*mix(1.0,0.86,cloudPoint.tower);ambient=mix(shadowTint,ambient,shade);
        // Bounce added outside the shade mix so it survives on shadowed
        // bases; the soft od term varies it with the same optical depth
        // (including the near-shadow differential) that shades the sun term,
        // which is what puts texture back into the undersides.
        ambient+=cachedBounce*mix(0.22,1.0,exp(-od*0.30));
        vec3 luminance=ambient+uSunColor*sun*2.4;float haze=1.0-exp(-t*airMass/HAZE_DIST);luminance=mix(luminance,skyBehind,haze);
        scattered+=contribution*luminance;transmittance*=exp(-sampleExt);t+=stepLen;
        debugWeight+=contribution; if(uDebugMode==6.0)debugValue=max(debugValue,cachedCoarse); if(uDebugMode==10.0)debugValue=max(debugValue,dot(ambient,LUMA));
      }
      return MarchResult(scattered,transmittance,distanceSum,motionWeight,densitySum,debugValue,debugWeight);
    }
