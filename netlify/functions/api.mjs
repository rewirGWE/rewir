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
const del = k => db().delete(k);
async function listKeys(prefix) { const r = await db().list({ prefix }); return (r && r.blobs || []).map(b => b.key); }

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
  return { list: a.slice(0, TOP).map(({ pid, ...x }) => ({ ...x, n: showN(pid, x.n), me: pid === me || undefined })), n: a.length, rank: me ? a.findIndex(x => x.pid === me) + 1 : 0 };
}
function sortSpeed(obj, me) {
  const a = Object.entries(obj || {}).map(([pid, x]) => ({ pid, ...x })).sort((x, y) => y.v - x.v || x.d - y.d);
  return { list: a.slice(0, TOP).map(({ pid, ...x }) => ({ ...x, n: showN(pid, x.n), me: pid === me || undefined })), n: a.length, rank: me ? a.findIndex(x => x.pid === me) + 1 : 0 };
}
/* ---------- Król zjazdu: najlepszy czas tygodnia (od poniedziałku, czas polski) ---------- */
export function weekKey(t) {
  const x = new Date(t + 3600e3), dow = (x.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate() - dow)).toISOString().slice(0, 10);
}
function kingOf(lb, now) {
  const w = lb && lb.week; if (!w || w.wk !== weekKey(now || Date.now())) return null;
  let best = null; for (const [pid, x] of Object.entries(w.times || {})) if (!best || x.t < best.t || (x.t === best.t && x.d < best.d)) best = { pid, ...x };
  return best;
}
function trackSum(tr, lb) {
  const T = sortTimes(lb || {}), V = sortSpeed((lb || {}).speed);
  const K = kingOf(lb);
  return { rid: tr.rid, name: tr.name, len: tr.len, drop: tr.drop, s: tr.wps[0], n: T.n, king: K ? { n: showN(K.pid, K.n), i: K.i, t: K.t } : null,
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
  await updRegion(tr, lb);
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
    if (limited("reg:" + ip, 20, 3600e3)) return err("Za dużo nowych graczy z tej sieci. Spróbuj za godzinę.", 429);
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
    return json({ tracks: all.filter(t => !HID.t[t.rid]).map(t => HID.t[t.rid] ? t : t).slice(0, 40) });
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
    // Król zjazdu (tydzień)
    const nowW = Date.now(), wk = weekKey(nowW), oldK = kingOf(lb, nowW);
    let newW = false, newKing = false;
    if (!lb.week || lb.week.wk !== wk) lb.week = { wk, times: {} };
    if (!ck.time && weekKey(run.d) === wk) {
      const cw = lb.week.times[me.pid];
      if (!cw || run.t < cw.t) { lb.week.times[me.pid] = { t: +run.t.toFixed(2), n: me.nick, i: me.icon, d: run.d }; newW = true; }
    }
    const K = kingOf(lb, nowW);
    if (newW && K && K.pid === me.pid && (!oldK || oldK.pid !== me.pid)) {
      newKing = true;
      const kg = (await get("kg/" + me.pid)) || {}; kg[rid] = { wk, name: tr.name }; await put("kg/" + me.pid, kg);
      if (oldK) { const og = (await get("kg/" + oldK.pid)) || {}; if (og[rid]) { delete og[rid]; await put("kg/" + oldK.pid, og); } }
    }
    if (newT || newV || newW) { await put("lb/" + rid, lb); await updIndex(tr, lb); }
    // zawody online na tej trasie
    const now = Date.now(), act = [];
    for (const cid of tr.cs || []) {
      const c = await get("c/" + cid); if (!c || now > c.t1 + 864e5) continue; act.push(cid);
      if (ck.speed || run.d < c.t0 || run.d > c.t1) continue;
      const cr = (await get("cr/" + cid)) || {};
      if (!cr[me.pid] || v > cr[me.pid].v) { cr[me.pid] = { v, n: me.nick, i: me.icon, d: run.d }; await put("cr/" + cid, cr); }
    }
    if (act.length !== (tr.cs || []).length) { tr.cs = act; await put("t/" + rid, tr); }
    // wspólny zjazd grupy
    let grp = null;
    if (b.g && b.race && !ck.time) {
      const g = await get("g/" + clean(b.g, 12)), race = g && (g.races || []).find(x => x.id === b.race);
      if (g && g.members[me.pid] && race && race.rid === rid && run.d >= race.t0 - 120e3 && run.d <= race.t0 + 3 * 3600e3) {
        const key = "gr/" + g.gid + "/" + me.pid, mine = (await get(key)) || {}, cur = mine[race.id];
        if (!cur || run.t < cur.t) { mine[race.id] = { t: +run.t.toFixed(2), v: ck.speed ? 0 : v }; await put(key, mine); }
        grp = { gid: g.gid, race: race.id };
      }
    }
    const T = sortTimes(lb, me.pid), V = sortSpeed(lb.speed, me.pid);
    return json({ ok: true, grp, newT, newV, rejected: ck.time || ck.speed ? ck : null, rankT: T.rank, rankV: V.rank, n: T.n, nV: V.n,
      newKing, king: K ? { n: showN(K.pid, K.n), i: K.i, t: K.t, me: K.pid === me.pid || undefined } : null, dethroned: newKing && oldK ? showN(oldK.pid, oldK.n) : undefined });
  },
  "GET lb": async (req, ip, me, arg) => {
    const rid = +arg, tr = await get("t/" + rid); if (!tr) return err("Tej trasy nie ma w rankingu online.", 404);
    const lb = (await get("lb/" + rid)) || {}, pid = me && me.pid;
    const K = kingOf(lb), wk = weekKey(Date.now());
    const week = lb.week && lb.week.wk === wk ? sortTimes({ times: lb.week.times }, pid) : { list: [], n: 0, rank: 0 };
    return json({ rid, name: HID.t[rid] ? "Trasa ukryta po zgłoszeniach" : tr.name, len: tr.len, drop: tr.drop, times: sortTimes(lb, pid), speed: sortSpeed(lb.speed, pid),
      king: K ? { n: showN(K.pid, K.n), i: K.i, t: K.t, me: K.pid === pid || undefined } : null, week, hidden: !!HID.t[rid] || undefined });
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

/* ---------- znajomi ---------- */
const normPid = x => String(x || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
const ONLINE = 3 * 60e3;
const pair = (a, b) => (a < b ? a + "_" + b : b + "_" + a);
const NEAR_KM = 30;
const cell5 = (lat, lng) => Math.floor(lat * 2) + "_" + Math.floor(lng * 2);   // kratka 0,5° (ok. 55 x 35 km)
const km = (a, b, c, d) => Math.hypot((c - a) * 111.32, (d - b) * 111.32 * Math.cos(a * Math.PI / 180));
async function canChat(from, to, reading) {
  if (!to || to.length !== 10 || from === to) return false;
  const [bt, bf] = await Promise.all([get("bl/" + to), get("bl/" + from)]);
  if ((bt && bt[from]) || (bf && bf[to] && !reading)) return false;
  const fr = (await get("f/" + from)) || {}; if (fr[to]) return true;
  const u = (await get("cu/" + from)) || {}; if (u[to]) return true;                 // ten gracz już do mnie pisał
  const pk = "cm/" + pair(from, to) + "/" + from; if (await get(pk)) return true;     // ja już do niego pisałem
  if (reading) return false;
  const [a, b] = await Promise.all([get("nm/" + from), get("nm/" + to)]), now = Date.now();
  return !!(a && b && now - a.t < 3600e3 && now - b.t < 3600e3 && km(a.lat, a.lng, b.lat, b.lng) <= NEAR_KM);
}
async function friendsOf(me) {
  const fr = Object.keys((await get("f/" + me.pid)) || {}), now = Date.now();
  const rows = await Promise.all(fr.map(async pid => { const [p, s] = await Promise.all([get("p/" + pid), get("s/" + pid)]);
    return p ? { code: pid, n: p.nick, i: p.icon, seen: s ? s.t : 0, online: !!(s && now - s.t < ONLINE) } : null; }));
  return { code: me.pid, friends: rows.filter(Boolean).sort((a, b) => (b.online - a.online) || (b.seen - a.seen)) };
}

/* ---------- grupy: wspólne zjazdy ---------- */
const GPRE = 3600e3, GPOST = 5 * 3600e3;                 // pozycje widać od godziny przed zbiórką do 5 h po
const inWin = (g, t) => t >= g.at - GPRE && t <= g.at + GPOST;
const RSVP = ["jade", "moze", "nie"];             // "zapr" = dodany przez znajomego, jeszcze nie odpowiedział
const GMAX = 10;                                         // najwyżej 10 osób w grupie
async function pgAdd(pid, gid) { const a = (await get("pg/" + pid)) || []; if (!a.includes(gid)) { a.unshift(gid); await put("pg/" + pid, a.slice(0, 40)); } }
async function pgDel(pid, gid) { const a = (await get("pg/" + pid)) || []; if (a.includes(gid)) await put("pg/" + pid, a.filter(x => x !== gid)); }
async function groupView(g, me) {
  const now = Date.now(), mid = me && me.pid;
  const members = Object.entries(g.members).map(([pid, x]) => ({ n: x.n, i: x.i, st: x.st, lead: pid === g.owner || undefined, me: pid === mid || undefined }));
  let pos = [];
  if (mid && g.members[mid] && inWin(g, now)) {
    const keys = await listKeys("gp/" + g.gid + "/");
    const all = await Promise.all(keys.map(k => get(k).then(v => [k.split("/").pop(), v])));
    pos = all.filter(([pid, v]) => v && g.members[pid] && now - v.t < 15 * 60e3)
      .map(([pid, v]) => ({ n: g.members[pid].n, i: g.members[pid].i, lat: v.lat, lng: v.lng, t: v.t, alert: v.alert || undefined, me: pid === mid || undefined }));
  }
  const races = (g.races || []).slice(-5);
  if (races.length) {
    const keys = await listKeys("gr/" + g.gid + "/");
    const res = await Promise.all(keys.map(k => get(k).then(v => [k.split("/").pop(), v || {}])));
    for (const r of races) {
      r.rows = res.filter(([pid, v]) => v[r.id] && g.members[pid]).map(([pid, v]) => ({ n: g.members[pid].n, i: g.members[pid].i, t: v[r.id].t, v: v[r.id].v, me: pid === mid || undefined }))
        .sort((a, b) => a.t - b.t);
    }
  }
  const { owner, members: _m, ...pub } = g;
  return { ...pub, members, pos, races, now, max: GMAX, member: !!(mid && g.members[mid]), lead: !!(mid && mid === owner) };
}
Object.assign(routes, {
  "POST group": async (req, ip, me) => {
    if (!me) return err("Brak lub zły kod gracza.", 401);
    if (limited("gc:" + me.pid, 10, 86400e3)) return err("Za dużo grup jednego dnia.", 429);
    const b = await body(req), at = +b.at, lat = +b.lat, lng = +b.lng, now = Date.now();
    if (!(at > now - 3600e3 && at < now + 60 * 864e5)) return err("Zła data zbiórki.");
    if (!fin(lat) || !fin(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return err("Złe miejsce zbiórki.");
    let rid = +b.rid || 0, rname = "";
    if (rid) { const tr = await get("t/" + rid); if (!tr) return err("Najpierw dodaj trasę do rankingu online."); rname = tr.name; }
    const gid = rnd(6), g = { gid, name: clean(b.name, 40) || "Wspólny zjazd", place: clean(b.place, 60), at, lat: +lat.toFixed(5), lng: +lng.toFixed(5), rid, rname,
      owner: me.pid, ownerNick: me.nick, created: now, members: { [me.pid]: { n: me.nick, i: me.icon, st: "jade", j: now } }, races: [] };
    await put("g/" + gid, g); await pgAdd(me.pid, gid);
    return json(await groupView(g, me));
  },
  "GET group": async (req, ip, me, arg) => {
    const g = await get("g/" + clean(arg, 12)); if (!g) return err("Nie ma takiej grupy.", 404);
    return json(await groupView(g, me));
  },
  "POST group join": async (req, ip, me, arg) => {
    if (!me) return err("Brak lub zły kod gracza.", 401);
    const g = await get("g/" + clean(arg, 12)); if (!g) return err("Nie ma takiej grupy.", 404);
    if (!g.members[me.pid]) {
      if (Object.keys(g.members).length >= GMAX) return err("Grupa jest pełna (" + GMAX + " osób).");
      g.members[me.pid] = { n: me.nick, i: me.icon, st: "jade", j: Date.now() }; await put("g/" + g.gid, g); await pgAdd(me.pid, g.gid);
    }
    return json(await groupView(g, me));
  },
  "POST group rsvp": async (req, ip, me, arg) => {
    if (!me) return err("Brak lub zły kod gracza.", 401);
    const g = await get("g/" + clean(arg, 12)); if (!g || !g.members[me.pid]) return err("Nie jesteś w tej grupie.", 403);
    const b = await body(req); if (!RSVP.includes(b.st)) return err("Zła odpowiedź.");
    g.members[me.pid].st = b.st; g.members[me.pid].n = me.nick; g.members[me.pid].i = me.icon; await put("g/" + g.gid, g);
    return json(await groupView(g, me));
  },
  "POST group leave": async (req, ip, me, arg) => {
    if (!me) return err("Brak lub zły kod gracza.", 401);
    const g = await get("g/" + clean(arg, 12)); if (!g || !g.members[me.pid]) return json({ ok: true });
    if (g.owner === me.pid && Object.keys(g.members).length > 1) return err("Lider nie może opuścić grupy, w której są inni.");
    delete g.members[me.pid]; await put("g/" + g.gid, g); await del("gp/" + g.gid + "/" + me.pid).catch(() => {}); await pgDel(me.pid, g.gid);
    return json({ ok: true });
  },
  "POST group pos": async (req, ip, me, arg) => {
    if (!me) return err("Brak lub zły kod gracza.", 401);
    const g = await get("g/" + clean(arg, 12)); if (!g || !g.members[me.pid]) return err("Nie jesteś w tej grupie.", 403);
    if (!inWin(g, Date.now())) return err("Pozycje widać tylko w czasie spotkania.", 409);
    if (limited("gp:" + me.pid, 40, 600e3)) return err("Za często.", 429);
    const b = await body(req), lat = +b.lat, lng = +b.lng;
    if (b.off) { await del("gp/" + g.gid + "/" + me.pid).catch(() => {}); return json({ ok: true }); }
    if (!fin(lat) || !fin(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return err("Złe współrzędne.");
    await put("gp/" + g.gid + "/" + me.pid, { lat: +lat.toFixed(5), lng: +lng.toFixed(5), t: Date.now(), alert: b.alert ? 1 : 0 });
    return json({ ok: true, now: Date.now() });
  },
  "POST group start": async (req, ip, me, arg) => {
    if (!me) return err("Brak lub zły kod gracza.", 401);
    const g = await get("g/" + clean(arg, 12)); if (!g) return err("Nie ma takiej grupy.", 404);
    if (g.owner !== me.pid) return err("Start odpala tylko lider grupy.", 403);
    const b = await body(req), rid = +b.rid || g.rid, tr = rid && (await get("t/" + rid));
    if (!tr) return err("Wybierz trasę zjazdu (musi być w rankingu online).");
    const last = (g.races || []).slice(-1)[0];
    if (last && Date.now() - last.t0 < 60e3) return err("Odliczanie już trwa.");
    const race = { id: rnd(4), rid, name: tr.name, t0: Date.now() + 15000 };
    g.races = [...(g.races || []), race].slice(-10); await put("g/" + g.gid, g);
    return json(await groupView(g, me));
  },

  "POST group add": async (req, ip, me, arg) => {
    if (!me) return err("Brak lub zły kod gracza.", 401);
    const g = await get("g/" + clean(arg, 12)); if (!g || !g.members[me.pid]) return err("Nie jesteś w tej grupie.", 403);
    const b = await body(req), fp = normPid(b.code), fr = (await get("f/" + me.pid)) || {};
    if (!fr[fp]) return err("Do grupy dodasz tylko kogoś ze swoich znajomych.");
    if (g.members[fp]) return json(await groupView(g, me));
    if (Object.keys(g.members).length >= GMAX) return err("Grupa jest pełna (" + GMAX + " osób).");
    const p = await get("p/" + fp); if (!p) return err("Nie ma takiego gracza.", 404);
    g.members[fp] = { n: p.nick, i: p.icon, st: "zapr", j: Date.now(), by: me.nick }; await put("g/" + g.gid, g); await pgAdd(fp, g.gid);
    return json(await groupView(g, me));
  },

  /* ---------- znajomi i status online ---------- */
  "POST hello": async (req, ip, me) => {                     // sygnał „jestem w grze” + lista znajomych i grup
    if (!me) return err("Brak lub zły kod gracza.", 401);
    const now = Date.now(), last = hits.get("hl:" + me.pid);
    if (!last || now - last[0] > 45e3) { hits.set("hl:" + me.pid, [now]); await put("s/" + me.pid, { t: now }); }
    return json({ ...(await friendsOf(me)), groups: (await get("pg/" + me.pid)) || [], unread: (await get("cu/" + me.pid)) || {}, now });
  },
  "POST friend": async (req, ip, me) => {
    if (!me) return err("Brak lub zły kod gracza.", 401);
    if (limited("fr:" + me.pid, 30, 3600e3)) return err("Za dużo prób.", 429);
    const b = await body(req), fp = normPid(b.code);
    if (fp === me.pid) return err("To Twój własny kod.");
    const p = fp.length === 10 && (await get("p/" + fp)); if (!p) return err("Nie ma gracza z takim kodem.", 404);
    const a = (await get("f/" + me.pid)) || {}, c = (await get("f/" + fp)) || {};
    if (Object.keys(a).length >= 100 || Object.keys(c).length >= 100) return err("Za dużo znajomych (najwyżej 100).");
    a[fp] = { t: Date.now() }; c[me.pid] = { t: Date.now() }; await put("f/" + me.pid, a); await put("f/" + fp, c);
    return json({ ok: true, ...pub(p) });
  },
  "POST friend remove": async (req, ip, me, arg) => {
    if (!me) return err("Brak lub zły kod gracza.", 401);
    const fp = normPid(arg), a = (await get("f/" + me.pid)) || {}, c = (await get("f/" + fp)) || {};
    delete a[fp]; delete c[me.pid]; await put("f/" + me.pid, a); await put("f/" + fp, c);
    return json({ ok: true });
  },

  /* ---------- czat ze znajomymi ---------- */
  "POST chat": async (req, ip, me, arg) => {
    if (!me) return err("Brak lub zły kod gracza.", 401);
    const fp = normPid(arg);
    if (!(await canChat(me.pid, fp))) return err("Pisać możesz do znajomych i do graczy w promieniu 30 km, którzy są widoczni na mapie.", 403);
    if (limited("ch:" + me.pid, 30, 60e3)) return err("Za szybko. Odczekaj chwilę.", 429);
    const b = await body(req), x = String(b.x || "").replace(/[\u0000-\u0008\u000b-\u001f]/g, "").trim().slice(0, 500);
    if (!x) return err("Pusta wiadomość.");
    const key = "cm/" + pair(me.pid, fp) + "/" + me.pid, a = (await get(key)) || [], t = Date.now();
    a.push({ t, x }); await put(key, a.slice(-100));
    const u = (await get("cu/" + fp)) || {}; u[me.pid] = { t, n: me.nick, i: me.icon }; await put("cu/" + fp, u);
    return json({ ok: true, t });
  },
  "GET chat": async (req, ip, me, arg) => {
    if (!me) return err("Brak lub zły kod gracza.", 401);
    const fp = normPid(arg);
    if (!(await canChat(me.pid, fp, true))) return err("Ta rozmowa nie jest dostępna.", 403);
    const pk = "cm/" + pair(me.pid, fp) + "/", [mine, theirs] = await Promise.all([get(pk + me.pid), get(pk + fp)]);
    const msgs = [...(mine || []).map(m => ({ ...m, me: true })), ...(theirs || [])].sort((a, b) => a.t - b.t).slice(-100);
    return json({ msgs, now: Date.now() });
  },

  "POST block": async (req, ip, me, arg) => {
    if (!me) return err("Brak lub zły kod gracza.", 401);
    const fp = normPid(arg), bl = (await get("bl/" + me.pid)) || {}; bl[fp] = Date.now(); await put("bl/" + me.pid, bl);
    const a = (await get("f/" + me.pid)) || {}, c = (await get("f/" + fp)) || {};
    if (a[fp] || c[me.pid]) { delete a[fp]; delete c[me.pid]; await put("f/" + me.pid, a); await put("f/" + fp, c); }
    const u = (await get("cu/" + me.pid)) || {}; if (u[fp]) { delete u[fp]; await put("cu/" + me.pid, u); }
    return json({ ok: true });
  },

  /* ---------- gracze w okolicy (do 30 km) ---------- */
  "POST near": async (req, ip, me) => {
    if (!me) return err("Brak lub zły kod gracza.", 401);
    if (limited("nb:" + me.pid, 40, 600e3)) return err("Za często.", 429);
    const b = await body(req), old = await get("nm/" + me.pid);
    const dropOld = async c => { const ix = (await get("nb/" + c)) || {}; if (ix[me.pid]) { delete ix[me.pid]; await put("nb/" + c, ix); } };
    if (b.off) { if (old) { await dropOld(old.c); await del("nm/" + me.pid).catch(() => {}); } return json({ ok: true, off: true, players: [] }); }
    const lat = +b.lat, lng = +b.lng;
    if (!fin(lat) || !fin(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return err("Złe współrzędne.");
    const now = Date.now(), c = cell5(lat, lng), v = { n: me.nick, i: me.icon, lat: +lat.toFixed(3), lng: +lng.toFixed(3), t: now };
    if (old && old.c !== c) await dropOld(old.c);
    await put("nm/" + me.pid, { ...v, c });
    const ix = (await get("nb/" + c)) || {}; ix[me.pid] = v;
    for (const k of Object.keys(ix)) if (now - ix[k].t > 2 * 3600e3) delete ix[k];
    await put("nb/" + c, ix);
    const [cy, cx] = c.split("_").map(Number), keys = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) keys.push("nb/" + (cy + dy) + "_" + (cx + dx));
    const bl = (await get("bl/" + me.pid)) || {}, out = [];
    for (const m of await Promise.all(keys.map(get))) for (const [pid, x] of Object.entries(m || {})) {
      if (pid === me.pid || bl[pid] || now - x.t > 30 * 60e3) continue;
      const d = km(lat, lng, x.lat, x.lng); if (d <= NEAR_KM) out.push({ code: pid, n: showN(pid, x.n), i: x.i, lat: x.lat, lng: x.lng, t: x.t, km: +d.toFixed(1) });
    }
    out.sort((a, b) => a.km - b.km);
    return json({ ok: true, players: out.slice(0, 100), now });
  },

  /* ---------- moja wioska dla znajomych (dokładne położenie widzą tylko znajomi) ---------- */
  "POST myvillage": async (req, ip, me) => {
    if (!me) return err("Brak lub zły kod gracza.", 401);
    if (limited("mv:" + me.pid, 30, 3600e3)) return err("Za często.", 429);
    const b = await body(req), num = (x, a, z) => Math.max(a, Math.min(z, Math.round(+x || 0)));
    if (b.off) { await del("vf/" + me.pid).catch(() => {}); return json({ ok: true }); }
    const lat = +b.lat, lng = +b.lng;
    if (!fin(lat) || !fin(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return err("Złe współrzędne.");
    await put("vf/" + me.pid, { lat: +lat.toFixed(5), lng: +lng.toFixed(5), name: clean(b.name, 30), lvl: num(b.lvl, 1, 999), cells: num(b.cells, 0, 99999),
      wave: num(b.wave, 0, 99999), wall: num(b.wall, 0, 100), era: clean(b.era, 20), t: Date.now() });
    return json({ ok: true });
  },
  "GET fvillages": async (req, ip, me) => {
    if (!me) return err("Brak lub zły kod gracza.", 401);
    const fr = Object.keys((await get("f/" + me.pid)) || {}), now = Date.now();
    const rows = await Promise.all(fr.map(async pid => { const [p, v, st] = await Promise.all([get("p/" + pid), get("vf/" + pid), get("s/" + pid)]);
      return p && v ? { code: pid, n: p.nick, i: p.icon, ...v, online: !!(st && now - st.t < ONLINE) } : null; }));
    return json({ villages: rows.filter(Boolean), now });
  },

  /* ---------- wioski graczy na mapie ---------- */
  "POST village": async (req, ip, me) => {
    if (!me) return err("Brak lub zły kod gracza.", 401);
    if (limited("vl:" + me.pid, 30, 3600e3)) return err("Za często.", 429);
    const b = await body(req), old = await get("v/" + me.pid);
    const drop = async c => { const ix = (await get("vx/" + c)) || {}; if (ix[me.pid]) { delete ix[me.pid]; await put("vx/" + c, ix); } };
    if (b.off) { if (old) { await drop(old.c); await del("v/" + me.pid).catch(() => {}); } return json({ ok: true, off: true }); }
    const lat = +b.lat, lng = +b.lng;
    if (!fin(lat) || !fin(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return err("Złe współrzędne.");
    const num = (x, a, z) => Math.max(a, Math.min(z, Math.round(+x || 0)));
    const c = cellOf(lat, lng), v = { n: me.nick, i: me.icon, lat: +lat.toFixed(4), lng: +lng.toFixed(4), lvl: num(b.lvl, 1, 999), cells: num(b.cells, 0, 99999),
      wave: num(b.wave, 0, 99999), wall: num(b.wall, 0, 100), era: clean(b.era, 20), name: clean(b.name, 30), t: Date.now() };
    if (old && old.c !== c) await drop(old.c);
    await put("v/" + me.pid, { ...v, c });
    const ix = (await get("vx/" + c)) || {}; ix[me.pid] = v; await put("vx/" + c, ix);
    return json({ ok: true });
  },
  "GET villages": async (req, ip, me) => {
    const u = new URL(req.url), lat = +u.searchParams.get("lat"), lng = +u.searchParams.get("lng");
    if (!fin(lat) || !fin(lng)) return err("Podaj lat i lng.");
    const cy = Math.floor(lat * 10), cx = Math.floor(lng * 10), keys = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) keys.push("vx/" + (cy + dy) + "_" + (cx + dx));
    const now = Date.now(), out = [];
    for (const ix of await Promise.all(keys.map(get))) for (const [pid, v] of Object.entries(ix || {}))
      if (now - v.t < 30 * 864e5) out.push({ ...v, n: showN(pid, v.n), me: me && pid === me.pid || undefined });
    return json({ villages: out.slice(0, 200), now });
  },
});

routes["GET crowns"] = async (req, ip, me) => {
  if (!me) return err("Brak lub zły kod gracza.", 401);
  const kg = (await get("kg/" + me.pid)) || {}, wk = weekKey(Date.now()), out = [];
  for (const [rid, x] of Object.entries(kg)) if (x.wk === wk) out.push({ rid: +rid, name: x.name });
  return json({ crowns: out, wk });
};

/* ---------- usunięcie konta i wszystkich danych gracza (RODO) ---------- */
routes["POST forget"] = async (req, ip, me) => {
  if (!me) return err("Brak lub zły kod gracza.", 401);
  if (limited("fg:" + ip, 5, 3600e3)) return err("Za dużo prób. Spróbuj za godzinę.", 429);
  const b = await body(req); if (b.confirm !== "USUN") return err("Brak potwierdzenia.");
  const pid = me.pid, quiet = p => p.catch(() => {});
  // znajomi i nieprzeczytane
  const fr = (await get("f/" + pid)) || {};
  for (const fp of Object.keys(fr)) { const c = (await get("f/" + fp)) || {}; if (c[pid]) { delete c[pid]; await put("f/" + fp, c); } }
  // rozmowy: moje wiadomości i ślad nieprzeczytanych u innych
  for (const k of await listKeys("cm/")) {
    const parts = k.split("/"), pr = (parts[1] || "").split("_");
    if (!pr.includes(pid)) continue;
    if (parts[2] === pid) await quiet(del(k));
    const other = pr[0] === pid ? pr[1] : pr[0], u = (await get("cu/" + other)) || {};
    if (u[pid]) { delete u[pid]; await put("cu/" + other, u); }
  }
  // grupy
  for (const gid of (await get("pg/" + pid)) || []) {
    const g = await get("g/" + gid); if (!g) continue;
    delete g.members[pid]; await quiet(del("gp/" + gid + "/" + pid)); await quiet(del("gr/" + gid + "/" + pid));
    const left = Object.keys(g.members);
    if (!left.length) { await quiet(del("g/" + gid)); continue; }
    if (g.owner === pid) { g.owner = left[0]; g.ownerNick = g.members[left[0]].n; }
    await put("g/" + gid, g);
  }
  // gracze w okolicy i wioski na mapie
  const nm = await get("nm/" + pid); if (nm) { const ix = (await get("nb/" + nm.c)) || {}; if (ix[pid]) { delete ix[pid]; await put("nb/" + nm.c, ix); } }
  const v = await get("v/" + pid); if (v) { const ix = (await get("vx/" + v.c)) || {}; if (ix[pid]) { delete ix[pid]; await put("vx/" + v.c, ix); } }
  // rankingi i zawody
  for (const k of await listKeys("lb/")) {
    const lb = await get(k); if (!lb) continue; let ch = false;
    if (lb.times && lb.times[pid]) { delete lb.times[pid]; ch = true; }
    if (lb.speed && lb.speed[pid]) { delete lb.speed[pid]; ch = true; }
    if (lb.week && lb.week.times && lb.week.times[pid]) { delete lb.week.times[pid]; ch = true; }
    if (ch) { await put(k, lb); const tr = await get("t/" + k.slice(3)); if (tr) await updIndex(tr, lb); }
  }
  for (const k of await listKeys("cr/")) { const cr = await get(k); if (cr && cr[pid]) { delete cr[pid]; await put(k, cr); } }
  // trasy gracza zostają w rankingu innych, ale bez autora
  for (const k of await listKeys("t/")) { const tr = await get(k); if (tr && tr.owner === pid) { tr.owner = null; tr.ownerNick = ""; await put(k, tr); } }
  for (const k of await listKeys("c/")) { const c = await get(k); if (c && c.owner === pid) { c.owner = null; c.ownerNick = ""; await put(k, c); } }
  // własne klucze
  const key = normKey(req.headers.get("x-rewir-key"));
  for (const k of ["kg/", "f/", "cu/", "bl/", "nm/", "v/", "vf/", "pg/", "s/", "p/"]) await quiet(del(k + pid));
  await quiet(del("k/" + (await sha(key))));
  return json({ ok: true, deleted: true });
};

/* ---------- zakup gry: Stripe → kod → aktywacja na maks. 3 urządzeniach ----------
   Na Netlify ustaw zmienne środowiskowe:
   STRIPE_SECRET_KEY   – klucz z panelu Stripe (najlepiej „restricted”, tylko odczyt Checkout Sessions)
   STRIPE_PAYMENT_LINK – (opcjonalnie) id linku płatności plink_…, żeby kody wydawać tylko za ten produkt */
const LIC_DEV = 3, LIC_IDLE = 30 * 864e5;
const STRIPE = () => (process.env.STRIPE_API || "https://api.stripe.com");
const newLic = () => "RW-" + rnd(4) + "-" + rnd(4) + "-" + rnd(4);
const normLic = k => { const s = String(k || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); const t = s.startsWith("RW") ? s.slice(2) : s; return t.length === 12 ? "RW-" + t.slice(0, 4) + "-" + t.slice(4, 8) + "-" + t.slice(8) : ""; };
const devOk = d => /^[a-z0-9]{8,40}$/i.test(String(d || ""));
async function licGet(kod) { const k = normLic(kod); if (!k) return null; return await get("lk/" + (await sha(k))); }
async function licPut(L) { await put("lk/" + (await sha(L.kod)), L); }

routes["GET zakup"] = async (req, ip) => {
  if (limited("zk:" + ip, 20, 600e3)) return err("Za dużo prób. Spróbuj za kilka minut.", 429);
  const id = new URL(req.url).searchParams.get("sesja") || "";
  if (!/^cs_(test|live)_[A-Za-z0-9]{10,240}$/.test(id)) return err("Brak numeru płatności.");
  const was = await get("lz/" + id); if (was && was.kod) return json({ ok: true, kod: was.kod, ponownie: true });
  const sk = process.env.STRIPE_SECRET_KEY; if (!sk) return err("Sprzedaż nie jest jeszcze skonfigurowana.", 503);
  const r = await fetch(STRIPE() + "/v1/checkout/sessions/" + encodeURIComponent(id), { headers: { authorization: "Bearer " + sk } });
  if (r.status === 404) return err("Nie znaleziono takiej płatności.", 404);
  if (!r.ok) return err("Nie udało się sprawdzić płatności. Spróbuj za chwilę.", 502);
  const s = await r.json();
  if (s.status !== "complete" || s.payment_status !== "paid") return err("Płatność nie jest jeszcze zakończona. Odśwież stronę za chwilę.", 402);
  const pl = process.env.STRIPE_PAYMENT_LINK; if (pl && s.payment_link !== pl) return err("Ta płatność nie dotyczy gry Rewir.", 403);
  const L = { kod: newLic(), t: Date.now(), sesja: id, email: clean(s.customer_details && s.customer_details.email, 120), kwota: s.amount_total || 0, waluta: s.currency || "", devs: {} };
  const ref = normPid(s.client_reference_id || "");
  if (ref.length === 10 && (await get("p/" + ref))) { L.ref = ref; const r = (await get("rf/" + ref)) || { n: 0, pend: 0 }; r.n++; r.pend++; await put("rf/" + ref, r); }
  await licPut(L); await put("lz/" + id, { kod: L.kod, t: L.t });
  return json({ ok: true, kod: L.kod });
};

routes["POST aktywuj"] = async (req, ip) => {
  if (limited("ak:" + ip, 15, 600e3)) return err("Za dużo prób. Spróbuj za kilka minut.", 429);
  const b = await body(req), L = await licGet(b.kod);
  if (!L || L.off) return err("Nie ma takiego kodu. Sprawdź, czy przepisałeś go dokładnie.", 404);
  if (!devOk(b.dev)) return err("Złe urządzenie.");
  const now = Date.now(), D = L.devs || (L.devs = {});
  if (!D[b.dev]) {
    const ids = Object.keys(D);
    if (ids.length >= LIC_DEV) {
      const old = ids.sort((a, c) => D[a] - D[c])[0];
      if (now - D[old] > LIC_IDLE) delete D[old];
      else return err("Ten kod działa już na " + LIC_DEV + " urządzeniach. Nieużywane urządzenie zwalnia miejsce po 30 dniach.", 409);
    }
  }
  D[b.dev] = now; let bonus = 0; if (L.ref && !L.bonus) { L.bonus = now; bonus = 200; }
  await licPut(L);
  return json({ ok: true, kod: L.kod, urz: Object.keys(D).length, max: LIC_DEV, bonus });
};

routes["GET licencja"] = async (req, ip) => {
  if (limited("lc:" + ip, 60, 600e3)) return err("Za dużo prób.", 429);
  const q = new URL(req.url).searchParams, L = await licGet(q.get("kod")), dev = q.get("dev");
  if (!L || L.off) return json({ ok: false });
  if (!devOk(dev) || !(L.devs || {})[dev]) return json({ ok: false, aktywuj: true });
  L.devs[dev] = Date.now(); await licPut(L);
  return json({ ok: true });
};

/* =====================================================================
   v190: moderacja, zgłoszenia, powiadomienia push, ranking okolicy, polecenia
   ===================================================================== */

/* ---------- filtr wulgaryzmów (PL + najczęstsze EN), odporny na „k*rwa”, „kurrrwa”, „ku.rwa”, „qrwa”, „h00j” ---------- */
const BADW = ["kurw", "qrw", "chuj", "huj", "jeban", "jebac", "jebie", "jebi", "jebn", "zajeb", "wyjeb", "przyjeb", "odjeb", "pojeb", "rozjeb",
  "pierdol", "pierdal", "spierd", "wypierd", "pizd", "kutas", "fiut", "cwel", "ciota", "dziwk", "szmat", "suka", "sukinsyn", "debil", "kretyn", "ruchac", "ruchan",
  "fuck", "shit", "bitch", "cunt", "nigg", "faggot", "whore", "hitler", "nazi"];
const SAFE = ["debiut"];   // słowa, które zawierają „zakazany” rdzeń, a są niewinne
function normTxt(s) {
  const map = { "ą": "a", "ć": "c", "ę": "e", "ł": "l", "ń": "n", "ó": "o", "ś": "s", "ź": "z", "ż": "z", "0": "o", "1": "i", "!": "i", "3": "e", "4": "a", "@": "a", "5": "s", "$": "s", "7": "t", "8": "b", "v": "w", "x": "ks" };
  let t = String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
  t = t.replace(/[ąćęłńóśźż01!34@5$78vx]/g, c => map[c] || c).replace(/[^a-z]/g, "").replace(/(.)\1+/g, "$1");
  return t;
}
export function isBad(s) {
  const t = normTxt(s); if (!t) return false;
  let u = t; for (const w of SAFE) u = u.split(w).join("_");
  return BADW.some(w => u.includes(w.replace(/(.)\1+/g, "$1")));
}
export function maskBad(s) {
  return String(s || "").replace(/[^\s.,!?;:()"'-]+/g, w => (isBad(w) ? w[0] + "*".repeat(Math.max(2, w.length - 1)) : w));
}
const BAD_MSG = "Ta nazwa zawiera niedozwolone słowo. Wybierz inną.";
/* sprawdza pola żądania przed właściwą obsługą (bez zmian w starym kodzie) */
function guard(name, reject, maskF, fix) {
  const orig = routes[name]; if (!orig) return;
  routes[name] = async (req, ip, me, arg) => {
    const t = await req.text(); if (t.length > MAXBODY) return err("Za duże dane.", 413);
    let o = {}; try { o = JSON.parse(t || "{}") || {}; } catch { return err("Złe dane."); }
    for (const f of reject || []) if (o[f] && isBad(o[f])) return err(BAD_MSG);
    for (const f of maskF || []) if (typeof o[f] === "string") o[f] = maskBad(o[f]);
    for (const [f, v] of Object.entries(fix || {})) if (o[f] && isBad(o[f])) o[f] = v;
    if (name === "POST chat" && me && HID.m[me.pid]) return err("Twój czat jest wyłączony po zgłoszeniach innych graczy.", 403);
    if (name === "POST profile" && me && HID.p[me.pid] && o.nick && !isBad(o.nick) && clean(o.nick, 20) !== me.nick) {   // nowa, czysta ksywka zdejmuje ukrycie
      const h = (await get("mod/h")) || { p: {}, t: {}, m: {} }; delete h.p[me.pid]; await put("mod/h", h); HID = h;
    }
    return orig(new Request(req.url, { method: req.method, headers: req.headers, body: JSON.stringify(o) }), ip, me, arg);
  };
}
guard("POST register", ["nick"]); guard("POST profile", ["nick"]);
guard("POST track", ["name"]); guard("POST group", ["name", "place"]);
guard("POST chat", null, ["x"]);
guard("POST village", null, null, { name: "Wioska" }); guard("POST myvillage", null, null, { name: "Wioska" });

/* ---------- ukryci gracze, trasy i wyciszony czat (wczytywane raz na żądanie) ---------- */
let HID = { p: {}, t: {}, m: {} }, HIDt = 0;
async function loadHid() { if (Date.now() - HIDt < 30e3) return; HIDt = Date.now(); HID = Object.assign({ p: {}, t: {}, m: {} }, (await get("mod/h")) || {}); }
const HNICK = "Gracz (ukryty)";
const showN = (pid, n) => (HID.p[pid] ? HNICK : n);

/* ---------- zgłoszenia ---------- */
const REP_N = 3;   // tylu różnych graczy musi zgłosić, żeby coś zniknęło
routes["POST report"] = async (req, ip, me) => {
  if (!me) return err("Dołącz do gry online, żeby zgłaszać.", 401);
  if (limited("rp:" + me.pid, 20, 3600e3)) return err("Za dużo zgłoszeń. Spróbuj później.", 429);
  const b = await body(req), kind = String(b.kind || "");
  let typ = "", id = "", label = "";
  if (kind === "trasa") { const rid = +b.rid, tr = await get("t/" + rid); if (!tr) return err("Nie ma takiej trasy.", 404); typ = "t"; id = String(rid); label = tr.name; }
  else if (kind === "wynik") {   // wpis w rankingu: szukamy gracza po ksywce i czasie
    const lb = await get("lb/" + +b.rid); const e = lb && Object.entries(lb.times || {}).find(([p, x]) => x.n === b.n && Math.abs(x.t - +b.t) < 0.01);
    if (!e) return err("Nie znaleziono tego wyniku.", 404); typ = "p"; id = e[0]; label = e[1].n;
  } else if (kind === "wiad") {  // wiadomość na czacie: sprawdzamy, że naprawdę jest w rozmowie
    const fp = normPid(b.code), a = (await get("cm/" + pair(me.pid, fp) + "/" + fp)) || [], m = a.find(x => x.t === +b.t);
    if (!m) return err("Nie znaleziono tej wiadomości.", 404); typ = "m"; id = fp; label = m.x.slice(0, 120);
    const bl = (await get("bl/" + me.pid)) || {}; bl[fp] = Date.now(); await put("bl/" + me.pid, bl);   // zgłaszający od razu blokuje
  } else if (kind === "gracz") { const fp = normPid(b.code), p = await get("p/" + fp); if (!p) return err("Nie ma takiego gracza.", 404); typ = "p"; id = fp; label = p.nick; }
  else return err("Złe zgłoszenie.");
  if (id === me.pid) return err("Nie możesz zgłosić siebie.");
  const key = "rp/" + typ + "/" + id, r = (await get(key)) || { by: {}, label: "", t: 0 };
  r.by[me.pid] = Date.now(); r.label = clean(label, 120); r.t = Date.now(); r.why = clean(b.why, 80) || r.why || "";
  await put(key, r);
  const n = Object.keys(r.by).length; let hidden = false;
  if (n >= REP_N) {
    const h = (await get("mod/h")) || { p: {}, t: {}, m: {} };
    if (!h[typ][id]) { h[typ][id] = Date.now(); await put("mod/h", h); HID = h; hidden = true; }
  }
  return json({ ok: true, hidden, blocked: typ === "m" || undefined });
};

/* ---------- panel moderatora (ADMIN_KEY w zmiennych środowiskowych Netlify) ---------- */
const adminOk = k => { const a = process.env.ADMIN_KEY || ""; return a.length >= 12 && String(k || "") === a; };
routes["GET mod"] = async (req, ip) => {
  if (limited("ad:" + ip, 30, 600e3)) return err("Za dużo prób.", 429);
  if (!adminOk(new URL(req.url).searchParams.get("klucz"))) return err("Zły klucz moderatora.", 403);
  const keys = await listKeys("rp/"), rows = [];
  for (const k of keys) { const r = await get(k); if (!r) continue; const [, typ, id] = k.split("/"); rows.push({ typ, id, label: r.label, n: Object.keys(r.by || {}).length, t: r.t, why: r.why || "" }); }
  rows.sort((a, b) => b.t - a.t);
  return json({ reports: rows.slice(0, 300), hidden: (await get("mod/h")) || { p: {}, t: {}, m: {} } });
};
routes["POST mod"] = async (req, ip) => {
  if (limited("ad:" + ip, 30, 600e3)) return err("Za dużo prób.", 429);
  const b = await body(req); if (!adminOk(b.klucz)) return err("Zły klucz moderatora.", 403);
  if (b.co === "region") { let n = 0; for (const k of await listKeys("t/")) { const tr = await get(k); if (tr && tr.wps) { await updRegion(tr, await get("lb/" + tr.rid)); n++; } } return json({ ok: true, tracks: n }); }
  const typ = ["p", "t", "m"].includes(b.typ) ? b.typ : "", id = clean(b.id, 20); if (!typ || !id) return err("Złe dane.");
  const h = (await get("mod/h")) || { p: {}, t: {}, m: {} };
  if (b.co === "ukryj") h[typ][id] = Date.now(); else if (b.co === "pokaz") { delete h[typ][id]; await del("rp/" + typ + "/" + id).catch(() => {}); }
  else if (b.co === "odrzuc") { await del("rp/" + typ + "/" + id).catch(() => {}); return json({ ok: true }); }
  else return err("Nieznana akcja.");
  await put("mod/h", h); HID = h; HIDt = Date.now();
  return json({ ok: true, hidden: h });
};

/* ---------- powiadomienia push (klucze VAPID tworzą się same i leżą w Blobs) ---------- */
let WP = null, VAP = null;
async function wpLib() {
  if (WP === false) return null;
  if (!WP) { try { WP = (await import("web-push")).default; } catch { WP = false; return null; } }
  if (!VAP) { VAP = await get("vapid"); if (!VAP) { VAP = WP.generateVAPIDKeys(); await put("vapid", VAP); } }
  return WP;
}
const PKINDS = ["rekord", "czat", "znaj", "grupa"];
routes["GET pushkey"] = async () => { const w = await wpLib(); if (!w) return err("Powiadomienia nie są dostępne na serwerze.", 503); return json({ key: VAP.publicKey }); };
routes["POST push"] = async (req, ip, me) => {
  if (!me) return err("Dołącz do gry online, żeby włączyć powiadomienia.", 401);
  if (limited("pu:" + me.pid, 30, 3600e3)) return err("Za często.", 429);
  const b = await body(req), key = "ps/" + me.pid, cur = (await get(key)) || { subs: [], on: {} };
  if (b.off) { cur.subs = cur.subs.filter(s => s.endpoint !== b.endpoint); }
  else if (b.sub) {
    const s = b.sub; if (!s || typeof s.endpoint !== "string" || !/^https:\/\//.test(s.endpoint) || s.endpoint.length > 1000 || !s.keys || !s.keys.p256dh || !s.keys.auth) return err("Zła subskrypcja.");
    cur.subs = [{ endpoint: s.endpoint, keys: { p256dh: String(s.keys.p256dh).slice(0, 200), auth: String(s.keys.auth).slice(0, 100) }, t: Date.now() }, ...cur.subs.filter(x => x.endpoint !== s.endpoint)].slice(0, 3);
  }
  if (b.on && typeof b.on === "object") for (const k of PKINDS) if (k in b.on) cur.on[k] = b.on[k] ? 1 : 0;
  await put(key, cur);
  return json({ ok: true, subs: cur.subs.length, on: Object.fromEntries(PKINDS.map(k => [k, cur.on[k] !== 0])) });
};
async function notify(pid, kind, msg) {
  try {
    const ps = await get("ps/" + pid); if (!ps || !ps.subs || !ps.subs.length || ps.on[kind] === 0) return;
    const w = await wpLib(); if (!w) return;
    const opts = { vapidDetails: { subject: "https://rewir-gra.netlify.app", publicKey: VAP.publicKey, privateKey: VAP.privateKey }, TTL: 12 * 3600, timeout: 4000 };
    const payload = JSON.stringify({ title: msg.title, body: msg.body, url: msg.url || "/", tag: msg.tag || kind });
    let dead = [];
    await Promise.race([Promise.all(ps.subs.map(s => w.sendNotification(s, payload, opts).catch(e => { if (e && (e.statusCode === 404 || e.statusCode === 410)) dead.push(s.endpoint); }))), new Promise(r => setTimeout(r, 5000))]);
    if (dead.length) { ps.subs = ps.subs.filter(s => !dead.includes(s.endpoint)); await put("ps/" + pid, ps); }
  } catch { }
}
const fmtS = t => { const m = Math.floor(t / 60), s = t - m * 60; return (m ? m + ":" + (s < 10 ? "0" : "") : "") + s.toFixed(1).replace(".", ",") + (m ? "" : " s"); };
/* zdarzenia: pobity rekord trasy, wiadomość, nowy znajomy, zaproszenie do grupy */
{
  const oRun = routes["POST run"];
  routes["POST run"] = async (req, ip, me, arg) => {
    const t = await req.text(); let rid = 0; try { rid = +JSON.parse(t).rid; } catch { }
    const before = me && rid ? await get("lb/" + rid) : null;
    const lead = lb => { let b = null; for (const [p, x] of Object.entries((lb && lb.times) || {})) if (!b || x.t < b.x.t) b = { p, x }; return b; };
    const L0 = lead(before);
    const res = await oRun(new Request(req.url, { method: req.method, headers: req.headers, body: t }), ip, me, arg);
    try {
      if (me && res.status === 200 && L0 && L0.p !== me.pid) {
        const after = await get("lb/" + rid), L1 = lead(after);
        if (L1 && L1.p === me.pid) { const tr = await get("t/" + rid);
          await notify(L0.p, "rekord", { title: "🏁 Ktoś pobił Twój rekord", body: showN(me.pid, me.nick) + " przejechał „" + (tr ? tr.name : "trasę") + "” w " + fmtS(L1.x.t) + ". Odbijesz?", url: "/?go=rec", tag: "rekord-" + rid }); }
      }
    } catch { }
    return res;
  };
  const oChat = routes["POST chat"];
  routes["POST chat"] = async (req, ip, me, arg) => {
    const res = await oChat(req, ip, me, arg);
    try {
      if (me && res.status === 200) { const fp = normPid(arg), st = await get("s/" + fp), now = Date.now();
        if (!(st && now - st.t < 120e3) && !limited("pn:" + me.pid + fp, 1, 600e3))
          await notify(fp, "czat", { title: "💬 " + showN(me.pid, me.nick), body: "Nowa wiadomość w Rewirze", url: "/?go=friends", tag: "czat-" + me.pid }); }
    } catch { }
    return res;
  };
  const oFr = routes["POST friend"];
  routes["POST friend"] = async (req, ip, me, arg) => {
    const t = await req.text(); const res = await oFr(new Request(req.url, { method: req.method, headers: req.headers, body: t }), ip, me, arg);
    try { if (me && res.status === 200) { const fp = normPid(JSON.parse(t).code); await notify(fp, "znaj", { title: "🤝 Nowy znajomy", body: showN(me.pid, me.nick) + " dodał Cię do znajomych w Rewirze.", url: "/?go=friends", tag: "znaj" }); } } catch { }
    return res;
  };
  const oGa = routes["POST group add"];
  routes["POST group add"] = async (req, ip, me, arg) => {
    const t = await req.text(); const res = await oGa(new Request(req.url, { method: req.method, headers: req.headers, body: t }), ip, me, arg);
    try { if (me && res.status === 200) { const fp = normPid(JSON.parse(t).code), g = await get("g/" + clean(arg, 12));
      if (g) await notify(fp, "grupa", { title: "🚵 Zaproszenie na wspólny zjazd", body: showN(me.pid, me.nick) + " zaprasza Cię: „" + g.name + "”, " + new Date(g.at).toLocaleString("pl-PL", { timeZone: "Europe/Warsaw", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + ".", url: "/?go=friends", tag: "grupa-" + g.gid }); } } catch { }
    return res;
  };
}

/* ---------- ranking okolicy (50 km): punkty za miejsca na trasach + królowie tygodnia ---------- */
const RPTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1], REG_KM = 50;
async function updRegion(tr, lb) {
  try {
    const key = "rg/" + cell5(tr.wps[0][0], tr.wps[0][1]), rg = (await get(key)) || { tr: {} };
    const top = Object.entries((lb && lb.times) || {}).sort((a, b) => a[1].t - b[1].t || a[1].d - b[1].d).slice(0, RPTS.length);
    const K = kingOf(lb || {});
    rg.tr[tr.rid] = { s: tr.wps[0], name: tr.name, pts: Object.fromEntries(top.map(([p, x], i) => [p, [RPTS[i], x.n, x.i]])),
      king: K ? { p: K.pid, n: K.n, i: K.i, t: K.t, wk: weekKey(Date.now()) } : null };
    await put(key, rg);
  } catch { }
}
routes["GET region"] = async (req, ip, me) => {
  const u = new URL(req.url), lat = +u.searchParams.get("lat"), lng = +u.searchParams.get("lng");
  if (!fin(lat) || !fin(lng)) return err("Podaj lat i lng.");
  const [cy, cx] = cell5(lat, lng).split("_").map(Number), keys = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) keys.push("rg/" + (cy + dy) + "_" + (cx + dx));
  const P = {}, kings = [], wk = weekKey(Date.now()); let nt = 0;
  for (const rg of await Promise.all(keys.map(get))) for (const [rid, x] of Object.entries((rg && rg.tr) || {})) {
    if (HID.t[rid] || km(lat, lng, x.s[0], x.s[1]) > REG_KM) continue; nt++;
    for (const [pid, [p, n, i]] of Object.entries(x.pts || {})) { const o = P[pid] || (P[pid] = { n: showN(pid, n), i, pts: 0, tracks: 0, crowns: 0, me: me && pid === me.pid || undefined }); o.pts += p; o.tracks++; }
    if (x.king && x.king.wk === wk) { kings.push({ name: x.name, n: showN(x.king.p, x.king.n), i: x.king.i, t: x.king.t, me: me && x.king.p === me.pid || undefined });
      const o = P[x.king.p] || (P[x.king.p] = { n: showN(x.king.p, x.king.n), i: x.king.i, pts: 0, tracks: 0, crowns: 0, me: me && x.king.p === me.pid || undefined }); o.crowns++; }
  }
  const list = Object.values(P).sort((a, b) => b.pts - a.pts || b.crowns - a.crowns);
  return json({ km: REG_KM, tracks: nt, players: list.slice(0, 50), n: list.length, rank: list.findIndex(x => x.me) + 1, kings: kings.slice(0, 30) });
};

/* ---------- polecenia: kupujący z linku znajomego → obaj dostają po 200 monet ---------- */
const REF_BONUS = 200;
routes["POST refclaim"] = async (req, ip, me) => {
  if (!me) return err("Dołącz do gry online.", 401);
  const r = (await get("rf/" + me.pid)) || { n: 0, pend: 0 };
  const got = r.pend || 0; if (got) { r.pend = 0; await put("rf/" + me.pid, r); }
  return json({ ok: true, claimed: got, coins: got * REF_BONUS, total: r.n || 0 });
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
    m = u.pathname.match(/^\/api\/([a-z]+)(?:\/([A-Za-z0-9_.-]+))?(?:\/([a-z]+))?\/?$/);
    const h = m && routes[req.method + " " + m[1] + (m[3] ? " " + m[3] : "")];
    if (!h) return err("Nieznany adres.", 404);
    await loadHid();
    const me = await who(req);
    return await h(req, ip, me, m[2]);
  } catch (e) {
    return err(e && e.status ? e.message : "Błąd serwera. Spróbuj za chwilę.", (e && e.status) || 500);
  }
};
