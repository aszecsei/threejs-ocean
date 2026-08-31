// Sky dome vertex stage: world-space view ray per fragment.

        varying vec3 vDir;
        #ifdef TAA_ENABLED
        uniform mat4 uPreviousViewProjection;
        uniform vec3 uPreviousCameraPosition;
        varying vec4 vTaaCurrentClip;
        varying vec4 vTaaPreviousClip;
        #endif
        void main() {
          // Sphere is never rotated, so local position == world direction.
          vDir = position;
          gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
          #ifdef TAA_ENABLED
          vTaaCurrentClip = gl_Position;
          // The sky is infinitely distant. Recenter the same local direction
          // on the previous camera so translation contributes no velocity.
          vec3 previousWorld = uPreviousCameraPosition + position;
          vTaaPreviousClip = uPreviousViewProjection * vec4(previousWorld, 1.0);
          #endif
        }
      