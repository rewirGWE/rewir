/* Rewir – plik offline (service worker).
   Strona gry: najpierw internet (żeby nowe wersje przychodziły od razu), bez sieci kopia z telefonu.
   Mapy pobrane w „Mapy offline” podawane są z pamięci telefonu. */
const SHELL='linia-shell-v1',STATIC='linia-static-v1',TILES='linia-tiles-v1';
const LOCAL=['./','manifest.webmanifest','icon-192.png','icon-512.png','icon-maskable-512.png','apple-touch-icon.png','favicon.png','polityka-prywatnosci.html'];
const CDN=['https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css','https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js'];
self.addEventListener('install',e=>{
  e.waitUntil((async()=>{
    const s=await caches.open(SHELL);await Promise.all(LOCAL.map(u=>s.add(new Request(u,{cache:'reload'})).catch(()=>{})));
    const c=await caches.open(STATIC);await Promise.all(CDN.map(u=>c.add(new Request(u,{mode:'cors'})).catch(()=>{})));
    self.skipWaiting();
  })());
});
self.addEventListener('activate',e=>{
  e.waitUntil((async()=>{
    const keep=[SHELL,STATIC,TILES];for(const k of await caches.keys())if(!keep.includes(k)&&k.startsWith('linia-'))await caches.delete(k);
    await self.clients.claim();
  })());
});
const isTile=u=>/\/\d{1,2}\/\d+\/\d+(@2x)?(\.(png|jpe?g|webp|pbf))?(\?.*)?$/.test(u.pathname)&&!/api\./.test(u.host);
const isStatic=u=>u.host==='cdnjs.cloudflare.com'||u.host==='fonts.googleapis.com'||u.host==='fonts.gstatic.com';
async function shellFallback(req){
  const s=await caches.open(SHELL);
  return (await s.match(req,{ignoreSearch:true}))||(await s.match(new URL('./',self.registration.scope).href))||(await s.match('index.html'))||Response.error();
}
self.addEventListener('fetch',e=>{
  const req=e.request;if(req.method!=='GET')return;
  if(req.cache==='no-store'||req.cache==='reload')return;           /* sprawdzanie aktualizacji gry idzie prosto do sieci */
  const u=new URL(req.url);
  if(u.origin===location.origin&&/^\/(api|w|z)\//.test(u.pathname))return;   /* serwer gry: zawsze prosto do sieci */
  if(req.mode==='navigate'){                                         /* strona gry: sieć, a bez sieci kopia */
    e.respondWith((async()=>{
      try{const ctl=new AbortController();const t=setTimeout(()=>ctl.abort(),6000);
        const r=await fetch(req,{signal:ctl.signal});clearTimeout(t);
        if(r&&r.ok&&u.origin===location.origin){const s=await caches.open(SHELL);s.put(new URL('./',self.registration.scope).href,r.clone()).catch(()=>{});if(/polityka/.test(u.pathname))s.put(req,r.clone()).catch(()=>{});}
        return r;
      }catch(err){return shellFallback(req);}
    })());
    return;
  }
  if(u.origin===location.origin){                                    /* ikony, manifest: z telefonu, w tle odświeżane */
    e.respondWith((async()=>{const s=await caches.open(SHELL);const hit=await s.match(req,{ignoreSearch:true});
      const net=fetch(req).then(r=>{if(r&&r.ok)s.put(req,r.clone()).catch(()=>{});return r;}).catch(()=>null);
      return hit||(await net)||Response.error();})());
    return;
  }
  if(isStatic(u)){                                                   /* biblioteka mapy i czcionki */
    e.respondWith((async()=>{const c=await caches.open(STATIC);const hit=await c.match(req);
      const net=fetch(req).then(r=>{if(r&&(r.ok||r.type==='opaque'))c.put(req,r.clone()).catch(()=>{});return r;}).catch(()=>null);
      return hit||(await net)||Response.error();})());
    return;
  }
  if(isTile(u)){                                                     /* kafelki: najpierw mapy offline, potem internet */
    e.respondWith((async()=>{const c=await caches.open(TILES);const hit=await c.match(req,{ignoreSearch:false});if(hit)return hit;
      try{return await fetch(req);}catch(err){return Response.error();}})());
    return;
  }
  /* pozostałe (pogoda, wysokości, AI): zwykły internet */
});
