import { defineConfig } from "vite";
import glsl from "vite-plugin-glsl";

export default defineConfig({
  // Port 3000 is pinned because the playwright-cli screenshot workflow targets
  // http://localhost:3000; strictPort keeps a stray dev server from silently
  // shifting the port and screenshotting nothing.
  server: { port: 3000, strictPort: true },
  // The old importmap mapped "three/addons/" to the CDN's examples/jsm/ path.
  // The npm package does not export that alias, so recreate it here.
  resolve: {
    alias: [{ find: /^three\/addons\//, replacement: "three/examples/jsm/" }],
  },
  plugins: [
    glsl({
      // Shader chunks are shared via #include; a duplicate include means a
      // GLSL redefinition error, so surface it at build time instead.
      warnDuplicatedImports: true,
      removeDuplicatedImports: true,
      // Keep comments and whitespace: the shaders are heavily annotated and
      // three.js reads #define/#ifdef out of them.
      minify: false,
    }),
  ],
});
