// Dumps the composed GLSL of every material the demo builds, so a shader
// refactor can be proven byte-identical instead of merely looking right.
//
// Shader source is assembled by string interpolation across several modules;
// moving a chunk into a .glsl file must not change a single character of the
// result. This walks everything reachable from window.__demo and returns
// {name: source} plus a hash per entry.
//
// Run: playwright-cli eval "() => import('/scripts/dump-shaders.js').then(m => m.default())"
function hash(s) {
  // FNV-1a, 32-bit, hex. Enough to spot any change.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// GLSL comments and blank lines carry no meaning to the compiler. Stripping
// them lets a refactor move documentation between a .ts and a .glsl file while
// still proving that not one character of actual shader code changed.
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

function collect(out, name, material) {
  if (!material) return;
  const list = Array.isArray(material) ? material : [material];
  list.forEach((m, i) => {
    if (!m || (!m.vertexShader && !m.fragmentShader)) return;
    const key = list.length > 1 ? `${name}[${i}]` : name;
    out[`${key}.vert`] = m.vertexShader ?? "";
    out[`${key}.frag`] = m.fragmentShader ?? "";
    // defines feed #ifdef, so a changed define changes the compiled program
    // just as surely as changed source.
    out[`${key}.defines`] = JSON.stringify(m.defines ?? {}, Object.keys(m.defines ?? {}).sort());
  });
}

export default async function dumpShaders() {
  // The scene builds asynchronously behind the loading screen.
  const d = await (window.__demoReady ?? window.__demo);
  if (!d) return { error: "no __demo" };
  const out = {};

  // Index the key: several meshes share the name "Mesh", and a colliding key
  // would silently drop a shader from the comparison.
  let n = 0;
  d.scene.traverse((o) => {
    if (o.material) collect(out, `scene${n++}:${o.name || o.type}`, o.material);
  });

  if (d.clouds) {
    collect(out, "clouds:dome", d.clouds.mesh.material);
    collect(out, "clouds:occupancy", d.clouds.pass?.occupancy?.material);
    collect(out, "clouds:refine", d.clouds.pass?.refine?.material);
    collect(out, "clouds:refineResolve", d.clouds.pass?.refine?.resolveMaterial);
    const raw = d.clouds.pass?.rawTarget;
    if (raw) out["clouds:pass.rawTargetCount"] = String(raw.textures?.length ?? 1);
  }
  if (d.ocean) {
    collect(out, "ocean:surface", d.ocean.mesh.material);
    // GPUComputationRenderer variables hold the FFT chain shaders.
    for (const key of ["fft", "fft2"]) {
      const fft = d.ocean[key];
      const vars = fft?.variables ?? fft?.gpu?.variables;
      if (!Array.isArray(vars)) continue;
      for (const v of vars) {
        out[`${key}:${v.name}.frag`] = v.material?.fragmentShader ?? "";
        out[`${key}:${v.name}.defines`] = JSON.stringify(v.material?.defines ?? {});
      }
    }
  }

  const hashes = {};
  for (const k of Object.keys(out).sort()) {
    const c = k.endsWith(".defines") ? out[k] : code(out[k]);
    hashes[k] = `${hash(c)}:${c.length}`;
  }
  return { hashes, count: Object.keys(hashes).length };
}
