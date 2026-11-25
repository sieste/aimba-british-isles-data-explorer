// Prototype: read the British Isles NetCDF-4 files in the browser with h5wasm (HDF5 compiled to
// WebAssembly). The files stay on the user's disk: WORKERFS reads only the byte ranges HDF5 asks
// for, so a 1.9 GB file is never loaded as a whole.
self.importScripts("https://cdn.jsdelivr.net/npm/h5wasm@0.10.3/dist/iife/h5wasm.js");

let FS = null, files = {};          // model -> h5wasm.File

// attribute values come back as one-element typed arrays: take the number (or string)
const attr = (ds, name) => {
  if (!(name in ds.attrs)) return undefined;
  const v = ds.attrs[name].value;
  return ArrayBuffer.isView(v) ? Number(v[0]) : v;
};
const num = a => Array.from(a, Number);           // also turns BigInt64Array into numbers

async function mount(fileList) {
  if (!FS) ({FS} = await h5wasm.ready);
  for (const f of Object.values(files)) f.close();
  files = {};
  try { FS.unmount("/work"); } catch (e) {}
  try { FS.mkdir("/work"); } catch (e) {}
  FS.mount(FS.filesystems.WORKERFS, {files: fileList}, "/work");
  const out = [];
  for (const f of fileList) {
    const m = f.name.match(/^(.+)_wave(\d+)_british_isles\.nc$/);
    if (!m) continue;
    const t0 = performance.now();
    const h = new h5wasm.File(`/work/${f.name}`, "r");
    files[`${m[1]} w${m[2]}`] = h;
    out.push({model: `${m[1]} w${m[2]}`, size: f.size, open_ms: performance.now() - t0});
  }
  // grid and variables from the first file
  const h = Object.values(files)[0];
  const vars = [...new Set(Object.values(files).flatMap(f => f.keys().filter(k => f.get(k).shape?.length === 5)))];
  const t2m = h.get(vars[0]);
  return {files: out, vars, lat: num(h.get("lat").value), lon: num(h.get("lon").value),
          lead: num(h.get("lead_time").value), chunks: t2m.metadata.chunks, shape: t2m.shape};
}

// one variable, one lead time, a box of grid points [iy0, iy1) x [ix0, ix1): all initial times
// and members, unpacked to physical values, area mean (unweighted, prototype only)
function read({variable, lead, iy0, iy1, ix0, ix1}) {
  const out = [];
  for (const [model, h] of Object.entries(files)) {
    const t0 = performance.now();
    const leads = num(h.get("lead_time").value), li = leads.indexOf(lead);
    if (!h.keys().includes(variable) || li < 0) { out.push({model, missing: true}); continue; }
    const ds = h.get(variable);
    const [ni, nm] = ds.shape;
    const raw = ds.slice([[0, ni], [0, nm], [li, li + 1], [iy0, iy1], [ix0, ix1]]);
    const t1 = performance.now();
    const sf = attr(ds, "scale_factor") ?? 1, ao = attr(ds, "add_offset") ?? 0, fill = attr(ds, "_FillValue");
    const np = (iy1 - iy0) * (ix1 - ix0), vals = [];   // vals[init][member]
    for (let i = 0; i < ni; i++) {
      const row = [];
      for (let k = 0; k < nm; k++) {
        let s = 0, n = 0;
        for (let p = 0; p < np; p++) {
          const v = raw[(i * nm + k) * np + p];
          if (Number(v) !== fill) { s += Number(v) * sf + ao; n++; }
        }
        row.push(n ? s / n : null);
      }
      vals.push(row);
    }
    const it = h.get("init_time"), base = attr(it, "units").match(/since (.+)$/)[1].replace(" ", "T") + "Z";
    const inits = num(it.value).map(x => new Date(Date.parse(base) + x * 3600e3).toISOString().slice(0, 16));
    out.push({model, inits, vals, unit: attr(ds, "units"), read_ms: t1 - t0,
              total_ms: performance.now() - t0, chunks_touched: ni * Math.ceil(nm / ds.metadata.chunks[1])});
  }
  return out;
}

onmessage = async e => {
  const {id, cmd, arg} = e.data;
  try {
    const result = cmd === "mount" ? await mount(arg) : read(arg);
    postMessage({id, result});
  } catch (err) {
    postMessage({id, error: String(err && err.stack || err)});
  }
};

