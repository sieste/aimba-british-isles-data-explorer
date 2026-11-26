// Data side of the web version of the British Isles explorer: the same reading and aggregation
// as server.py, run in the browser. The files stay on the user's disk; h5wasm (HDF5 compiled to
// WebAssembly) reads them through WORKERFS, which fetches only the byte ranges HDF5 asks for.
self.importScripts("https://cdn.jsdelivr.net/npm/h5wasm@0.10.3/dist/iife/h5wasm.js");

const MODELS = {"aifs-ens": "AIFS-ENS", "fcn3": "FourCastNet 3", "atlas-crps": "Atlas CRPS",
                "aurora-ens": "Aurora 1.5 ens. (fp16)", "ifs-ens": "IFS ENS", "era5": "ERA5"};
// id: [label, unit, source variables, conversion of the stored values]
const VARIABLES = {
  t2m: ["2-m temperature", "°C", ["t2m"], x => x - 273.15],
  msl: ["Mean sea-level pressure", "hPa", ["msl"], x => x / 100],
  wind10: ["10-m wind speed", "m/s", ["u10m", "v10m"], (u, v) => Math.hypot(u, v)],
  u10m: ["10-m eastward wind", "m/s", ["u10m"], x => x],
  v10m: ["10-m northward wind", "m/s", ["v10m"], x => x],
  tp06: ["6-hour precipitation", "mm", ["tp06"], x => x * 1000],
  z500: ["500-hPa geopotential height", "gpm", ["z500"], x => x / 9.80665],
  t850: ["850-hPa temperature", "°C", ["t850"], x => x - 273.15],
  wind850: ["850-hPa wind speed", "m/s", ["u850", "v850"], (u, v) => Math.hypot(u, v)],
  u850: ["850-hPa eastward wind", "m/s", ["u850"], x => x],
  v850: ["850-hPa northward wind", "m/s", ["v850"], x => x],
  q700: ["700-hPa specific humidity", "g/kg", ["q700"], x => x * 1000],
};
const AGGREGATIONS = {mean: "area mean (cos-latitude weighted)", sum: "sum over grid points",
                      std: "standard deviation over grid points (cos-latitude weighted)"};

let FS = null, generation = 0;
let FILES = {};                  // model -> [{name, h5}] in wave order
let GRID = null;                 // lat, lon, lead, members
const CACHE = new Map();         // "gen|model|var|lead" -> {data: Float64Array (init, member, lat, lon), inits}
const CACHE_BYTES = 400e6;

const num = a => Array.from(a, Number);           // also turns BigInt64Array into numbers
// attribute values come back as one-element typed arrays: take the number (or string)
function attr(ds, name) {
  if (!(name in ds.attrs)) return undefined;
  const v = ds.attrs[name].value;
  return ArrayBuffer.isView(v) ? Number(v[0]) : v;
}

async function scan({files: list, folder}) {
  if (!FS) ({FS} = await h5wasm.ready);
  const found = {};
  for (const f of list) {
    const m = f.name.match(/^(.+)_wave(\d+)_british_isles\.nc$/);
    if (m && m[1] in MODELS) (found[m[1]] ??= []).push({file: f, wave: +m[2]});
  }
  if (!Object.keys(found).length)
    throw new Error(`no <model>_wave<NN>_british_isles.nc files in ${folder}`);
  // close the previous folder's files, mount the new ones
  for (const fs of Object.values(FILES)) for (const f of fs) f.h5.close();
  FILES = {}; CACHE.clear(); generation++;
  try { FS.unmount("/work"); } catch (e) {}
  try { FS.mkdir("/work"); } catch (e) {}
  FS.mount(FS.filesystems.WORKERFS, {files: Object.values(found).flat().map(x => x.file)}, "/work");
  for (const m of Object.keys(MODELS).filter(m => m in found))
    FILES[m] = found[m].sort((a, b) => a.wave - b.wave)
                       .map(x => ({name: x.file.name, h5: new h5wasm.File(`/work/${x.file.name}`, "r")}));
  const h = FILES[Object.keys(FILES)[0]][0].h5;
  GRID = {lat: num(h.get("lat").value), lon: num(h.get("lon").value),
          lead: num(h.get("lead_time").value), members: h.get("member").shape[0]};
  return catalog(folder);
}

function catalog(folder) {
  return {
    data: folder,
    models: Object.entries(FILES).map(([m, fs]) => ({id: m, name: MODELS[m], files: fs.map(f => f.name)})),
    variables: Object.entries(VARIABLES).map(([k, v]) => ({id: k, label: v[0], unit: v[1]})),
    aggregations: Object.entries(AGGREGATIONS).map(([k, v]) => ({id: k, label: v})),
    lead_times: GRID.lead, members: GRID.members,
    lat: [Math.min(...GRID.lat), Math.max(...GRID.lat)], lon: [Math.min(...GRID.lon), Math.max(...GRID.lon)],
  };
}

function isoHours(units, hours) {
  const base = Date.parse(units.match(/since (.+)$/)[1].trim().replace(" ", "T") + "Z");
  const step = /^days/.test(units) ? 86400e3 : /^minutes/.test(units) ? 60e3 : /^seconds/.test(units) ? 1e3 : 3600e3;
  return hours.map(x => new Date(base + x * step).toISOString().slice(0, 16));
}

// one stored variable at one lead time, all initial times of all waves: (init, member, lat, lon)
// with NaN for missing values, and the initial times; null if a file lacks the variable
function stored(model, variable, lead) {
  const key = `${generation}|${model}|${variable}|${lead}`;
  if (CACHE.has(key)) { const v = CACHE.get(key); CACHE.delete(key); CACHE.set(key, v); return v; }
  const parts = [], inits = [];
  let members = null;
  for (const {h5, name} of FILES[model]) {
    if (!h5.keys().includes(variable)) return null;
    postMessage({progress: `reading ${variable} from ${name}…`});
    const li = num(h5.get("lead_time").value).indexOf(lead);
    if (li < 0) return null;
    const ds = h5.get(variable), [ni, nm, , ny, nx] = ds.shape;
    members = nm;
    const raw = ds.slice([[0, ni], [0, nm], [li, li + 1], [0, ny], [0, nx]]);
    const sf = attr(ds, "scale_factor") ?? 1, ao = attr(ds, "add_offset") ?? 0, fill = attr(ds, "_FillValue");
    const out = new Float64Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      const v = Number(raw[i]);
      out[i] = v === fill ? NaN : v * sf + ao;
    }
    parts.push(out);
    const it = h5.get("init_time");
    inits.push(...isoHours(attr(it, "units"), num(it.value)));
  }
  let data = parts[0];
  if (parts.length > 1) {
    data = new Float64Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) { data.set(p, o); o += p.length; }
  }
  const v = {data, inits, members};
  CACHE.set(key, v);
  let bytes = 0;
  for (const x of CACHE.values()) bytes += x.data.byteLength;
  for (const k of CACHE.keys()) {            // oldest first
    if (bytes <= CACHE_BYTES || CACHE.size <= 1) break;
    bytes -= CACHE.get(k).data.byteLength; CACHE.delete(k);
  }
  return v;
}

const round4 = v => Math.round(v * 1e4) / 1e4;
const argmin = (a, x) => a.reduce((b, v, i) => Math.abs(v - x) < Math.abs(a[b] - x) ? i : b, 0);

function series(q) {
  if (!GRID) throw new Error("choose the data folder first");
  const name = q.variable, lead = +q.lead;
  const [label, unit, sources, conv] = VARIABLES[name];
  const {lat, lon} = GRID, ny = lat.length, nx = lon.length;
  let iy, ix, where, box;
  if (q.mode === "point") {
    iy = [argmin(lat, +q.lat)]; ix = [argmin(lon, +q.lon)];
    where = `grid point ${lat[iy[0]].toFixed(2)}N, ${lon[ix[0]].toFixed(2)}E`;
    box = [lat[iy[0]], lat[iy[0]], lon[ix[0]], lon[ix[0]]];
  } else {
    const [la0, la1] = [+q.lat0, +q.lat1].sort((a, b) => a - b);
    const [lo0, lo1] = [+q.lon0, +q.lon1].sort((a, b) => a - b);
    iy = lat.map((v, i) => v >= la0 - 1e-6 && v <= la1 + 1e-6 ? i : -1).filter(i => i >= 0);
    ix = lon.map((v, i) => v >= lo0 - 1e-6 && v <= lo1 + 1e-6 ? i : -1).filter(i => i >= 0);
    if (!iy.length || !ix.length) throw new Error("the region contains no grid points");
    const la = iy.map(i => lat[i]), lo = ix.map(i => lon[i]);
    box = [Math.min(...la), Math.max(...la), Math.min(...lo), Math.max(...lo)];
    where = `${iy.length} x ${ix.length} grid points, ${box[0].toFixed(2)}-${box[1].toFixed(2)}N, ` +
            `${box[2].toFixed(2)}-${box[3].toFixed(2)}E, ${AGGREGATIONS[q.agg]}`;
  }
  const out = {variable: label, unit, lead, where, box, id: name, models: [], missing: [],
               agg: q.mode === "region" ? q.agg : "point"};
  const w = iy.map(i => Math.cos(lat[i] * Math.PI / 180));
  const wsum = w.reduce((s, x) => s + x, 0) * ix.length;
  for (const m of Object.keys(FILES)) {
    const parts = sources.map(s => stored(m, s, lead));
    if (parts.some(p => p === null)) { out.missing.push(MODELS[m]); continue; }
    const inits = parts[0].inits, ni = inits.length, nm = parts[0].members;
    const members = Array.from({length: nm}, () => new Array(ni));
    const mean = new Array(ni);
    for (let i = 0; i < ni; i++) {
      let s = 0, n = 0;
      for (let k = 0; k < nm; k++) {
        const base = (i * nm + k) * ny * nx;
        const x = (y, xx) => conv(...parts.map(p => p.data[base + y * nx + xx]));
        let v;
        if (q.mode === "point") v = x(iy[0], ix[0]);
        else {
          const vals = iy.map(y => ix.map(xx => x(y, xx)));
          if (q.agg === "sum") v = vals.flat().reduce((a, b) => a + b, 0);
          else {
            let mu = 0;
            vals.forEach((row, r) => row.forEach(val => { mu += val * w[r]; }));
            mu /= wsum;
            if (q.agg === "mean") v = mu;
            else {
              let ss = 0;
              vals.forEach((row, r) => row.forEach(val => { ss += (val - mu) ** 2 * w[r]; }));
              v = Math.sqrt(ss / wsum);
            }
          }
        }
        v = Number.isFinite(v) ? round4(v) : null;
        members[k][i] = v;
        if (v !== null) { s += v; n++; }
      }
      mean[i] = n ? s / n : null;
    }
    out.models.push({id: m, name: MODELS[m], inits, members, mean});
  }
  return out;
}

onmessage = async e => {
  const {id, cmd, arg} = e.data;
  try {
    const result = cmd === "scan" ? await scan(arg) : series(arg);
    postMessage({id, result});
  } catch (err) {
    postMessage({id, error: err && err.message || String(err)});
  }
};
