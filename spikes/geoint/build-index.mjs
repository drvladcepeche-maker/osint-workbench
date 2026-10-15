/**
 * build-index.mjs — offline candidate builder for the GEOINT Range.
 *
 * WHY THIS EXISTS
 * ---------------
 * Serving a random street-level photo produces mostly featureless residential
 * streets and rural roads — unusable for a beginner. We therefore only serve
 * frames that have measurable OSM "signal" nearby (named shops, bus stops,
 * signed routes, settlements).
 *
 * The Overpass usage policy budgets a *recurring application* at roughly
 * 100 queries and 10 MB per DAY across all its users. So Overpass must never be
 * called at round time. This script runs offline, occasionally, and emits a
 * static JSON index the app ships and reads locally.
 *
 *   node build-index.mjs            # build the default (Bulgaria) index
 *   node build-index.mjs --region balkans
 *
 * Targeted top-up (does NOT re-query the areas that already succeeded — Overpass
 * budgets a recurring app at ~100 queries/day, so a full 21-area rebuild to fill
 * in three gaps is wasteful and rude):
 *
 *   node build-index.mjs --region countries \
 *     --areas "Serbia/Belgrade,Taiwan/Taipei,USA/Portland" --merge
 *
 * Output: candidates.<region>.json
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";

const PX = "https://api.panoramax.xyz/api";
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",  // VK mirror, no rate limit
];

/* Areas where Panoramax is known to have coverage. Keep this list small:
   each entry costs exactly one Overpass query per build. */
const REGIONS = {
  bulgaria: {
    label: "Bulgaria",
    areas: {
      Sofia:         [23.25, 42.63, 23.42, 42.73],
      Plovdiv:       [24.68, 42.10, 24.83, 42.19],
      VelikoTarnovo: [25.55, 43.05, 25.70, 43.13],
      StaraZagora:   [25.55, 42.38, 25.70, 42.47],
      Burgas:        [27.40, 42.45, 27.55, 42.55],
      Varna:         [27.80, 43.17, 27.98, 43.25],
      /* There was a "Strandzha" area here at [27.50, 41.20, 28.05, 41.35]. That box
         is NOT in Bulgaria — it is ~85 km inside Türkiye (Ergene, Tekirdağ; verified
         by reverse geocoding, and every readable sign in its imagery is Turkish:
         SATILIK, KİRALIK, BAHÇESİ). At longitude 27.7 the Bulgarian border sits near
         latitude 41.98, not 41.2. It contributed 183 frames to the Bulgaria index —
         including all 181 of its supposed "Bulgarian panoramas" — so the home-ground
         pin tier was serving Turkish frames with the map centred on Bulgaria. It now
         lives in the country set below, correctly labelled. */
    },
  },

  /* Multi-country set for the country-guessing tiers. Every box below was probed
     against Panoramax and returns real imagery. Deliberately loaded with the
     countries a Bulgarian learner confuses most: RO, RS, GR, TR, HR. */
  countries: {
    label: "Country guessing",
    areas: {
      "Bulgaria/Sofia":     [23.25, 42.63, 23.42, 42.73],
      "Romania/Bucharest":  [26.03, 44.40, 26.16, 44.48],
      "Serbia/Belgrade":    [20.42, 44.78, 20.52, 44.84],
      "Greece/Athens":      [23.70, 37.96, 23.79, 38.01],
      "Turkey/Istanbul":    [28.94, 41.00, 29.05, 41.06],
      "Turkey/Ergene":      [27.50, 41.20, 28.05, 41.35],   // was mislabelled "Strandzha"
      "Croatia/Zagreb":     [15.90, 45.76, 16.05, 45.85],
      "Croatia/Split":      [16.40, 43.49, 16.52, 43.55],
      "France/Paris":       [2.25, 48.81, 2.42, 48.90],
      "France/Lyon":        [4.78, 45.72, 4.90, 45.79],
      "Belgium/Brussels":   [4.31, 50.81, 4.42, 50.89],
      "Netherlands/Amsterdam": [4.85, 52.35, 4.94, 52.39],
      "Germany/Fulda":      [9.63, 50.53, 9.72, 50.58],
      "Austria/Vienna":     [16.30, 48.18, 16.42, 48.24],
      "Switzerland/Zurich": [8.50, 47.35, 8.58, 47.40],
      "Italy/Milan":        [9.16, 45.44, 9.23, 45.50],
      "Spain/Madrid":       [-3.73, 40.40, -3.66, 40.45],
      "Poland/Warsaw":      [20.95, 52.20, 21.06, 52.26],
      "UK/Cardiff":         [-3.22, 51.46, -3.14, 51.51],
      "Taiwan/Taipei":      [121.49, 25.02, 121.58, 25.09],
      "USA/Portland":       [-122.72, 45.48, -122.60, 45.56],
    },
  },
};

/* Image hosts that serve without an Access-Control-Allow-Origin header. The 360
   viewer needs pixel access (XHR + crossOrigin), so panoramas from these hosts
   fail in-browser. Measured 2026-08-30: 10 of 11 Panoramax image hosts are clean;
   the Wales instance on Backblaze is not. Re-test if coverage changes. */
const CORS_BLOCKED_HOSTS = new Set(["s3.eu-central-003.backblazeb2.com"]);

/* ---------------------------------------------------------------- geometry */
const R = 6371.0088, rad = d => d * Math.PI / 180;
function metres(a, b) {
  const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]);
  const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s))) * 1000;
}

/* ------------------------------------------------------------------- http */
async function getJSON(url, opts = {}, tries = 3) {
  for (let t = 0; t < tries; t++) {
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 180000);
      const r = await fetch(url, { ...opts, signal: ctl.signal });
      clearTimeout(to);
      /* 429 = "slow down", 504 = the query gateway gave up under load. Both mean
         back off rather than retry immediately, and back off further each time. */
      if (r.status === 429 || r.status === 504) {
        const wait = 30000 * (t + 1);
        process.stdout.write(`[${r.status} backoff ${wait / 1000}s] `);
        await sleep(wait);
        continue;
      }
      if (!r.ok) { await sleep(4000 * (t + 1)); continue; }
      const txt = await r.text();
      if (!txt.trimStart().startsWith("{")) { await sleep(6000); continue; }
      return JSON.parse(txt);
    } catch { await sleep(5000 * (t + 1)); }
  }
  return null;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* --------------------------------------------------------------- overpass */
/* Signal = things that put readable, place-identifying information in frame.
   Weights encode how much a beginner can actually DO with each one. */
const SIGNAL_WEIGHT = {
  shop_named: 3, amenity_named: 3, bus_stop: 2, place: 2, route_ref: 2,
  tourism_info: 3, traffic_sign: 3, border: 4,
};

function overpassQuery([w, s, e, n]) {
  return `[out:json][timeout:180];(
    nwr["shop"]["name"](${s},${w},${n},${e});
    nwr["amenity"~"^(restaurant|cafe|bar|pub|pharmacy|bank|fuel|school|post_office|townhall|police|hospital)$"]["name"](${s},${w},${n},${e});
    node["highway"="bus_stop"](${s},${w},${n},${e});
    node["place"~"^(city|town|village|suburb)$"](${s},${w},${n},${e});
    way["highway"]["ref"](${s},${w},${n},${e});
    node["tourism"="information"](${s},${w},${n},${e});
    node["traffic_sign"](${s},${w},${n},${e});
    nwr["barrier"="border_control"](${s},${w},${n},${e});
  );out center tags;`;
}

function classify(tags = {}) {
  if (tags.barrier === "border_control") return "border";
  if (tags.traffic_sign) return "traffic_sign";
  if (tags.tourism === "information") return "tourism_info";
  if (tags.shop && tags.name) return "shop_named";
  if (tags.amenity && tags.name) return "amenity_named";
  if (tags.highway === "bus_stop") return "bus_stop";
  if (tags.place) return "place";
  if (tags.ref) return "route_ref";
  return null;
}

/* ------------------------------------------------------------------ build */
async function buildArea(name, bbox) {
  process.stdout.write(`  ${name.padEnd(15)} `);

  const pj = await getJSON(`${PX}/search?bbox=${bbox.join(",")}&limit=1000`, { timeoutMs: 90000 });
  const pics = (pj?.features || [])
    .filter(f => f.assets?.hd || f.assets?.sd)
    .filter(f => {
      const href = f.assets.hd?.href || f.assets.sd?.href;
      try { return !CORS_BLOCKED_HOSTS.has(new URL(href).host); } catch { return false; }
    })
    .map(f => {
      const io = f.properties?.["pers:interior_orientation"] || {};
      const dims = io.sensor_array_dimensions;
      return {
        id: f.id,
        c: f.geometry.coordinates.map(v => +v.toFixed(6)),
        pano: io.field_of_view === 360 || !!(dims && Math.abs(dims[0] / dims[1] - 2) < 0.02),
        url: f.assets.hd?.href || f.assets.sd?.href,
        t: f.properties?.datetime || null,
      };
    });
  if (!pics.length) { console.log("no imagery"); return []; }

  let oj = null;
  for (const ep of OVERPASS) {
    oj = await getJSON(ep, {
      method: "POST",
      body: new URLSearchParams({ data: overpassQuery(bbox) }),
      timeoutMs: 200000,
    }, 4);
    if (oj) break;
  }
  if (!oj) { console.log(`pics=${pics.length} OVERPASS FAILED`); return []; }

  const signals = [];
  for (const el of oj.elements || []) {
    const lon = el.lon ?? el.center?.lon, lat = el.lat ?? el.center?.lat;
    const kind = classify(el.tags);
    if (lon == null || !kind) continue;
    signals.push({ c: [lon, lat], kind, name: el.tags?.name || null });
  }

  /* score each picture by the signal within 60 m */
  const RADIUS = 60;
  const out = [];
  for (const p of pics) {
    let sc = 0; const kinds = new Set();
    for (const g of signals) {
      if (metres(p.c, g.c) > RADIUS) continue;
      sc += SIGNAL_WEIGHT[g.kind] || 1;
      kinds.add(g.kind);
    }
    // area names are "Country/City" in the multi-country set, bare city otherwise
    const [country, city] = name.includes("/") ? name.split("/") : [null, name];
    if (sc > 0) out.push({ ...p, area: city, country, signal: sc, kinds: [...kinds] });
  }
  out.sort((a, b) => b.signal - a.signal);
  const pct = (100 * out.length / pics.length).toFixed(0);
  console.log(`pics=${String(pics.length).padStart(4)} signals=${String(signals.length).padStart(5)} kept=${String(out.length).padStart(4)} (${pct}%)  panos=${out.filter(o => o.pano).length}`);
  return out;
}

const arg = f => process.argv.includes(f) ? process.argv[process.argv.indexOf(f) + 1] : null;
const regionKey = arg("--region") || "bulgaria";
const region = REGIONS[regionKey];
if (!region) { console.error("unknown region"); process.exit(1); }

const onlyArg = arg("--areas");
const merge = process.argv.includes("--merge");
const only = onlyArg ? onlyArg.split(",").map(s => s.trim()).filter(Boolean) : null;

let todo = Object.entries(region.areas);
if (only) {
  const unknown = only.filter(a => !region.areas[a]);
  if (unknown.length) { console.error("unknown area(s):", unknown.join(", ")); process.exit(1); }
  todo = only.map(a => [a, region.areas[a]]);
}

const file = `candidates.${regionKey}.json`;
const outPath = new URL(`./${file}`, import.meta.url);

/* --merge keeps every area that already succeeded and replaces only the ones
   rebuilt in this run. Without it a partial run would silently delete the rest. */
let carried = [];
if (merge) {
  if (!existsSync(outPath)) { console.error(`--merge needs an existing ${file}`); process.exit(1); }
  const prev = JSON.parse(readFileSync(outPath, "utf8"));
  const rebuilding = new Set(todo.map(([n]) => n));
  const areaKey = c => (c.country ? `${c.country}/${c.area}` : c.area);
  carried = (prev.candidates || []).filter(c => !rebuilding.has(areaKey(c)));
  console.log(`Merging into ${file}: carrying ${carried.length} frames from ${
    prev.candidates.length} (dropping ${prev.candidates.length - carried.length} from rebuilt areas)`);
}

console.log(`Building signal index for ${region.label}${only ? ` — areas: ${only.join(", ")}` : ""}\n`);
let all = [];
for (const [name, bbox] of todo) {
  all = all.concat(await buildArea(name, bbox));
  await sleep(8000);   // be polite to Overpass between queries
}

const fresh = all.length;
all = all.concat(carried);
all.sort((a, b) => b.signal - a.signal);
if (merge) console.log(`\n${fresh} new frames + ${carried.length} carried = ${all.length}`);
const index = {
  built: new Date().toISOString(),
  region: regionKey,
  note: "Signal-filtered Panoramax candidates. Built offline; the app makes no Overpass calls at runtime.",
  attribution: "Imagery © Panoramax contributors, CC-BY-SA 4.0. Signal data © OpenStreetMap contributors, ODbL.",
  counts: {
    total: all.length,
    panos: all.filter(c => c.pano).length,
    byCountry: all.reduce((m, c) => (c.country && (m[c.country] = (m[c.country] || 0) + 1), m), {}),
  },
  candidates: all,
};
writeFileSync(outPath, JSON.stringify(index));
console.log(`\nWrote ${file} — ${all.length} high-signal frames (${index.counts.panos} panoramas)`);
console.log(`Top signal scores: ${all.slice(0, 10).map(c => c.signal).join(", ")}`);
if (Object.keys(index.counts.byCountry).length)
  console.log("By country:", JSON.stringify(index.counts.byCountry));
