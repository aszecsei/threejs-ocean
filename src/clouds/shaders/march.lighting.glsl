// Cloud march lighting helpers: lightOpticalDepth, desat, hgPhase,
// coarseAmbient, then the cirrus layer that depends on them. skyColor() and
// the density field are injected ahead of this file; march.core.glsl follows.

    // Returns the optical depth of steps 1..N; step 0 (the first LIGHT_STEP0
    // units) comes back separately in od0 so the caller can re-price it at
    // fine LOD. Summing the two reproduces the plain march exactly.
    float lightOpticalDepth(vec3 p,int maxSteps,out float od0){
      vec3 sd=normalize(uSunDirection);float od=0.0,t=0.0,stepLen=LIGHT_STEP0;od0=0.0;
      for(int i=0;i<LIGHT_STEPS;i++){if(i>=maxSteps)break;vec3 sp=p+sd*(t+stepLen*0.5);if(sp.y>CB_TOP)break;
        float seg=coarseCloudDensity(sp)*stepLen;if(i==0)od0=seg;else od+=seg;
        if((od+od0)*EXTINCTION>6.0)break;t+=stepLen;stepLen*=LIGHT_GROWTH;}
      od0*=EXTINCTION;
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
