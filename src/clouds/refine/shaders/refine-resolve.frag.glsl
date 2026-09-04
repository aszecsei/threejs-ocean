// Temporal accumulation for the full-res refinement image. A trimmed copy of
// the cloud resolve rather than a define-variant of it: that shader carries
// three outputs, the interleaved reconstruction and the signature logic, and
// keeping it untouched keeps its composed source byte-identical.
//
// Velocity comes from the half-res resolved meta, bilinearly upsampled. On
// unrefined pixels the current image is the already-stable half-res image,
// so the 3x3 clamp is tight there and the blend adds no lag; edge pixels are
// what accumulate.
      varying vec2 vUv;
      uniform sampler2D tCurrent,tHistory,tHalfMeta;
      uniform vec2 uInvResolution;
      uniform float uHistoryValid;
      layout(location=0) out vec4 outColor;
      void main(){
        vec4 current=texture(tCurrent,vUv);
        vec2 velocity=texture(tHalfMeta,vUv).xy;
        vec2 previousUv=vUv-velocity;
        bool inBounds=all(greaterThanEqual(previousUv,vec2(0.0)))&&all(lessThanEqual(previousUv,vec2(1.0)));
        vec4 lo=current,hi=current;
        for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){
          vec4 n=texture(tCurrent,vUv+vec2(float(x),float(y))*uInvResolution);
          lo=min(lo,n);hi=max(hi,n);
        }
        vec4 extent=(hi-lo)*0.30+vec4(0.008);
        vec4 history=clamp(texture(tHistory,previousUv),lo-extent,hi+extent);
        float motionPixels=length(velocity/uInvResolution);
        float historyWeight=REFINE_HISTORY*uHistoryValid*float(inBounds)*exp(-motionPixels*0.02);
        outColor=mix(current,history,historyWeight);
      }
