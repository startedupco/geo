// collanduni geo API — serves SA location autocomplete datasets from za.json
// in the startedupco/geo GitHub repo. Zero dependencies. Node 18+.
// Deploy on Render as a Web Service (see README.md).

const http = require('http');
const crypto = require('crypto');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

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

const API_KEYS = (process.env.API_KEYS || process.env.API_KEY || '').split(',').map((s) => s.trim()).filter(Boolean);
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const KEY_CACHE_TTL = Number(process.env.KEY_CACHE_TTL_MS || 5 * 60 * 1000);
const keyCache = new Map(); // hash -> { at, row }

function supaHeaders(extra) {
  return Object.assign({
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: 'Bearer ' + SUPABASE_SERVICE_KEY,
    'Content-Type': 'application/json',
  }, extra);
}

async function findDbKey(raw) {
  const hash = sha256(raw);
  const hit = keyCache.get(hash);
  if (hit && Date.now() - hit.at < KEY_CACHE_TTL) return hit.row;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  const r = await fetch(SUPABASE_URL + '/rest/v1/api_keys?key_hash=eq.' + hash + '&active=eq.true&select=id,label,email,tier,calls', { headers: supaHeaders() });
  if (!r.ok) return null;
  const rows = await r.json().catch(() => []);
  const row = rows[0] || null;
  if (row) keyCache.set(hash, { at: Date.now(), row });
  return row;
}

function touchDbKey(row) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !row) return;
  row.calls = (row.calls || 0) + 1;
  fetch(SUPABASE_URL + '/rest/v1/api_keys?id=eq.' + row.id, {
    method: 'PATCH', headers: supaHeaders(),
    body: JSON.stringify({ calls: row.calls, last_used_at: new Date().toISOString() }),
  }).catch(() => {});
}

// returns { source:'open'|'env'|'db', ... } or null
function extractKey(req, u) {
  const h = req.headers['authorization'] || '';
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  return req.headers['x-api-key'] || u.searchParams.get('key');
}

async function authorized(req, u) {
  const strict = API_KEYS.length > 0 || (SUPABASE_URL && SUPABASE_SERVICE_KEY);
  if (!strict) return { source: 'open' };
  const k = extractKey(req, u);
  if (!k) return null;
  if (API_KEYS.includes(String(k))) return { source: 'env' };
  const row = await findDbKey(String(k)).catch(() => null);
  if (row) return { source: 'db', row };
  return null;
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > (maxBytes || 10240)) { reject(new Error('Body too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function newRawKey() {
  return 'ck_' + crypto.randomBytes(32).toString('hex');
}

async function handleAdmin(req, res, u) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return send(res, 503, { error: 'Supabase not configured. Set SUPABASE_URL + SUPABASE_SERVICE_KEY.' });
  }
  if (u.pathname === '/api/admin/keys' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req)) || {}; } catch (e) { return send(res, 400, { error: 'Invalid JSON body.' }); }
    const raw = newRawKey();
    const r = await fetch(SUPABASE_URL + '/rest/v1/api_keys', {
      method: 'POST', headers: supaHeaders({ Prefer: 'return=representation' }),
      body: JSON.stringify({
        key_prefix: raw.slice(0, 12),
        key_hash: sha256(raw),
        label: String(body.label || '').slice(0, 100),
        email: String(body.email || '').slice(0, 160),
        tier: String(body.tier || 'free').slice(0, 40),
      }),
    });
    if (!r.ok) return send(res, 502, { error: 'Supabase insert failed: HTTP ' + r.status });
    const rows = await r.json().catch(() => []);
    return send(res, 200, { key: raw, id: rows[0] && rows[0].id, warning: 'Copy the key now — only its hash is stored and it cannot be shown again.' });
  }
  if (u.pathname === '/api/admin/keys' && req.method === 'GET') {
    const r = await fetch(SUPABASE_URL + '/rest/v1/api_keys?select=id,key_prefix,label,email,tier,active,calls,last_used_at,created_at&order=created_at.desc&limit=100', { headers: supaHeaders() });
    if (!r.ok) return send(res, 502, { error: 'Supabase read failed: HTTP ' + r.status });
    return send(res, 200, { keys: await r.json() });
  }
  if (u.pathname === '/api/admin/keys/revoke' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req)) || {}; } catch (e) { return send(res, 400, { error: 'Invalid JSON body.' }); }
    if (!body.id) return send(res, 400, { error: 'Missing id.' });
    const r = await fetch(SUPABASE_URL + '/rest/v1/api_keys?id=eq.' + encodeURIComponent(body.id), {
      method: 'PATCH', headers: supaHeaders(), body: JSON.stringify({ active: false }),
    });
    if (!r.ok) return send(res, 502, { error: 'Supabase update failed: HTTP ' + r.status });
    keyCache.clear();
    return send(res, 200, { ok: true, revoked: body.id });
  }
  return send(res, 404, { error: 'Admin routes: POST /api/admin/keys, GET /api/admin/keys, POST /api/admin/keys/revoke' });
}
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
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, X-Admin-Key',
    });
    return res.end();
  }
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
  if (u.pathname.startsWith('/api/admin/')) {
    if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, { error: 'Admin supports GET and POST only.' });
    if (!ADMIN_KEY || req.headers['x-admin-key'] !== ADMIN_KEY) return send(res, 403, { error: 'Admin only.' });
    return handleAdmin(req, res, u);
  }
  if (req.method !== 'GET') {
    return send(res, 405, { error: 'Only GET is supported.' });
  }
  const auth = await authorized(req, u);
  if (!auth) {
    return send(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Missing Bearer token or X-API-Key' } });
  }
  if (auth.source === 'db') touchDbKey(auth.row);

  try {
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

server.listen(PORT, '0.0.0.0', function () {
  console.log('collanduni geo API listening on :' + PORT);
  console.log('Serving ' + REPO + '/' + FILE + ' @ ' + BRANCH + (TOKEN ? ' (authenticated)' : ' (public raw)'));
});
