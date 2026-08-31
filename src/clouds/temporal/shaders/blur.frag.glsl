// Separable widening blur over the resolved cloud buffer (?cloud-blur).

      varying vec2 vUv;
      uniform sampler2D tSource;
      uniform vec2 uInvResolution;
      uniform float uOffset;
      layout(location=0) out vec4 outColor;
      void main(){
        vec4 center=texture(tSource,vUv);
        float lumaC=dot(center.rgb,vec3(0.299,0.587,0.114));
        vec2 o=uOffset*uInvResolution;
        vec4 sum=center;float wsum=1.0;
        vec2 taps[4]=vec2[4](vec2(o.x,o.y),vec2(-o.x,o.y),vec2(o.x,-o.y),vec2(-o.x,-o.y));
        for(int i=0;i<4;i++){
          vec4 s=texture(tSource,vUv+taps[i]);
          // Alpha similarity alone blurs cloud interiors at full strength
          // (alpha saturates to 1 there), flattening billow shading. The
          // relative-luminance term preserves interior shading gradients
          // while low-amplitude stochastic stipple still averages out.
          float lumaS=dot(s.rgb,vec3(0.299,0.587,0.114));
          float w=exp(-abs(s.a-center.a)*6.0-abs(lumaS-lumaC)*2.5/(lumaC+0.2));
          sum+=s*w;wsum+=w;
        }
        outColor=sum/wsum;
      }
    