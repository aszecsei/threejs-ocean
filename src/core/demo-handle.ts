// The `window.__demo` debug handle.
//
// This is a contract with external tooling, not an internal detail:
// scripts/capture-frame.js and scripts/probe-shader-patches.js drive the demo
// through it, and playwright-cli evals reach for it by name. Renaming or
// removing a member here breaks screenshot capture silently.

import type * as THREE from "three";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { PostPipeline } from "../render/post.js";
import type { TaaApi } from "../taa/index.js";
import type { CloudRig } from "../clouds/index.js";
import type { OceanRig, SceneCapture } from "../ocean/index.js";
import type { GodRays } from "../render/godrays.js";
import type { LoadingOverlay } from "../loading/overlay.js";

export interface DemoHandle {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  renderer: THREE.WebGLRenderer;
  post: PostPipeline;
  taa: TaaApi;

  /** Live getters: these are created after the handle is published. */
  readonly clouds: CloudRig | null;
  readonly ocean: OceanRig | null;
  readonly capture: SceneCapture | null;
  readonly godRays: GodRays | null;

  /** Assigned once the dispose closure exists. */
  dispose?: () => void;

  /**
   * The loading screen. Already gone by the time `__demoReady` resolves,
   * unless `?loading-hold=1` is set -- then `loading.finish()` releases it.
   */
  loading: LoadingOverlay;

  // --- Deterministic capture ---------------------------------------------
  /** Stops the real-time animation loop. */
  pause(): void;
  /** Restarts the real-time animation loop. */
  resume(): void;
  /** Renders `count` frames of exactly `dt` seconds starting from t = 0. */
  stepFrames(count?: number, dt?: number): void;
  /** Drops accumulated temporal history so stepping starts from a known state. */
  resetTemporal(): void;
}

declare global {
  interface Window {
    /**
     * Only exists once the scene has finished building. Construction is
     * asynchronous (it runs behind the loading screen), so tooling must go
     * through `__demoReady` rather than reading this at page load.
     */
    __demo: DemoHandle;
    /**
     * Published at module-evaluation time. Resolves after the scene is built,
     * warmed up, and the loading overlay has left the DOM -- so a screenshot
     * taken off this promise contains only the render.
     */
    __demoReady: Promise<DemoHandle>;
  }
}
