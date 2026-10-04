// collanduni geo API — serves SA location autocomplete datasets from za.json
// in the startedupco/geo GitHub repo. Zero dependencies. Node 18+.
// Deploy on Render as a Web Service (see README.md).

const http = require('http');

const PORT = process.env.PORT || 8080;
const REPO = process.env.GITHUB_REPO || 'startedupco/geo';
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const TOKEN = process.env.GITHUB_TOKEN || '';
const CACHE_TTL = Number(process.env.CACHE_TTL_MS || 60 * 60 * 1000);

const FILE = 'za.json';
let cache = null; // { at, data }

function upstream() {
  if (TOKEN) {
    return {
      url: 'https://api.github.com/repos/' + REPO + '/contents/' + FILE + '?ref=' + BRANCH,
      headers: {
        Authorization: 'Bearer ' + TOKEN,
        Accept: 'application/vnd.github.raw',
        'User-Agent': 'collanduni-geo-api',
      },
    };
  }
  return {
    url: 'https://raw.githubusercontent.com/' + REPO + '/' + BRANCH + '/' + FILE,
    headers: { 'User-Agent': 'collanduni-geo-api' },
  };
}

async function loadGeo() {
  if (cache && Date.now() - cache.at < CACHE_TTL) return cache.data;
  const u = upstream();
  const res = await fetch(u.url, { headers: u.headers });
  if (!res.ok) {
    const err = new Error(res.status === 404
      ? 'za.json not published yet: upload it to ' + REPO + '@' + BRANCH
      : 'Upstream HTTP ' + res.status);
    err.status = res.status === 404 ? 404 : 502;
    throw err;
  }
  const data = await res.json();
  cache = { at: Date.now(), data };
  return data;
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=60',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function str(v) { return String(v || '').trim().toLowerCase(); }
function page(items, params) {
  const total = items.length;
  const offset = Math.max(0, Number(params.get('offset')) || 0);
  const limit = Math.min(Math.max(1, Number(params.get('limit')) || 50), 500);
  return { total, offset, limit, count: 0, results: [] , _slice: [offset, offset + limit] };
}

async function handleProvinces() {
  const d = await loadGeo();
  const provinces = (d.provinces || []).map((x) => x.name || x);
  return { status: 200, body: { count: provinces.length, provinces } };
}

async function handleCities(params) {
  const d = await loadGeo();
  const prov = str(params.get('province'));
  let list = d.cities || [];
  if (prov) list = list.filter((c) => str(c.province) === prov);
  return { status: 200, body: { count: list.length, cities: list.map((c) => c.city) } };
}

async function handleSuburbs(params) {
  const d = await loadGeo();
  const prov = str(params.get('province'));
  const city = str(params.get('city'));
  let list = d.suburbs || [];
  if (prov) list = list.filter((s) => str(s.province) === prov);
  if (city) list = list.filter((s) => str(s.city) === city);
  return { status: 200, body: { count: list.length, suburbs: list.map((s) => s.suburb) } };
}

async function handleSchools(params) {
  const d = await loadGeo();
  const q = str(params.get('q'));
  const prov = str(params.get('province'));
  const city = str(params.get('city'));
  const suburb = str(params.get('suburb'));
  let items = d.schools || [];
  if (prov) items = items.filter((s) => str(s.p) === prov);
  if (city) items = items.filter((s) => str(s.c) === city);
  if (suburb) items = items.filter((s) => str(s.s) === suburb);
  if (q) items = items.filter((s) => str(s.n).includes(q));
  const p = page(items, params);
  const slice = items.slice(p._slice[0], p._slice[1]);
  p.results = slice.map((s) => ({ name: s.n, suburb: s.s, city: s.c, province: s.p }));
  p.count = p.results.length;
  delete p._slice;
  return { status: 200, body: p };
}

async function handlePlaces(params) {
  const d = await loadGeo();
  const q = str(params.get('q'));
  let items = d.places || [];
  if (q) items = items.filter((x) => str(x.n).includes(q));
  const p = page(items, params);
  const slice = items.slice(p._slice[0], p._slice[1]);
  p.results = slice;
  p.count = p.results.length;
  delete p._slice;
  return { status: 200, body: p };
}

const server = http.createServer(async function (req, res) {
  let u;
  try {
    u = new URL(req.url, 'http://localhost');
  } catch (e) {
    return send(res, 400, { error: 'Bad request.' });
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }
  if (req.method !== 'GET') {
    return send(res, 405, { error: 'Only GET is supported.' });
  }

  try {
    if (u.pathname === '/api/health') {
      return send(res, 200, {
        ok: true,
        service: 'collanduni-geo-api',
        repo: REPO,
        branch: BRANCH,
        cached: !!cache,
        now: new Date().toISOString(),
      });
    }
    if (u.pathname === '/api/geo/provinces') {
      const r = await handleProvinces();
      return send(res, r.status, r.body);
    }
    if (u.pathname === '/api/geo/cities') {
      const r = await handleCities(u.searchParams);
      return send(res, r.status, r.body);
    }
    if (u.pathname === '/api/geo/suburbs') {
      const r = await handleSuburbs(u.searchParams);
      return send(res, r.status, r.body);
    }
    if (u.pathname === '/api/geo/schools') {
      const r = await handleSchools(u.searchParams);
      return send(res, r.status, r.body);
    }
    if (u.pathname === '/api/geo/places') {
      const r = await handlePlaces(u.searchParams);
      return send(res, r.status, r.body);
    }
    return send(res, 404, { error: 'Not found. Try /api/health, /api/geo/provinces, /api/geo/cities, /api/geo/suburbs, /api/geo/schools, /api/geo/places' });
  } catch (e) {
    return send(res, e.status || 500, { error: e.message || 'Server error.' });
  }
});

server.listen(PORT, function () {
  console.log('collanduni geo API listening on :' + PORT);
  console.log('Serving ' + REPO + '/' + FILE + ' @ ' + BRANCH + (TOKEN ? ' (authenticated)' : ' (public raw)'));
});
