// Occupancy prepass: one conservative coarse march per 8x8-pixel tile,
// recording where along the ray the slab is actually occupied. The dome
// passes narrow their march to [entry, exit] and skip empty tiles outright.
//
// Fixed centred strata, no jitter and no history: the result must be a
// stable bound, not an estimate, or clouds pop at tile borders.
    varying vec3 vDir;
    layout(location=0) out highp vec4 occupancy;
    void main(){
      vec3 dir=normalize(vDir),eye=cameraPosition;
      float t0=0.0,t1=-1.0;
      if(abs(dir.y)>1e-4){float ta=(CLOUD_BOTTOM-eye.y)/dir.y;float tb=(CB_TOP-eye.y)/dir.y;t0=max(min(ta,tb),0.0);t1=max(ta,tb);}
      else if(eye.y>CLOUD_BOTTOM&&eye.y<CB_TOP)t1=MAX_DIST;
      t1=min(t1,t0+MAX_DIST);
      // entry > exit encodes "empty"; the dome's horizon fade discards
      // rays this flat anyway.
      if(t1<=t0||abs(dir.y)<0.004){occupancy=vec4(1.0,0.0,0.0,1.0);return;}
      float stepLen=(t1-t0)/float(OCCUPANCY_STEPS),tEntry=MAX_DIST,tExit=0.0,maxD=0.0;
      for(int i=0;i<OCCUPANCY_STEPS;i++){
        float t=t0+(float(i)+0.5)*stepLen;
        float d=sampleCloudDensity(eye+dir*t,2,false).density;
        // One stratum of slack each way: the stratum centre saw density, the
        // clump can extend up to a full stratum beyond it.
        if(d>0.0){tEntry=min(tEntry,t-stepLen);tExit=max(tExit,t+stepLen);maxD=max(maxD,d);}
      }
      occupancy=vec4(clamp(tEntry,0.0,MAX_DIST)/MAX_DIST,min(tExit,MAX_DIST)/MAX_DIST,maxD,1.0);
    }
