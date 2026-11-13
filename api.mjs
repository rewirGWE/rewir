/* Rewir – serwer gry (Netlify Function + Netlify Blobs).
   Gracze bez kont: przy dołączeniu dostają kod odzyskiwania, który jest ich kluczem.
   Dane: ksywka, ikonka, opublikowane trasy, czasy i prędkości. */
import { getStore } from "@netlify/blobs";

export const config = { path: ["/api/*", "/w/*", "/z/*"] };

const ICONS = ["🦊","🐗","🐺","🦉","🐻","🦌","🐿️","🦔","🐸","🦅","🐝","🦡","🐍","🦬","🐌","🦇","🐞","🐢","🦎","🐧","🐰","🐼","🦁","🐯"];
const ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";           // bez 0/O i 1/I
const MAXBODY = 64 * 1024;
const TOP = 50;

/* ---------- pomocnicze ---------- */
const H = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
  "access-control-allow-origin": "*", "access-control-allow-headers": "content-type,x-rewir-key", "access-control-allow-methods": "GET,POST,OPTIONS" };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: H });
const err = (msg, s = 400) => json({ error: msg }, s);
const rnd = n => { const b = crypto.getRandomValues(new Uint8Array(n)); let s = ""; for (const x of b) s += ABC[x % 32]; return s; };
const newKey = () => [rnd(4), rnd(4), rnd(4), rnd(4)].join("-");
const normKey = k => String(k || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/(.{4})(?=.)/g, "$1-");
async function sha(s) { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, "0")).join(""); }
const fin = x => typeof x === "number" && Number.isFinite(x);
const clean = (s, n) => String(s ?? "").replace(/[<>\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim().slice(0, n);
const cellOf = (lat, lng) => Math.floor(lat * 10) + "_" + Math.floor(lng * 10);
const ridOk = r => fin(r) && r > 0 && r < 1e14;

/* prosty limit zapytań na jedną instancję funkcji */
const hits = new Map();
function limited(key, max, ms) {
  const now = Date.now(), a = (hits.get(key) || []).filter(t => now - t < ms);
  a.push(now); hits.set(key, a); if (hits.size > 5000) hits.clear();
  return a.length > max;
}

/* ---------- uczciwa gra ---------- */
// granice dla roweru na zjeździe o danym spadku (m) i długości (m)
export function limits(drop) {
  const d = Math.max(0, drop || 0);
  return { vmax: Math.min(100, 50 + 6 * Math.sqrt(d)), avg: Math.min(70, 35 + 4 * Math.sqrt(d)) };
}
export function check(tr, run) {
  const t = +run.t, mx = +run.max || 0, vt = +(run.vtop || run.max) || 0, L = limits(tr.drop);
  if (!(t >= 3 && t <= 6 * 3600)) return { time: "nierealny czas", speed: "nierealny czas" };
  const avg = (tr.len / t) * 3.6, out = { time: null, speed: null };
  if (avg > L.avg) out.time = "za szybko jak na tę trasę (średnio " + avg.toFixed(1) + " km/h)";
  if (mx > 0 && mx < avg * 0.85) out.time = out.time || "prędkość maksymalna niższa niż średnia";
  if (!(vt > 0)) out.speed = "brak pomiaru prędkości";
  else if (vt > L.vmax) out.speed = "nierealna prędkość " + vt.toFixed(1) + " km/h";
  else if (vt < avg * 0.85) out.speed = "prędkość niższa niż średnia";
  if (out.time) out.speed = out.speed || out.time;
  return out;
}

/* ---------- magazyn ---------- */
let S = null;
const db = () => (S = S || getStore({ name: "rewir", consistency: "strong" }));
const get = k => db().get(k, { type: "json" });
const put = (k, v) => db().setJSON(k, v);

async function who(req) {
  const k = normKey(req.headers.get("x-rewir-key"));
  if (k.length !== 19) return null;
  const pid = await get("k/" + (await sha(k)));
  if (!pid) return null;
  return await get("p/" + pid);
}
const pub = p => ({ pid: p.pid, nick: p.nick, icon: p.icon });

function sortTimes(lb, me) {
  const a = Object.entries(lb.times || {}).map(([pid, x]) => ({ pid, ...x })).sort((x, y) => x.t - y.t || x.d - y.d);
  return { list: a.slice(0, TOP).map(({ pid, ...x }) => ({ ...x, me: pid === me || undefined })), n: a.length, rank: me ? a.findIndex(x => x.pid === me) + 1 : 0 };
}
function sortSpeed(obj, me) {
  const a = Object.entries(obj || {}).map(([pid, x]) => ({ pid, ...x })).sort((x, y) => y.v - x.v || x.d - y.d);
  return { list: a.slice(0, TOP).map(({ pid, ...x }) => ({ ...x, me: pid === me || undefined })), n: a.length, rank: me ? a.findIndex(x => x.pid === me) + 1 : 0 };
}
function trackSum(tr, lb) {
  const T = sortTimes(lb || {}), V = sortSpeed((lb || {}).speed);
  return { rid: tr.rid, name: tr.name, len: tr.len, drop: tr.drop, s: tr.wps[0], n: T.n,
    best: T.list[0] ? { t: T.list[0].t, n: T.list[0].n, i: T.list[0].i } : null,
    top: V.list[0] ? { v: V.list[0].v, n: V.list[0].n, i: V.list[0].i } : null };
}
async function updIndex(tr, lb) {
  const key = "ix/" + cellOf(tr.wps[0][0], tr.wps[0][1]);
  const ix = (await get(key)) || [];
  const i = ix.findIndex(x => x.rid === tr.rid), sum = trackSum(tr, lb);
  if (i >= 0) ix[i] = sum; else ix.push(sum);
  ix.sort((a, b) => b.n - a.n);
  await put(key, ix.slice(0, 300));
}

/* ---------- obsługa ---------- */
async function body(req) {
  const t = await req.text();
  if (t.length > MAXBODY) throw Object.assign(new Error("Za duże dane."), { status: 413 });
  try { const o = JSON.parse(t || "{}"); if (!o || typeof o !== "object") throw 0; return o; } catch { throw Object.assign(new Error("Złe dane."), { status: 400 }); }
}

const routes = {
  "GET ping": async () => json({ ok: true, v: 1 }),
  /* gracz */
  "POST register": async (req, ip) => {
    if (limited("reg:" + ip, 5, 3600e3)) return err("Za dużo nowych graczy z tej sieci. Spróbuj za godzinę.", 429);
    const b = await body(req), nick = clean(b.nick, 20);
    if (nick.length < 2) return err("Ksywka musi mieć co najmniej 2 znaki.");
    const icon = ICONS.includes(b.icon) ? b.icon : ICONS[Math.floor(Math.random() * ICONS.length)];
    const key = newKey(), pid = rnd(10), p = { pid, nick, icon, created: Date.now() };
    await put("p/" + pid, p); await put("k/" + (await sha(key)), pid);
    return json({ ...pub(p), key });
  },
  "POST recover": async (req, ip) => {
    if (limited("rec:" + ip, 10, 600e3)) return err("Za dużo prób. Odczekaj 10 minut.", 429);
    const b = await body(req);
    const k = normKey(b.key); if (k.length !== 19) return err("Kod ma 16 znaków, np. ABCD-EFGH-JKLM-NPQR.");
    const pid = await get("k/" + (await sha(k))); const p = pid && (await get("p/" + pid));
    if (!p) return err("Nie znam takiego kodu.", 404);
    return json({ ...pub(p), key: k });
  },
  "POST profile": async (req, ip, me) => {
    if (!me) return err("Brak lub zły kod gracza.", 401);
    const b = await body(req), nick = clean(b.nick, 20);
    if (nick.length >= 2) me.nick = nick;
    if (ICONS.includes(b.icon)) me.icon = b.icon;
    await put("p/" + me.pid, me); return json(pub(me));
  },
  "GET me": async (req, ip, me) => me ? json(pub(me)) : err("Brak lub zły kod gracza.", 401),

  /* trasy */
  "POST track": async (req, ip, me) => {
    if (!me) return err("Brak lub zły kod gracza.", 401);
    if (limited("tr:" + me.pid, 30, 3600e3)) return err("Za dużo tras naraz.", 429);
    const b = await body(req), rid = +b.rid;
    if (!ridOk(rid)) return err("Zły numer trasy.");
    if (!Array.isArray(b.wps) || b.wps.length < 2 || b.wps.length > 2000) return err("Trasa musi mieć od 2 do 2000 punktów.");
    const wps = b.wps.map(p => [+(+p[0]).toFixed(5), +(+p[1]).toFixed(5)]);
    if (!wps.every(p => fin(p[0]) && fin(p[1]) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180)) return err("Złe współrzędne.");
    const len = +b.len, drop = +b.drop;
    if (!(len >= 30 && len <= 100000)) return err("Długość trasy poza zakresem.");
    const old = await get("t/" + rid);
    if (old) {
      const d = Math.hypot((old.wps[0][0] - wps[0][0]) * 111320, (old.wps[0][1] - wps[0][1]) * 111320 * Math.cos(wps[0][0] * Math.PI / 180));
      if (d > 60) return err("Inna trasa ma już ten numer.", 409);
      if (old.owner !== me.pid) return json({ ok: true, rid, owner: false });   // trasa już jest – nic nie zmieniamy
    }
    const tr = { rid, name: clean(b.name, 60) || "Trasa", len: Math.round(len), drop: Math.round(Math.max(0, fin(drop) ? drop : 0)), wps,
      owner: me.pid, ownerNick: me.nick, created: old ? old.created : Date.now(), cs: old ? old.cs || [] : [] };
    await put("t/" + rid, tr);
    await updIndex(tr, await get("lb/" + rid));
    return json({ ok: true, rid, owner: true });
  },
  "GET track": async (req, ip, me, arg) => {
    const tr = await get("t/" + +arg); if (!tr) return err("Nie ma takiej trasy.", 404);
    const { owner, cs, ...pubTr } = tr; return json(pubTr);
  },
  "GET tracks": async (req) => {
    const u = new URL(req.url), lat = +u.searchParams.get("lat"), lng = +u.searchParams.get("lng");
    if (!fin(lat) || !fin(lng)) return err("Podaj lat i lng.");
    const cy = Math.floor(lat * 10), cx = Math.floor(lng * 10), keys = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) keys.push("ix/" + (cy + dy) + "_" + (cx + dx));
    const all = (await Promise.all(keys.map(get))).flatMap(x => x || []);
    const k = 111320, c = Math.cos(lat * Math.PI / 180);
    all.forEach(t => t.dist = Math.round(Math.hypot((t.s[0] - lat) * k, (t.s[1] - lng) * k * c)));
    all.sort((a, b) => a.dist - b.dist);
    return json({ tracks: all.slice(0, 40) });
  },

  /* przejazdy i rankingi */
  "POST run": async (req, ip, me) => {
    if (!me) return err("Brak lub zły kod gracza.", 401);
    const b = await body(req), rid = +b.rid;
    const tr = await get("t/" + rid); if (!tr) return err("Tej trasy nie ma w rankingu online.", 404);
    if (limited("run:" + me.pid, 40, 3600e3)) return err("Za dużo przejazdów naraz.", 429);
    const run = { t: +b.t, max: +b.max || 0, vtop: +b.vtop || 0, avg: +b.avg || 0, d: fin(+b.date) ? Math.min(+b.date, Date.now()) : Date.now() };
    const ck = check(tr, run);
    const lb = (await get("lb/" + rid)) || { times: {}, speed: {} };
    const cur = lb.times[me.pid], v = +(run.vtop || run.max).toFixed(1);
    let newT = false, newV = false;
    if (!ck.time && (!cur || run.t < cur.t)) { lb.times[me.pid] = { t: +run.t.toFixed(2), v, n: me.nick, i: me.icon, d: run.d }; newT = true; }
    if (!ck.speed && (!lb.speed[me.pid] || v > lb.speed[me.pid].v)) { lb.speed[me.pid] = { v, n: me.nick, i: me.icon, d: run.d }; newV = true; }
    if (newT || newV) { await put("lb/" + rid, lb); await updIndex(tr, lb); }
    // zawody online na tej trasie
    const now = Date.now(), act = [];
    for (const cid of tr.cs || []) {
      const c = await get("c/" + cid); if (!c || now > c.t1 + 864e5) continue; act.push(cid);
      if (ck.speed || run.d < c.t0 || run.d > c.t1) continue;
      const cr = (await get("cr/" + cid)) || {};
      if (!cr[me.pid] || v > cr[me.pid].v) { cr[me.pid] = { v, n: me.nick, i: me.icon, d: run.d }; await put("cr/" + cid, cr); }
    }
    if (act.length !== (tr.cs || []).length) { tr.cs = act; await put("t/" + rid, tr); }
    const T = sortTimes(lb, me.pid), V = sortSpeed(lb.speed, me.pid);
    return json({ ok: true, newT, newV, rejected: ck.time || ck.speed ? ck : null, rankT: T.rank, rankV: V.rank, n: T.n, nV: V.n });
  },
  "GET lb": async (req, ip, me, arg) => {
    const rid = +arg, tr = await get("t/" + rid); if (!tr) return err("Tej trasy nie ma w rankingu online.", 404);
    const lb = (await get("lb/" + rid)) || {}, pid = me && me.pid;
    return json({ rid, name: tr.name, len: tr.len, drop: tr.drop, times: sortTimes(lb, pid), speed: sortSpeed(lb.speed, pid) });
  },

  /* krótkie linki do wyzwań */
  "POST share": async (req, ip) => {
    if (limited("sh:" + ip, 30, 3600e3)) return err("Za dużo linków naraz.", 429);
    const b = await body(req), d = String(b.d || "");
    if (!/^[zj][A-Za-z0-9_-]{8,12000}$/.test(d)) return err("Złe wyzwanie.");
    const id = await sha(d).then(h => h.slice(0, 8));          // ten sam link dla tego samego wyzwania
    if (!(await get("s/" + id))) await put("s/" + id, { d, at: Date.now() });
    return json({ id, url: new URL("/w/" + id, req.url).href });
  },

  /* zawody prędkości online */
  "POST contest": async (req, ip, me) => {
    if (!me) return err("Brak lub zły kod gracza.", 401);
    if (limited("ct:" + me.pid, 10, 86400e3)) return err("Za dużo zawodów jednego dnia.", 429);
    const b = await body(req), rid = +b.rid, days = [1, 3, 7].includes(+b.days) ? +b.days : 3;
    const tr = await get("t/" + rid); if (!tr) return err("Najpierw dodaj trasę do rankingu online.", 404);
    const cid = rnd(6), t0 = Date.now(), c = { cid, rid, name: tr.name, t0, t1: t0 + days * 864e5, days, owner: me.pid, ownerNick: me.nick };
    await put("c/" + cid, c);
    tr.cs = [...(tr.cs || []), cid].slice(-20); await put("t/" + rid, tr);
    return json({ ...c, owner: undefined, url: new URL("/z/" + cid, req.url).href });
  },
  "GET contest": async (req, ip, me, arg) => {
    const c = await get("c/" + clean(arg, 12)); if (!c) return err("Nie ma takich zawodów.", 404);
    const cr = (await get("cr/" + c.cid)) || {}, V = sortSpeed(cr, me && me.pid);
    const { owner, ...pc } = c; return json({ ...pc, rows: V.list, n: V.n, rank: V.rank, done: Date.now() > c.t1 });
  },
};

export default async (req, context) => {
  const u = new URL(req.url), ip = (context && context.ip) || "?";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: H });
  try {
    // krótkie linki otwierają grę
    let m = u.pathname.match(/^\/w\/([A-Za-z0-9]{6,12})\/?$/);
    if (m) { const s = await get("s/" + m[1]); return Response.redirect(new URL(s ? "/#w=" + s.d : "/?brak=wyzwania", req.url).href, 302); }
    m = u.pathname.match(/^\/z\/([A-Za-z0-9]{4,12})\/?$/);
    if (m) return Response.redirect(new URL("/#z=" + m[1], req.url).href, 302);
    m = u.pathname.match(/^\/api\/([a-z]+)(?:\/([A-Za-z0-9_.-]+))?\/?$/);
    const h = m && routes[req.method + " " + m[1]];
    if (!h) return err("Nieznany adres.", 404);
    const me = await who(req);
    return await h(req, ip, me, m[2]);
  } catch (e) {
    return err(e && e.status ? e.message : "Błąd serwera. Spróbuj za chwilę.", (e && e.status) || 500);
  }
};
