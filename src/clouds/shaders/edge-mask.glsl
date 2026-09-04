// Where the half-res cloud image is an edge worth re-marching at full res.
//
// Shared by the refinement march (to decide what to march) and available to
// any consumer that needs the same answer. Reads the *unblurred* resolved
// half-res buffer: the display blur widens every edge, which would grow the
// refined region without adding anything to refine.
//
// Two detectors: the 3x3 alpha range catches silhouettes, the translucent
// band catches wide thin veils whose range is small but whose detail is all
// sub-half-res. Requires EDGE_RANGE_LO, EDGE_RANGE_HI, EDGE_THIN_WEIGHT.
float cloudEdgeWeight(sampler2D tHalf,vec2 uv,vec2 invHalf){
  float lo=1.0,hi=0.0;
  for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){
    float a=texture(tHalf,uv+vec2(float(x),float(y))*invHalf).a;
    lo=min(lo,a);hi=max(hi,a);
  }
  float mean=0.5*(lo+hi);
  float thin=smoothstep(0.02,0.12,mean)*(1.0-smoothstep(0.55,0.85,mean));
  return max(smoothstep(EDGE_RANGE_LO,EDGE_RANGE_HI,hi-lo),thin*EDGE_THIN_WEIGHT);
}
