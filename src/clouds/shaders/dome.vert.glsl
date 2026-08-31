// Cloud dome vertex stage: world-space direction per fragment.
varying vec3 vDir;void main(){vDir=position;gl_Position=projectionMatrix*viewMatrix*modelMatrix*vec4(position,1.0);}