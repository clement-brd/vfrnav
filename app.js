/* VFR Nav — application (PWA) */
(function () {
  'use strict';
  const VERSION = '1.0.0';
  const N = window.Nav;
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const M2FT = 3.28084, MS2KT = 1.943844;
  const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

  /* ---------- Stockage ---------- */
  const LS = {
    get(k, d) { try { const v = localStorage.getItem('vfr.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('vfr.' + k, JSON.stringify(v)); } catch (e) { toast('Stockage plein'); } }
  };
  const IDB = (() => {
    let dbp;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      const r = indexedDB.open('vfrnav', 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('tracks', { keyPath: 'id' }); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }));
    const tx = async (store, mode, fn) => { const db = await open(); return new Promise((res, rej) => {
      const t = db.transaction(store, mode), s = t.objectStore(store); const r = fn(s);
      t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); }); };
    return {
      get: (k) => tx('kv', 'readonly', s => s.get(k)),
      set: (k, v) => tx('kv', 'readwrite', s => s.put(v, k)),
      putTrack: (t) => tx('tracks', 'readwrite', s => s.put(t)),
      delTrack: (id) => tx('tracks', 'readwrite', s => s.delete(id)),
      allTracks: () => tx('tracks', 'readonly', s => s.getAll())
    };
  })();

  /* ---------- État ---------- */
  const DEF_SETTINGS = { alertOn: true, alertSec: 60, clock: 'local', theme: 'dark', wake: true, autorec: true,
    base: 'otm', custom: '', oaip: '', oaipOn: false, zmax: 11, orient: 'north' };
  const S = Object.assign({}, DEF_SETTINGS, LS.get('settings', {}));
  let fleet = LS.get('fleet', null);
  if (!fleet) fleet = [{ id: uid(), type: 'avion', name: 'DR400-120 (exemple, à adapter)', reg: 'F-XXXX', tas: 105, conso: 25, capacity: 110, taxi: 2, reserveMin: 30 }];
  let plans = LS.get('plans', []);
  let userWps = LS.get('userWps', []);
  let activePlanId = LS.get('activePlanId', null);
  let nav = LS.get('nav', { mode: 'free' });
  const saveFleet = () => LS.set('fleet', fleet);
  const savePlans = () => LS.set('plans', plans);
  const saveUserWps = () => LS.set('userWps', userWps);
  const saveSettings = () => LS.set('settings', S);
  const saveNav = () => LS.set('nav', nav);

  let airports = [], navaids = [];
  const getPlan = id => plans.find(p => p.id === id);
  const getAc = id => fleet.find(a => a.id === id) || fleet[0] || { tas: 0, conso: 0 };

  function newPlan(name) {
    const p = { id: uid(), name: name || 'Nouveau vol', acId: fleet[0] && fleet[0].id, wind: { dir: '', spd: '' }, wps: [], onboard: '', extraMin: '' };
    plans.push(p); savePlans(); return p;
  }
  if (!plans.length) newPlan('Mon premier vol');
  if (!getPlan(activePlanId)) activePlanId = plans[0].id;
  const curPlan = () => getPlan(activePlanId);

  /* ---------- UI utilitaires ---------- */
  let toastT;
  function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), ms); }
  function sheet(html, bind) { $('#sheet-body').innerHTML = html; $('#sheet').classList.remove('hidden'); if (bind) bind($('#sheet-body')); }
  const closeSheet = () => $('#sheet').classList.add('hidden');
  $('#sheet-close').onclick = closeSheet;
  $('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });
  function applyTheme() { document.documentElement.dataset.theme = S.theme; }
  applyTheme();

  /* ---------- Onglets ---------- */
  function showView(v) {
    document.querySelectorAll('.view').forEach(el => el.classList.toggle('active', el.id === 'view-' + v));
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
    if (v === 'map' && map) setTimeout(() => map.resize(), 50);
    if (v === 'prep') renderPrep();
    if (v === 'fleet') renderFleet();
    if (v === 'tracks') renderTracks();
    if (v === 'settings') renderSettings();
  }
  document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => showView(b.dataset.view));

  /* ---------- Données aéronautiques ---------- */
  const DATA_BASE = 'https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/';
  async function loadData() {
    try {
      const d = await IDB.get('aerodata');
      if (d) { airports = d.airports || []; navaids = d.navaids || []; LS.set('dataDate', d.date); }
    } catch (e) { console.warn(e); }
    refreshDataLayers();
  }
  async function updateData() {
    const info = $('#s-datainfo');
    const btn = $('#s-update'); btn.disabled = true;
    try {
      info.textContent = 'Téléchargement des aérodromes (~12 Mo)…';
      const aTxt = await (await fetch(DATA_BASE + 'airports.csv', { cache: 'no-store' })).text();
      info.textContent = 'Analyse…';
      const ap = [], byRef = {};
      N.parseCSV(aTxt, r => {
        if (r.iso_country !== 'FR' || r.continent !== 'EU') return;
        if (!/^(small|medium|large)_airport$/.test(r.type)) return;
        const o = { id: r.ident, icao: r.icao_code || r.gps_code || '', name: r.name, lat: +r.latitude_deg, lon: +r.longitude_deg,
          elev: r.elevation_ft ? +r.elevation_ft : null, type: r.type.replace('_airport', ''), city: r.municipality, freqs: [] };
        ap.push(o); byRef[r.id] = o;
      });
      info.textContent = 'Fréquences…';
      const fTxt = await (await fetch(DATA_BASE + 'airport-frequencies.csv', { cache: 'no-store' })).text();
      N.parseCSV(fTxt, r => { const a = byRef[r.airport_ref]; if (a) a.freqs.push({ t: r.type, d: r.description, f: r.frequency_mhz }); });
      info.textContent = 'Balises…';
      const nTxt = await (await fetch(DATA_BASE + 'navaids.csv', { cache: 'no-store' })).text();
      const nv = [];
      N.parseCSV(nTxt, r => { if (r.iso_country === 'FR' && /VOR|NDB|DME|TACAN/.test(r.type)) nv.push({ id: r.ident, name: r.name, type: r.type, freq: r.frequency_khz, lat: +r.latitude_deg, lon: +r.longitude_deg }); });
      airports = ap; navaids = nv;
      const date = new Date().toISOString();
      await IDB.set('aerodata', { airports, navaids, date });
      LS.set('dataDate', date);
      refreshDataLayers();
      toast(`${ap.length} terrains et ${nv.length} balises chargés`);
    } catch (e) {
      console.error(e); toast('Échec du téléchargement : réseau indisponible ?', 4000);
    }
    btn.disabled = false; renderDataInfo();
  }
  function renderDataInfo() {
    const d = LS.get('dataDate', null);
    $('#s-datainfo').textContent = d ? `${airports.length} terrains, ${navaids.length} balises — mis à jour le ${new Date(d).toLocaleDateString('fr-FR')}`
      : 'Aucune donnée aéronautique chargée. Connecte-toi au réseau et lance la mise à jour.';
  }

  function search(q, limit = 25) {
    q = fold(q).trim(); if (q.length < 2) return [];
    const out = [];
    const add = (p, score) => out.push({ p, score });
    for (const u of userWps) { const n = fold(u.name); if (n.includes(q)) add({ ...u, kind: 'user' }, n.startsWith(q) ? 1 : 3); }
    for (const a of airports) {
      const id = fold(a.id), icao = fold(a.icao), n = fold(a.name + ' ' + (a.city || ''));
      if (id === q || icao === q) add({ ...a, kind: 'ad' }, 0);
      else if (id.startsWith(q) || icao.startsWith(q)) add({ ...a, kind: 'ad' }, 1);
      else if (n.includes(q)) add({ ...a, kind: 'ad' }, 2);
    }
    for (const v of navaids) { if (fold(v.id) === q || fold(v.name).includes(q)) add({ ...v, kind: 'navaid' }, fold(v.id) === q ? 0 : 3); }
    // coordonnées "47.25 6.03"
    const m = q.match(/^(-?\d+(?:[.,]\d+)?)[ ,;]+(-?\d+(?:[.,]\d+)?)$/);
    if (m) add({ name: 'Point ' + m[1] + ' ' + m[2], lat: +m[1].replace(',', '.'), lon: +m[2].replace(',', '.'), kind: 'coord' }, 0);
    return out.sort((a, b) => a.score - b.score).slice(0, limit).map(o => o.p);
  }
  const ptLabel = p => p.kind === 'ad' ? `${p.icao || p.id} — ${p.name}` : p.kind === 'navaid' ? `${p.id} ${p.type} — ${p.name}` : p.name;
  const ptShort = p => p.kind === 'ad' ? (p.icao || p.id) : p.kind === 'navaid' ? p.id : p.name;
  const toWp = p => ({ name: ptShort(p), full: ptLabel(p), lat: p.lat, lon: p.lon });

  /* ---------- Carte ---------- */
  let labelT = null, map = null, mapReady = false, planeAdded = false, planeMarker = null, wpMarkers = [], adLabelMarkers = [];
  const BASES = {
    otm: { tiles: ['a', 'b', 'c'].map(s => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`), maxzoom: 17,
      attribution: '© OpenStreetMap, SRTM | © OpenTopoMap (CC-BY-SA)' },
    osm: { tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], maxzoom: 19, attribution: '© OpenStreetMap' }
  };
  const baseDef = () => S.base === 'custom' && S.custom ? { tiles: [S.custom], maxzoom: 18, attribution: 'Fond personnalisé' } : BASES[S.base] || BASES.otm;
  const oaipUrl = () => `https://api.tiles.openaip.net/api/data/openaip/{z}/{x}/{y}.png?apiKey=${encodeURIComponent(S.oaip)}`;
  const emptyFC = () => ({ type: 'FeatureCollection', features: [] });

  function initMap() {
    if (!window.maplibregl) {
      $('#map').innerHTML = '<p style="padding:200px 20px;text-align:center;color:#333">Bibliothèque de carte indisponible.<br>Ouvre l\'app une première fois avec du réseau.</p>';
      return;
    }
    const last = LS.get('lastPos', { lon: 6.0, lat: 47.2, z: 8 });
    map = new maplibregl.Map({
      container: 'map', center: [last.lon, last.lat], zoom: last.z, attributionControl: { compact: true },
      style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#dde3e8' } }] },
      dragRotate: false, pitchWithRotate: false, touchPitch: false, maxPitch: 0
    });
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.ScaleControl({ unit: 'nautical' }), 'bottom-left');
    map.on('load', () => {
      mapReady = true;
      setBase();
      for (const id of ['track-shown', 'trackline', 'route', 'leg', 'ads', 'navaids', 'userwps', 'wps']) map.addSource(id, { type: 'geojson', data: emptyFC() });
      map.addLayer({ id: 'track-shown', type: 'line', source: 'track-shown', paint: { 'line-color': '#7a3cff', 'line-width': 3, 'line-opacity': .8 } });
      map.addLayer({ id: 'trackline', type: 'line', source: 'trackline', paint: { 'line-color': '#1e7fff', 'line-width': 3 } });
      map.addLayer({ id: 'route', type: 'line', source: 'route', paint: { 'line-color': '#ff2ea6', 'line-width': 4, 'line-opacity': .85 } });
      map.addLayer({ id: 'leg', type: 'line', source: 'leg', paint: { 'line-color': '#ffb020', 'line-width': 3, 'line-dasharray': [2, 1.5] } });
      map.addLayer({ id: 'ads', type: 'circle', source: 'ads', paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, ['match', ['get', 'type'], 'small', 2.5, 4], 10, ['match', ['get', 'type'], 'small', 6, 8]],
        'circle-color': ['match', ['get', 'type'], 'large', '#003e9c', 'medium', '#2060c0', '#a0007a'],
        'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 } });
      map.addLayer({ id: 'navaids', type: 'circle', source: 'navaids', minzoom: 7, paint: { 'circle-radius': 5, 'circle-color': '#ffffff', 'circle-stroke-color': '#0050b0', 'circle-stroke-width': 2.5 } });
      map.addLayer({ id: 'userwps', type: 'circle', source: 'userwps', paint: { 'circle-radius': 5, 'circle-color': '#18a058', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 } });
      map.addLayer({ id: 'wps', type: 'circle', source: 'wps', paint: { 'circle-radius': 7, 'circle-color': '#ff2ea6', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
      refreshDataLayers(); refreshRoute();
      const el = document.createElement('div');
      el.innerHTML = '<svg class="plane" viewBox="0 0 40 40"><path d="M20 2l3 12 13 6v3l-13-3-1 10 5 4v2l-7-2-7 2v-2l5-4-1-10-13 3v-3l13-6z" fill="#ffd400" stroke="#000" stroke-width="1.5"/></svg>';
      planeMarker = new maplibregl.Marker({ element: el, rotationAlignment: 'map' }).setLngLat([last.lon, last.lat]);
      if (lastFix) placePlane(lastFix);
    });
    map.on('moveend', () => {
      const c = map.getCenter(); LS.set('lastPos', { lon: c.lng, lat: c.lat, z: map.getZoom() });
      clearTimeout(labelT); labelT = setTimeout(refreshAdLabels, 400);
    });
    map.on('dragstart', e => { if (e.originalEvent) setFollow(false); });
    map.on('click', e => {
      if (longPressFired) { longPressFired = false; return; }
      const bb = [[e.point.x - 14, e.point.y - 14], [e.point.x + 14, e.point.y + 14]];
      const layers = ['wps', 'userwps', 'navaids', 'ads'].filter(l => map.getLayer(l));
      const f = map.queryRenderedFeatures(bb, { layers })[0];
      if (f) pointSheet(featureToPoint(f));
    });
    // Appui long → point libre
    let lpT = null, lpStart = null, longPressFired = false;
    const cancelLp = () => { clearTimeout(lpT); lpT = null; };
    map.on('touchstart', e => {
      if (e.originalEvent.touches.length !== 1) return cancelLp();
      lpStart = e.point; const ll = e.lngLat;
      lpT = setTimeout(() => { longPressFired = true; freePointSheet(ll); setTimeout(() => longPressFired = false, 800); }, 600);
    });
    map.on('touchmove', e => { if (lpStart && (Math.abs(e.point.x - lpStart.x) > 10 || Math.abs(e.point.y - lpStart.y) > 10)) cancelLp(); });
    map.on('touchend', cancelLp); map.on('touchcancel', cancelLp);
    map.on('contextmenu', e => freePointSheet(e.lngLat));
  }

  function setBase() {
    if (!map || !mapReady) return;
    const before = map.getLayer('track-shown') ? 'track-shown' : undefined;
    for (const id of ['oaip', 'base']) { if (map.getLayer(id)) map.removeLayer(id); if (map.getSource(id)) map.removeSource(id); }
    const b = baseDef();
    map.addSource('base', { type: 'raster', tiles: b.tiles, tileSize: 256, maxzoom: b.maxzoom, attribution: b.attribution });
    map.addLayer({ id: 'base', type: 'raster', source: 'base' }, before);
    if (S.oaipOn && S.oaip) {
      map.addSource('oaip', { type: 'raster', tiles: [oaipUrl()], tileSize: 256, maxzoom: 14, attribution: '© openAIP' });
      map.addLayer({ id: 'oaip', type: 'raster', source: 'oaip' }, before);
    }
  }

  function featureToPoint(f) {
    const p = f.properties, [lon, lat] = f.geometry.coordinates;
    if (f.layer.id === 'ads') { const a = airports.find(x => x.id === p.id); if (a) return { ...a, kind: 'ad' }; }
    if (f.layer.id === 'navaids') { const v = navaids.find(x => x.id === p.id && Math.abs(x.lat - lat) < 1e-4); if (v) return { ...v, kind: 'navaid' }; }
    if (f.layer.id === 'userwps') { const u = userWps.find(x => x.id === p.id); if (u) return { ...u, kind: 'user' }; }
    return { name: p.name, lat, lon, kind: 'wp', idx: p.idx };
  }

  function refreshDataLayers() {
    if (!map || !map.getSource('ads')) return;
    map.getSource('ads').setData({ type: 'FeatureCollection', features: airports.map(a => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [a.lon, a.lat] }, properties: { id: a.id, type: a.type } })) });
    map.getSource('navaids').setData({ type: 'FeatureCollection', features: navaids.map(v => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [v.lon, v.lat] }, properties: { id: v.id } })) });
    map.getSource('userwps').setData({ type: 'FeatureCollection', features: userWps.map(u => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [u.lon, u.lat] }, properties: { id: u.id } })) });
    refreshAdLabels();
  }
  function refreshAdLabels() {
    adLabelMarkers.forEach(m => m.remove()); adLabelMarkers = [];
    if (!map || map.getZoom() < 8.5) return;
    const b = map.getBounds(); let n = 0;
    const list = [...airports.map(a => ({ t: a.icao || a.id, lat: a.lat, lon: a.lon })), ...userWps.map(u => ({ t: u.name, lat: u.lat, lon: u.lon }))];
    for (const a of list) {
      if (!b.contains([a.lon, a.lat])) continue;
      if (++n > 120) break;
      const el = document.createElement('div'); el.className = 'adlabel'; el.textContent = a.t;
      adLabelMarkers.push(new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([a.lon, a.lat]).addTo(map));
    }
  }

  function activeWps() {
    if (nav.mode === 'plan') { const p = getPlan(nav.planId); return p ? p.wps : []; }
    return curPlan() ? curPlan().wps : [];
  }
  function refreshRoute() {
    if (!map || !map.getSource('route')) return;
    const wps = activeWps();
    map.getSource('route').setData({ type: 'FeatureCollection', features: wps.length > 1 ? [{ type: 'Feature', geometry: { type: 'LineString', coordinates: wps.map(w => [w.lon, w.lat]) }, properties: {} }] : [] });
    map.getSource('wps').setData({ type: 'FeatureCollection', features: wps.map((w, i) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [w.lon, w.lat] }, properties: { name: w.name, idx: i } })) });
    wpMarkers.forEach(m => m.remove()); wpMarkers = [];
    wps.forEach((w, i) => {
      const el = document.createElement('div'); el.className = 'wplabel' + (nav.mode === 'plan' && nav.legIdx === i ? ' active' : ''); el.textContent = w.name;
      wpMarkers.push(new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([w.lon, w.lat]).addTo(map));
    });
    if (nav.mode === 'direct' && nav.target) {
      const el = document.createElement('div'); el.className = 'wplabel active'; el.textContent = nav.target.name;
      wpMarkers.push(new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([nav.target.lon, nav.target.lat]).addTo(map));
    }
    updateLegLine();
  }
  function updateLegLine() {
    if (!map || !map.getSource('leg')) return;
    const t = navTarget();
    map.getSource('leg').setData({ type: 'FeatureCollection', features: t && lastFix ? [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[lastFix.lon, lastFix.lat], [t.lon, t.lat]] }, properties: {} }] : [] });
  }

  /* ---------- Feuilles d'action sur un point ---------- */
  function pointInfo(p) {
    let h = `<h3>${esc(ptLabel(p))}</h3><p class="hint">${N.fmtCoord(p.lat, p.lon)}`;
    if (p.elev !== null && p.elev !== undefined) h += ` · Alt. ${p.elev} ft`;
    if (p.city) h += ` · ${esc(p.city)}`;
    if (p.kind === 'navaid' && p.freq) h += ` · ${(+p.freq >= 10000 ? (p.freq / 1000).toFixed(2) + ' MHz' : p.freq + ' kHz')}`;
    if (lastFix) h += `<br>Depuis l'avion : ${N.fmtHdg(N.bearing(lastFix.lat, lastFix.lon, p.lat, p.lon))} vrai, ${N.distNM(lastFix.lat, lastFix.lon, p.lat, p.lon).toFixed(1)} NM`;
    h += '</p>';
    if (p.freqs && p.freqs.length) h += '<p class="hint">' + p.freqs.map(f => `${esc(f.t)} ${esc(f.f)}${f.d ? ' <small>(' + esc(f.d) + ')</small>' : ''}`).join('<br>') + '</p>';
    return h;
  }
  function pointSheet(p) {
    const inPlan = p.kind === 'wp';
    let h = pointInfo(p);
    h += `<button class="opt" data-a="direct">D→ Direct To</button>`;
    if (!inPlan) h += `<button class="opt" data-a="add">+ Ajouter à la fin du vol « ${esc(curPlan().name)} »</button>`;
    if (p.kind === 'coord' || p.kind === 'free') h += `<button class="opt" data-a="save">★ Enregistrer comme point perso</button>`;
    if (p.kind === 'user') h += `<button class="opt" data-a="deluser">Supprimer ce point perso</button>`;
    sheet(h, root => root.querySelectorAll('[data-a]').forEach(b => b.onclick = () => {
      const a = b.dataset.a;
      if (a === 'direct') { if (inPlan) startPlanAt(p.idx, nav.mode === 'plan' ? nav.planId : activePlanId); else directTo(p); }
      if (a === 'add') { curPlan().wps.push(toWp(p)); savePlans(); refreshRoute(); toast('Ajouté : ' + ptShort(p)); }
      if (a === 'save') { const name = prompt('Nom du point', 'PT' + (userWps.length + 1)); if (name) { userWps.push({ id: uid(), name, lat: p.lat, lon: p.lon }); saveUserWps(); refreshDataLayers(); toast('Point perso enregistré'); } }
      if (a === 'deluser') { userWps = userWps.filter(u => u.id !== p.id); saveUserWps(); refreshDataLayers(); }
      closeSheet();
    }));
  }
  const freePointSheet = ll => pointSheet({ name: 'Point ' + N.fmtCoord(ll.lat, ll.lng), lat: ll.lat, lon: ll.lng, kind: 'free' });

  function directToSheet() {
    let h = '<h3>Direct To</h3><input id="dt-q" placeholder="Rechercher un terrain, balise, point…" autocomplete="off"><div id="dt-res"></div>';
    sheet(h, root => {
      const res = root.querySelector('#dt-res');
      const opt = (p, sub) => `<button class="opt" data-i="${opts.length - 1}">${esc(ptLabel(p))}<small>${sub || ''}</small></button>`;
      let opts = [];
      const fill = q => {
        opts = []; let out = '';
        if (q) { for (const p of search(q, 15)) { opts.push(p); out += opt(p, distTxt(p)); } }
        else {
          const wps = activeWps();
          if (wps.length) { out += '<p class="hint">Points du vol</p>'; wps.forEach((w, i) => { opts.push({ ...w, kind: 'wp', idx: i }); out += opt({ ...w, kind: 'wp' }, distTxt(w)); }); }
          if (lastFix && airports.length) {
            out += '<p class="hint">Terrains les plus proches</p>';
            airports.map(a => ({ a, d: N.distNM(lastFix.lat, lastFix.lon, a.lat, a.lon) })).sort((x, y) => x.d - y.d).slice(0, 10)
              .forEach(({ a }) => { const p = { ...a, kind: 'ad' }; opts.push(p); out += opt(p, distTxt(p)); });
          }
        }
        res.innerHTML = out || '<p class="hint">Aucun résultat.</p>';
        res.querySelectorAll('[data-i]').forEach(b => b.onclick = () => {
          const p = opts[+b.dataset.i];
          if (p.kind === 'wp') startPlanAt(p.idx, nav.mode === 'plan' ? nav.planId : activePlanId);
          else directTo(p);
          closeSheet();
        });
      };
      root.querySelector('#dt-q').oninput = e => fill(e.target.value);
      fill('');
    });
  }
  const distTxt = p => lastFix ? `${N.fmtHdg(N.bearing(lastFix.lat, lastFix.lon, p.lat, p.lon))} · ${N.distNM(lastFix.lat, lastFix.lon, p.lat, p.lon).toFixed(1)} NM` : '';

  /* ---------- Moteur de navigation ---------- */
  let lastFix = null, prevFix = null, minDist = Infinity, alerted = {}, follow = true, lastBearing = 0;

  function navTarget() {
    if (nav.mode === 'plan') { const p = getPlan(nav.planId); return p && p.wps[nav.legIdx] ? p.wps[nav.legIdx] : null; }
    if (nav.mode === 'direct') return nav.target || null;
    return null;
  }
  function navWind(target) {
    if (nav.mode === 'plan') {
      const p = getPlan(nav.planId);
      if (target && target.wspd !== undefined && target.wspd !== '' && target.wspd !== null) return { dir: +target.wdir || 0, spd: +target.wspd };
      return p ? { dir: +p.wind.dir || 0, spd: +p.wind.spd || 0 } : { dir: 0, spd: 0 };
    }
    return nav.wind || { dir: 0, spd: 0 };
  }
  function navAc() {
    const p = nav.mode === 'plan' ? getPlan(nav.planId) : curPlan();
    return getAc(p && p.acId);
  }
  function resetLeg() { minDist = Infinity; }

  function startPlanAt(idx, planId) {
    const pid = planId || activePlanId;
    const p = getPlan(pid); if (!p || p.wps.length < 1) return toast('Le vol ne contient pas de point');
    nav = { mode: 'plan', planId: pid, legIdx: Math.max(0, Math.min(idx, p.wps.length - 1)) };
    resetLeg(); saveNav(); refreshRoute(); updateNavButtons(); onFixUpdate();
    toast('Navigation vers ' + p.wps[nav.legIdx].name);
  }
  function directTo(p) {
    const pl = nav.mode === 'plan' ? getPlan(nav.planId) : curPlan();
    nav = { mode: 'direct', target: { name: ptShort(p), lat: p.lat, lon: p.lon }, wind: pl ? { dir: +pl.wind.dir || 0, spd: +pl.wind.spd || 0 } : { dir: 0, spd: 0 } };
    resetLeg(); saveNav(); refreshRoute(); updateNavButtons(); onFixUpdate();
    toast('Direct To ' + ptShort(p));
  }
  function stopNav() { nav = { mode: 'free' }; saveNav(); refreshRoute(); updateNavButtons(); onFixUpdate(); }
  function nextLeg(auto) {
    const t = navTarget();
    if (nav.mode === 'plan') {
      const p = getPlan(nav.planId);
      if (nav.legIdx < p.wps.length - 1) {
        nav.legIdx++; resetLeg(); saveNav(); refreshRoute();
        const nt = navTarget();
        if (auto && t) {
          const ac = navAc(), w = navWind(nt);
          const tc = N.bearing(t.lat, t.lon, nt.lat, nt.lon), wt = N.windTriangle(tc, +ac.tas, w.dir, w.spd);
          showAlert(`${esc(t.name)} passé<small>→ ${esc(nt.name)} · cap vrai ${N.fmtHdg(wt ? wt.th : tc)}</small>`, 'passed');
        }
      } else {
        if (auto && t) showAlert(`Arrivée ${esc(t.name)}<small>Fin de la navigation</small>`, 'passed');
        stopNav(); return;
      }
    } else if (nav.mode === 'direct') {
      if (auto && t) showAlert(`${esc(t.name)} atteint`, 'passed');
      stopNav(); return;
    }
    updateNavButtons(); onFixUpdate();
  }

  let alertT;
  function showAlert(html, cls) {
    const a = $('#alert'); a.className = cls || ''; a.innerHTML = html;
    a.style.animation = 'none'; void a.offsetWidth; a.style.animation = '';
    clearTimeout(alertT); alertT = setTimeout(() => a.classList.add('hidden'), 9000);
  }
  $('#alert').onclick = () => $('#alert').classList.add('hidden');

  /* Réception d'une position (réelle ou simulée) */
  function onFix(f) {
    // f : {lat, lon, alt (m|null), spd (m/s|null), hdg (°|null), acc, t}
    const fix = { lat: f.lat, lon: f.lon, alt: f.alt, t: f.t, acc: f.acc, gs: NaN, trk: NaN };
    if (f.spd !== null && f.spd !== undefined && f.spd >= 0) fix.gs = f.spd * MS2KT;
    if (f.hdg !== null && f.hdg !== undefined && !isNaN(f.hdg) && f.hdg >= 0 && fix.gs > 2) fix.trk = f.hdg;
    if (prevFix && (isNaN(fix.gs) || isNaN(fix.trk))) {
      const dt = (fix.t - prevFix.t) / 1000, d = N.distNM(prevFix.lat, prevFix.lon, fix.lat, fix.lon);
      if (dt >= 1) {
        if (isNaN(fix.gs)) fix.gs = d / dt * 3600;
        if (isNaN(fix.trk) && d > 0.01) fix.trk = N.bearing(prevFix.lat, prevFix.lon, fix.lat, fix.lon);
      }
    }
    if (isNaN(fix.trk) && lastFix && fix.gs > 2) fix.trk = lastFix.trk;
    if (!prevFix || fix.t - prevFix.t >= 1000) prevFix = fix;
    lastFix = fix;
    placePlane(fix);
    recordPoint(fix);
    onFixUpdate();
  }

  function placePlane(fix) {
    if (!map || !planeMarker) return;
    planeMarker.setLngLat([fix.lon, fix.lat]);
    if (!planeAdded) { planeMarker.addTo(map); planeAdded = true; }
    if (!isNaN(fix.trk)) planeMarker.setRotation(fix.trk);
    if (follow) {
      if (S.orient === 'track' && !isNaN(fix.trk)) lastBearing = fix.trk;
      const brg = S.orient === 'track' ? lastBearing : 0;
      const h = map.getContainer().clientHeight;
      map.easeTo({ center: [fix.lon, fix.lat], bearing: brg, duration: 800, essential: true,
        padding: S.orient === 'track' ? { top: h * 0.45, bottom: 0, left: 0, right: 0 } : { top: 150, bottom: 0, left: 0, right: 0 } });
    }
  }

  function onFixUpdate() {
    const fx = lastFix;
    const t = navTarget();
    const clockUtc = S.clock === 'utc';
    $('#i-mode').textContent = nav.mode === 'plan' ? 'VOL' : nav.mode === 'direct' ? 'D→' : 'LIBRE';
    $('#i-mode').className = 'badge ' + nav.mode;
    $('#i-trk').textContent = fx && !isNaN(fx.trk) ? N.fmtHdg(fx.trk) : '—';
    $('#i-gs').textContent = fx && !isNaN(fx.gs) ? Math.round(fx.gs) : '—';
    $('#i-alt').textContent = fx && fx.alt !== null && fx.alt !== undefined ? Math.round(fx.alt * M2FT).toLocaleString('fr-FR') + ' ft' : '— ft';
    if (!t) {
      $('#i-wp').textContent = nav.mode === 'free' ? 'Vol libre — D→ pour une destination' : '—';
      for (const id of ['#i-hdg', '#i-dist', '#i-ete', '#i-eta']) $(id).textContent = '—';
      $('#i-wind').textContent = ''; $('#i-etadest').textContent = '';
      updateLegLine(); return;
    }
    $('#i-wp').textContent = '→ ' + t.name;
    if (!fx) { updateLegLine(); return; }
    const dist = N.distNM(fx.lat, fx.lon, t.lat, t.lon);
    const brg = N.bearing(fx.lat, fx.lon, t.lat, t.lon);
    const ac = navAc(), w = navWind(t);
    const wt = +ac.tas > 0 ? N.windTriangle(brg, +ac.tas, w.dir, w.spd) : null;
    $('#i-hdg').textContent = N.fmtHdg(wt ? wt.th : brg);
    $('#i-wind').textContent = w.spd ? `vent ${String(Math.round(w.dir)).padStart(3, '0')}/${Math.round(w.spd)}` : 'sans vent';
    $('#i-dist').textContent = dist < 10 ? dist.toFixed(1) : Math.round(dist);
    const ete = fx.gs > 5 ? dist / fx.gs * 3600 : NaN;
    $('#i-ete').textContent = N.fmtEte(ete);
    $('#i-eta').textContent = isFinite(ete) ? N.fmtClock(new Date(Date.now() + ete * 1000), clockUtc) : '—';
    // ETA destination
    let dest = '';
    if (nav.mode === 'plan' && isFinite(ete)) {
      const p = getPlan(nav.planId); const log = N.computeLog(p.wps, ac, p.wind);
      let rest = 0; for (let i = nav.legIdx; i < log.legs.length; i++) rest += log.legs[i].min || 0; // legs[i] = wps[i] → wps[i+1]
      if (nav.legIdx < p.wps.length - 1) dest = 'dest ' + N.fmtClock(new Date(Date.now() + ete * 1000 + rest * 60000), clockUtc);
    }
    $('#i-etadest').textContent = dest;
    updateLegLine();

    // Alerte d'approche (par temps)
    const key = nav.mode + ':' + (nav.planId || '') + ':' + (nav.legIdx ?? '') + ':' + t.name;
    if (S.alertOn && isFinite(ete) && ete <= S.alertSec && !alerted[key] && dist > 0.3) {
      alerted[key] = true;
      let sub = 'dans ' + N.fmtEte(ete);
      if (nav.mode === 'plan') {
        const p = getPlan(nav.planId), nt = p.wps[nav.legIdx + 1];
        if (nt) { const tc = N.bearing(t.lat, t.lon, nt.lat, nt.lon), w2 = navWind(nt), wt2 = N.windTriangle(tc, +ac.tas, w2.dir, w2.spd);
          sub += ` · ensuite ${esc(nt.name)} cap vrai ${N.fmtHdg(wt2 ? wt2.th : tc)}`; }
        else sub += ' · destination';
      }
      showAlert(`Approche ${esc(t.name)}<small>${sub}</small>`);
    }
    // Séquencement automatique
    if (dist < minDist) minDist = dist;
    if (dist < 0.5 || (minDist < 2 && dist > minDist + 0.25)) nextLeg(true);
  }

  function setFollow(on) { follow = on; $('#b-follow').classList.toggle('on', on); if (on && lastFix) placePlane(lastFix); }
  function updateNavButtons() {
    $('#b-legnext').classList.toggle('hidden', nav.mode !== 'plan');
    $('#b-stopnav').classList.toggle('hidden', nav.mode === 'free');
  }
  $('#b-follow').onclick = () => setFollow(true);
  $('#b-orient').onclick = () => {
    S.orient = S.orient === 'track' ? 'north' : 'track'; saveSettings(); updateOrientBtn();
    if (S.orient === 'north' && map) map.easeTo({ bearing: 0, duration: 400 });
    setFollow(true);
  };
  const updateOrientBtn = () => { $('#b-orient').textContent = S.orient === 'track' ? 'R↑' : 'N↑'; $('#b-orient').title = S.orient === 'track' ? 'Route en haut' : 'Nord en haut'; };
  $('#b-direct').onclick = directToSheet;
  $('#b-legnext').onclick = () => nextLeg(false);
  $('#b-stopnav').onclick = () => { if (confirm('Arrêter la navigation en cours ?')) stopNav(); };

  /* ---------- GPS ---------- */
  let simTimer = null, watchId = null;
  function startGps() {
    if (!('geolocation' in navigator)) { $('#gpsstatus').textContent = 'GPS non disponible'; return; }
    watchId = navigator.geolocation.watchPosition(pos => {
      if (simTimer) return;
      const c = pos.coords;
      $('#gpsstatus').textContent = 'GPS ±' + Math.round(c.accuracy) + ' m'; $('#gpsstatus').className = c.accuracy < 50 ? 'ok' : '';
      onFix({ lat: c.latitude, lon: c.longitude, alt: c.altitude, spd: c.speed, hdg: c.heading, acc: c.accuracy, t: pos.timestamp || Date.now() });
    }, err => {
      if (simTimer) return;
      $('#gpsstatus').textContent = err.code === 1 ? 'GPS refusé (Réglages iOS)' : 'Recherche GPS…'; $('#gpsstatus').className = '';
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  }

  /* ---------- Simulation ---------- */
  function toggleSim() {
    if (simTimer) { clearInterval(simTimer); simTimer = null; $('#s-sim').textContent = 'Démarrer la simulation'; $('#gpsstatus').textContent = 'GPS…'; return; }
    const p = curPlan();
    if (!p || p.wps.length < 2) return toast('Il faut un vol actif avec au moins 2 points');
    const ac = getAc(p.acId), x = +$('#s-simx').value;
    let pos = { lat: p.wps[0].lat, lon: p.wps[0].lon }, simAlt = 2500 / M2FT;
    startPlanAt(1, p.id);
    $('#s-sim').textContent = 'Arrêter la simulation';
    simTimer = setInterval(() => {
      const t = navTarget();
      if (!t) { toggleSim(); toast('Simulation terminée'); return; }
      const w = navWind(t), brg = N.bearing(pos.lat, pos.lon, t.lat, t.lon);
      const wt = N.windTriangle(brg, +ac.tas || 100, w.dir, w.spd) || { gs: +ac.tas || 100 };
      const step = wt.gs * x / 3600; // NM parcourus en 1 s simulée × x
      const dLat = step * Math.cos(brg * Math.PI / 180) / 60;
      const dLon = step * Math.sin(brg * Math.PI / 180) / (60 * Math.cos(pos.lat * Math.PI / 180));
      pos = { lat: pos.lat + dLat, lon: pos.lon + dLon };
      $('#gpsstatus').textContent = 'SIMULATION ×' + x; $('#gpsstatus').className = '';
      onFix({ lat: pos.lat, lon: pos.lon, alt: simAlt, spd: wt.gs / MS2KT, hdg: brg, acc: 5, t: Date.now() });
    }, 1000);
    showView('map'); setFollow(true);
  }

  /* ---------- Enregistrement de trace ---------- */
  let rec = null, recSaveCount = 0, slowSince = null;
  function startRec(auto) {
    rec = { id: uid(), start: Date.now(), auto: !!auto, pts: [], done: false, name: '' };
    const p = nav.mode === 'plan' ? getPlan(nav.planId) : null; rec.name = p ? p.name : 'Vol du ' + new Date().toLocaleDateString('fr-FR');
    $('#b-rec').classList.add('rec'); $('#b-rec').textContent = '■ STOP';
    toast(auto ? 'Décollage détecté — trace en cours' : 'Enregistrement de la trace');
    IDB.putTrack(rec);
  }
  async function stopRec() {
    if (!rec) return;
    const r = rec; rec = null; slowSince = null;
    r.done = true; r.end = Date.now(); await IDB.putTrack(r);
    toast(`Trace enregistrée (${r.pts.length} points)`);
    $('#b-rec').classList.remove('rec'); $('#b-rec').textContent = '● REC';
    if (map && map.getSource('trackline')) map.getSource('trackline').setData(emptyFC());
  }
  function recordPoint(fx) {
    if (!rec && S.autorec && fx.gs > 40 && !simTimer) startRec(true);
    if (!rec) return;
    const last = rec.pts[rec.pts.length - 1];
    if (!last || (fx.t - last[3] >= 2000 && N.distNM(last[1], last[0], fx.lat, fx.lon) > 0.015)) {
      rec.pts.push([+fx.lon.toFixed(6), +fx.lat.toFixed(6), fx.alt !== null && fx.alt !== undefined ? Math.round(fx.alt * M2FT) : null, fx.t]);
      if (++recSaveCount % 15 === 0) IDB.putTrack(rec);
      if (map && map.getSource('trackline')) map.getSource('trackline').setData({ type: 'FeatureCollection', features: rec.pts.length > 1 ? [{ type: 'Feature', geometry: { type: 'LineString', coordinates: rec.pts.map(p => [p[0], p[1]]) }, properties: {} }] : [] });
    }
    // arrêt auto après l'atterrissage (si démarré automatiquement)
    if (rec.auto) {
      if (fx.gs < 15) { slowSince = slowSince || fx.t; if (fx.t - slowSince > 120000) stopRec(); } else slowSince = null;
    }
  }
  $('#b-rec').onclick = () => rec ? stopRec() : startRec(false);

  function trackGpx(t) {
    const pts = t.pts.map(p => `<trkpt lat="${p[1]}" lon="${p[0]}">${p[2] !== null ? `<ele>${(p[2] / M2FT).toFixed(1)}</ele>` : ''}<time>${new Date(p[3]).toISOString()}</time></trkpt>`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="VFR Nav" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>${esc(t.name)}</name><trkseg>\n${pts}\n</trkseg></trk>\n</gpx>`;
  }
  async function shareFile(name, text, mime) {
    const file = new File([text], name, { type: mime });
    try { if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; } } catch (e) { if (e.name === 'AbortError') return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  function trackStats(t) {
    let d = 0; for (let i = 1; i < t.pts.length; i++) d += N.distNM(t.pts[i - 1][1], t.pts[i - 1][0], t.pts[i][1], t.pts[i][0]);
    const dur = t.pts.length > 1 ? (t.pts[t.pts.length - 1][3] - t.pts[0][3]) / 60000 : 0;
    const maxAlt = t.pts.reduce((m, p) => Math.max(m, p[2] || 0), 0);
    return { d, dur, maxAlt };
  }
  async function renderTracks() {
    const list = (await IDB.allTracks()).sort((a, b) => b.start - a.start);
    const el = $('#t-list');
    if (!list.length) { el.innerHTML = '<p class="hint">Aucune trace. Appuie sur ● REC sur la carte, ou laisse le démarrage automatique au décollage.</p>'; return; }
    el.innerHTML = list.map(t => { const s = trackStats(t); return `<div class="item"><div class="info"><b>${esc(t.name)}</b>${t.done ? '' : '<span class="tag">en cours</span>'}
      <small>${new Date(t.start).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })} · ${N.fmtDur(s.dur)} · ${s.d.toFixed(1)} NM · max ${s.maxAlt.toLocaleString('fr-FR')} ft</small></div>
      <button class="sm ghost" data-show="${t.id}">Voir</button><button class="sm ghost" data-gpx="${t.id}">GPX</button><button class="sm danger" data-del="${t.id}">✕</button></div>`; }).join('');
    const byId = id => list.find(t => t.id === id);
    el.querySelectorAll('[data-show]').forEach(b => b.onclick = () => {
      const t = byId(b.dataset.show); showView('map'); setFollow(false);
      if (!map || t.pts.length < 2) return;
      map.getSource('track-shown').setData({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: t.pts.map(p => [p[0], p[1]]) }, properties: {} }] });
      const lons = t.pts.map(p => p[0]), lats = t.pts.map(p => p[1]);
      map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: { top: 180, bottom: 60, left: 40, right: 90 }, bearing: 0 });
    });
    el.querySelectorAll('[data-gpx]').forEach(b => b.onclick = () => { const t = byId(b.dataset.gpx); shareFile(`trace-${new Date(t.start).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.gpx`, trackGpx(t), 'application/gpx+xml'); });
    el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { if (rec && rec.id === b.dataset.del) return toast('Trace en cours d\'enregistrement'); if (confirm('Supprimer cette trace ?')) { await IDB.delTrack(b.dataset.del); renderTracks(); } });
  }

  /* ---------- Préparation ---------- */
  const numOrEmpty = v => v === '' || v === null || v === undefined ? '' : +v;
  function renderPrep() {
    const p = curPlan();
    $('#p-select').innerHTML = plans.map(x => `<option value="${x.id}" ${x.id === p.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
    $('#p-name').value = p.name;
    if (!getAc(p.acId) || !fleet.find(a => a.id === p.acId)) p.acId = fleet[0] && fleet[0].id;
    $('#p-ac').innerHTML = fleet.map(a => `<option value="${a.id}" ${a.id === p.acId ? 'selected' : ''}>${esc(a.reg)} — ${esc(a.name)}${a.type === 'ulm' ? ' (ULM)' : ''}</option>`).join('') || '<option>Ajoute un appareil dans Flotte</option>';
    $('#p-wdir').value = p.wind.dir; $('#p-wspd').value = p.wind.spd;
    $('#p-onboard').value = p.onboard; $('#p-extra').value = p.extraMin;
    renderWps(); renderLog();
  }
  function renderWps() {
    const p = curPlan(), el = $('#p-wps');
    if (!p.wps.length) { el.innerHTML = '<p class="hint">Aucun point. Commence par le terrain de départ.</p>'; return; }
    el.innerHTML = p.wps.map((w, i) => `<div class="wp" data-i="${i}">
      <div class="head"><b>${i === 0 ? '🛫 ' : i === p.wps.length - 1 ? '🛬 ' : ''}${esc(w.name)}<small>${esc(w.full && w.full !== w.name ? w.full : N.fmtCoord(w.lat, w.lon))}</small></b>
        <button class="ghost" data-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button><button class="ghost" data-down="${i}" ${i === p.wps.length - 1 ? 'disabled' : ''}>↓</button><button class="danger" data-rm="${i}">✕</button></div>
      ${i > 0 ? `<div class="legopts">Branche : alt <input type="number" inputmode="numeric" data-f="alt" value="${w.alt ?? ''}" placeholder="ft"> vent <input type="number" inputmode="numeric" data-f="wdir" value="${w.wdir ?? ''}" placeholder="dir"> / <input type="number" inputmode="numeric" data-f="wspd" value="${w.wspd ?? ''}" placeholder="kt"></div>` : ''}
    </div>`).join('');
    el.querySelectorAll('[data-up]').forEach(b => b.onclick = () => { const i = +b.dataset.up; [p.wps[i - 1], p.wps[i]] = [p.wps[i], p.wps[i - 1]]; planChanged(); });
    el.querySelectorAll('[data-down]').forEach(b => b.onclick = () => { const i = +b.dataset.down; [p.wps[i + 1], p.wps[i]] = [p.wps[i], p.wps[i + 1]]; planChanged(); });
    el.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { p.wps.splice(+b.dataset.rm, 1); planChanged(); });
    el.querySelectorAll('.legopts input').forEach(inp => inp.onchange = () => {
      const i = +inp.closest('.wp').dataset.i; p.wps[i][inp.dataset.f] = numOrEmpty(inp.value); savePlans(); renderLog();
    });
  }
  function planChanged() { savePlans(); renderWps(); renderLog(); refreshRoute(); }
  function renderLog() {
    const p = curPlan(), ac = getAc(p.acId);
    const log = N.computeLog(p.wps, ac, { dir: +p.wind.dir || 0, spd: +p.wind.spd || 0 });
    const f1 = v => isFinite(v) ? v.toFixed(1) : '—';
    let h = '<tr><th>Branche</th><th>Alt</th><th>Rv</th><th>Dist</th><th>Vent</th><th>X</th><th>Cv</th><th>Vs</th><th>Tps</th><th>Cumul</th><th>Carb L</th></tr>';
    if (!log.legs.length) h += '<tr><td colspan="11" class="hint">Ajoute au moins deux points.</td></tr>';
    for (const l of log.legs) {
      h += `<tr><td>${esc(l.from)} → ${esc(l.to)}</td><td>${l.alt ?? ''}</td><td>${N.fmtHdg(l.tc)}</td><td>${f1(l.dist)}</td>
        <td>${l.wspd ? String(Math.round(l.wdir)).padStart(3, '0') + '/' + l.wspd : '—'}</td><td>${isFinite(l.wca) ? (l.wca >= 0 ? '+' : '') + Math.round(l.wca) + '°' : '—'}</td>
        <td class="hdg">${N.fmtHdg(l.th)}</td><td>${isFinite(l.gs) ? Math.round(l.gs) : '—'}</td><td>${N.fmtDur(l.min)}</td><td>${N.fmtDur(l.cumMin)}</td><td>${f1(l.fuel)}</td></tr>`;
    }
    if (log.legs.length) h += `<tr class="tot"><td>Total</td><td></td><td></td><td>${f1(log.totDist)}</td><td></td><td></td><td></td><td></td><td>${N.fmtDur(log.totMin)}</td><td></td><td>${f1(log.totFuel)}</td></tr>`;
    if (!log.ok) h += '<tr><td colspan="11" class="badc">⚠ Vent trop fort pour la vitesse de l\'appareil sur une branche.</td></tr>';
    if (!(+ac.tas > 0)) h += '<tr><td colspan="11" class="warnc">Renseigne la vitesse de l\'appareil dans Flotte.</td></tr>';
    $('#p-log').innerHTML = h;
    const fb = N.fuelBalance(log, ac, { extraMin: p.extraMin, onboard: p.onboard });
    const L = v => isFinite(v) ? v.toFixed(1) + ' L' : '—';
    let f = `<tr><td>Roulage</td><td>${L(fb.taxi)}</td></tr><tr><td>Étape (${N.fmtDur(log.totMin)})</td><td>${L(fb.trip)}</td></tr>
      <tr><td>Réserve finale (${ac.reserveMin || 0} min)</td><td>${L(fb.reserve)}</td></tr>
      <tr><td>Marge supplémentaire (${+p.extraMin || 0} min)</td><td>${L(fb.extra)}</td></tr>
      <tr class="tot"><td>Minimum requis</td><td>${L(fb.required)}</td></tr>`;
    if (isFinite(fb.onboard)) {
      f += `<tr><td>À bord</td><td>${L(fb.onboard)}</td></tr>
        <tr class="tot"><td>${fb.margin >= 0 ? 'Excédent' : 'MANQUE'}</td><td class="${fb.margin >= 0 ? 'okc' : 'badc'}">${fb.margin >= 0 ? '+' : ''}${L(fb.margin)}</td></tr>
        <tr><td>Autonomie (après roulage)</td><td>${N.fmtDur(fb.endurMin)}</td></tr>`;
      if (ac.capacity && fb.onboard > +ac.capacity) f += `<tr><td colspan="2" class="badc">⚠ Plus que la capacité utilisable (${ac.capacity} L)</td></tr>`;
    }
    if (fb.overCapacity) f += `<tr><td colspan="2" class="badc">⚠ Le minimum requis dépasse la capacité utilisable : escale nécessaire.</td></tr>`;
    $('#p-fuel').innerHTML = f;
  }
  $('#p-select').onchange = e => { activePlanId = e.target.value; LS.set('activePlanId', activePlanId); renderPrep(); refreshRoute(); };
  $('#p-new').onclick = () => { const p = newPlan('Vol ' + (plans.length)); activePlanId = p.id; LS.set('activePlanId', activePlanId); renderPrep(); refreshRoute(); $('#p-name').focus(); };
  $('#p-dup').onclick = () => { const src = curPlan(); const p = JSON.parse(JSON.stringify(src)); p.id = uid(); p.name = src.name + ' (copie)'; plans.push(p); activePlanId = p.id; LS.set('activePlanId', activePlanId); savePlans(); renderPrep(); };
  $('#p-del').onclick = () => {
    if (!confirm('Supprimer ce vol ?')) return;
    if (nav.mode === 'plan' && nav.planId === activePlanId) stopNav();
    plans = plans.filter(p => p.id !== activePlanId); if (!plans.length) newPlan('Nouveau vol');
    activePlanId = plans[0].id; LS.set('activePlanId', activePlanId); savePlans(); renderPrep(); refreshRoute();
  };
  $('#p-name').onchange = e => { curPlan().name = e.target.value || 'Sans nom'; savePlans(); renderPrep(); };
  $('#p-ac').onchange = e => { curPlan().acId = e.target.value; savePlans(); renderLog(); };
  $('#p-wdir').onchange = e => { curPlan().wind.dir = numOrEmpty(e.target.value); savePlans(); renderLog(); };
  $('#p-wspd').onchange = e => { curPlan().wind.spd = numOrEmpty(e.target.value); savePlans(); renderLog(); };
  $('#p-onboard').onchange = e => { curPlan().onboard = numOrEmpty(e.target.value); savePlans(); renderLog(); };
  $('#p-extra').onchange = e => { curPlan().extraMin = numOrEmpty(e.target.value); savePlans(); renderLog(); };
  $('#p-reverse').onclick = () => { const p = curPlan(); p.wps.reverse(); planChanged(); };
  $('#p-clear').onclick = () => { if (confirm('Supprimer tous les points ?')) { curPlan().wps = []; planChanged(); } };
  $('#p-search').oninput = e => {
    const r = search(e.target.value);
    $('#p-results').innerHTML = r.map((p, i) => `<div data-i="${i}">${esc(ptLabel(p))}<br><small>${p.city ? esc(p.city) + ' · ' : ''}${N.fmtCoord(p.lat, p.lon)}</small></div>`).join('')
      || (e.target.value.length >= 2 ? `<div class="hint">${airports.length ? 'Aucun résultat' : 'Données terrains non chargées : Réglages → Données hors ligne'}</div>` : '');
    $('#p-results').querySelectorAll('[data-i]').forEach(d => d.onclick = () => {
      curPlan().wps.push(toWp(r[+d.dataset.i])); e.target.value = ''; $('#p-results').innerHTML = ''; planChanged();
    });
  };
  $('#p-activate').onclick = () => {
    const p = curPlan(); if (p.wps.length < 2) return toast('Il faut au moins 2 points');
    startPlanAt(1, p.id); showView('map'); setFollow(true);
  };

  /* ---------- Flotte ---------- */
  let editAc = null;
  function renderFleet() {
    $('#f-list').innerHTML = fleet.map(a => `<div class="item"><div class="info"><b>${esc(a.reg)}</b><span class="tag">${a.type === 'ulm' ? 'ULM' : 'Avion'}</span>
      <small>${esc(a.name)} · ${a.tas} kt · ${a.conso} L/h · ${a.capacity || '?'} L · réserve ${a.reserveMin} min</small></div><button class="sm ghost" data-e="${a.id}">Modifier</button></div>`).join('')
      || '<p class="hint">Aucun appareil.</p>';
    $('#f-list').querySelectorAll('[data-e]').forEach(b => b.onclick = () => openAc(fleet.find(a => a.id === b.dataset.e)));
  }
  function openAc(a) {
    editAc = a || null;
    const v = a || { type: 'avion', name: '', reg: '', tas: '', conso: '', capacity: '', taxi: 2, reserveMin: 30 };
    $('#f-title').textContent = a ? 'Modifier ' + a.reg : 'Nouvel appareil';
    $('#f-type').value = v.type; $('#f-name').value = v.name; $('#f-reg').value = v.reg; $('#f-tas').value = v.tas; $('#f-conso').value = v.conso;
    $('#f-cap').value = v.capacity; $('#f-taxi').value = v.taxi; $('#f-res').value = v.reserveMin;
    $('#f-del').classList.toggle('hidden', !a); $('#f-form').classList.remove('hidden'); $('#f-add').classList.add('hidden');
    $('#f-form').scrollIntoView({ behavior: 'smooth' });
  }
  const closeAc = () => { $('#f-form').classList.add('hidden'); $('#f-add').classList.remove('hidden'); };
  $('#f-add').onclick = () => openAc(null);
  $('#f-cancel').onclick = closeAc;
  $('#f-save').onclick = () => {
    const o = { type: $('#f-type').value, name: $('#f-name').value.trim(), reg: $('#f-reg').value.trim().toUpperCase() || '—',
      tas: +$('#f-tas').value || 0, conso: +$('#f-conso').value || 0, capacity: +$('#f-cap').value || 0, taxi: +$('#f-taxi').value || 0, reserveMin: +$('#f-res').value || 0 };
    if (!o.tas || !o.conso) return toast('Vitesse et consommation obligatoires');
    if (editAc) Object.assign(editAc, o); else fleet.push({ id: uid(), ...o });
    saveFleet(); closeAc(); renderFleet();
  };
  $('#f-del').onclick = () => {
    if (!editAc || !confirm('Supprimer ' + editAc.reg + ' ?')) return;
    fleet = fleet.filter(a => a.id !== editAc.id); saveFleet(); closeAc(); renderFleet();
  };

  /* ---------- Réglages ---------- */
  const alertTxt = s => s < 60 ? s + ' s' : (s % 60 ? N.fmtEte(s) : s / 60 + ' min');
  function renderSettings() {
    $('#s-alert').checked = S.alertOn; $('#s-alertsec').value = S.alertSec; $('#s-alertval').textContent = alertTxt(S.alertSec);
    $('#s-alertsec').disabled = !S.alertOn;
    $('#s-clock').value = S.clock; $('#s-theme').value = S.theme; $('#s-wake').checked = S.wake; $('#s-autorec').checked = S.autorec;
    $('#s-base').value = S.base; $('#s-custom').value = S.custom; $('#s-oaip').value = S.oaip; $('#s-oaipon').checked = S.oaipOn; $('#s-zmax').value = String(S.zmax);
    renderDataInfo();
    $('#s-userwps').innerHTML = userWps.length ? userWps.map(u => `<div class="row"><span class="lbl">${esc(u.name)} <small class="hint">${N.fmtCoord(u.lat, u.lon)}</small></span><button class="sm danger" data-u="${u.id}">✕</button></div>`).join('')
      : '<p class="hint">Aucun. Appui long sur la carte → « Enregistrer comme point perso ».</p>';
    $('#s-userwps').querySelectorAll('[data-u]').forEach(b => b.onclick = () => { userWps = userWps.filter(u => u.id !== b.dataset.u); saveUserWps(); refreshDataLayers(); renderSettings(); });
    $('#s-version').textContent = 'VFR Nav ' + VERSION + ' — aide à la navigation non certifiée';
  }
  const bindS = (sel, key, conv, after) => $(sel).addEventListener('change', e => { S[key] = conv(e.target); saveSettings(); renderSettings(); after && after(); });
  bindS('#s-alert', 'alertOn', t => t.checked);
  $('#s-alertsec').addEventListener('input', e => { S.alertSec = +e.target.value; saveSettings(); $('#s-alertval').textContent = alertTxt(S.alertSec); });
  bindS('#s-clock', 'clock', t => t.value, onFixUpdate);
  bindS('#s-theme', 'theme', t => t.value, applyTheme);
  bindS('#s-wake', 'wake', t => t.checked, wake);
  bindS('#s-autorec', 'autorec', t => t.checked);
  bindS('#s-base', 'base', t => t.value, setBase);
  bindS('#s-custom', 'custom', t => t.value.trim(), setBase);
  bindS('#s-oaip', 'oaip', t => t.value.trim(), setBase);
  bindS('#s-oaipon', 'oaipOn', t => t.checked, setBase);
  bindS('#s-zmax', 'zmax', t => +t.value);
  $('#s-update').onclick = updateData;
  $('#s-sim').onclick = toggleSim;

  /* Cartes hors ligne */
  const tileKey = u => u.replace(/:\/\/[abc]\.tile\.opentopomap\.org/, '://tile.opentopomap.org');
  function tileTemplates() {
    const b = baseDef(), out = [b.tiles[0]];
    if (S.oaipOn && S.oaip) out.push(oaipUrl());
    return out;
  }
  function tilesAround(points, radiusNM, zmin, zmax) {
    const set = new Set(), list = [];
    for (let z = zmin; z <= zmax; z++) for (const pt of points) {
      const dLat = radiusNM / 60, dLon = radiusNM / (60 * Math.cos(pt.lat * Math.PI / 180));
      for (const t of N.tilesForBBox(pt.lat - dLat, pt.lon - dLon, pt.lat + dLat, pt.lon + dLon, z)) { const k = t.join('/'); if (!set.has(k)) { set.add(k); list.push(t); } }
    }
    return list;
  }
  function corridorPoints(wps) {
    const pts = [];
    for (let i = 0; i < wps.length; i++) {
      pts.push(wps[i]); if (i === 0) continue;
      const a = wps[i - 1], b = wps[i], d = N.distNM(a.lat, a.lon, b.lat, b.lon), n = Math.ceil(d / 5);
      for (let k = 1; k < n; k++) pts.push({ lat: a.lat + (b.lat - a.lat) * k / n, lon: a.lon + (b.lon - a.lon) * k / n });
    }
    return pts;
  }
  async function downloadTiles(tiles) {
    if (S.base === 'osm') return toast('Le serveur OpenStreetMap interdit le téléchargement en masse : choisis OpenTopoMap ou une URL perso.', 5000);
    const tpls = tileTemplates(), jobs = [];
    for (const tpl of tpls) for (const [z, x, y] of tiles) jobs.push(tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y));
    if (jobs.length > 6000) return toast(`${jobs.length} tuiles : trop. Baisse le zoom max ou réduis la zone.`, 5000);
    if (!confirm(`Télécharger ${jobs.length} tuiles (~${Math.round(jobs.length * 0.02)} Mo) ?`)) return;
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
    const cache = await caches.open('vfrnav-tiles'), info = $('#s-dlinfo');
    let done = 0, fail = 0, i = 0;
    const worker = async () => {
      while (i < jobs.length) {
        const url = jobs[i++];
        try {
          const key = tileKey(url);
          if (!(await cache.match(key))) { const r = await fetch(url, { mode: 'cors' }); if (r.ok) await cache.put(key, r); else fail++; }
        } catch (e) { fail++; }
        done++; if (done % 20 === 0 || done === jobs.length) info.textContent = `Téléchargement : ${done}/${jobs.length}${fail ? ` (${fail} échecs)` : ''}`;
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    info.textContent = `Terminé : ${done - fail} tuiles en cache${fail ? `, ${fail} échecs` : ''}.`;
  }
  $('#s-dlroute').onclick = () => {
    const p = curPlan(); if (!p || p.wps.length < 1) return toast('Le vol actif ne contient pas de points');
    downloadTiles(tilesAround(corridorPoints(p.wps), 15, 6, S.zmax));
  };
  $('#s-dlview').onclick = () => {
    if (!map) return; const b = map.getBounds(); const t = [];
    const z0 = Math.max(5, Math.floor(map.getZoom()) - 2);
    for (let z = z0; z <= S.zmax; z++) t.push(...N.tilesForBBox(b.getSouth(), b.getWest(), b.getNorth(), b.getEast(), z));
    downloadTiles(t);
  };
  $('#s-clearcache').onclick = async () => { if (confirm('Supprimer toutes les cartes en cache ?')) { await caches.delete('vfrnav-tiles'); $('#s-dlinfo').textContent = 'Cache vidé.'; } };

  /* Sauvegarde */
  $('#s-export').onclick = () => shareFile('vfrnav-sauvegarde.json', JSON.stringify({ app: 'vfrnav', v: 1, fleet, plans, userWps, settings: S }, null, 1), 'application/json');
  $('#s-import').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const d = JSON.parse(await f.text()); if (d.app !== 'vfrnav') throw new Error('format');
      const merge = (cur, inc) => { const ids = new Set(cur.map(x => x.id)); return cur.concat((inc || []).filter(x => !ids.has(x.id))); };
      fleet = merge(fleet, d.fleet); plans = merge(plans, d.plans); userWps = merge(userWps, d.userWps);
      saveFleet(); savePlans(); saveUserWps(); refreshDataLayers(); renderSettings();
      toast('Import réussi (ajouté sans écraser)');
    } catch (err) { toast('Fichier invalide'); }
    e.target.value = '';
  };

  /* ---------- Écran allumé ---------- */
  let wakeLock = null;
  async function wake() {
    try {
      if (S.wake && 'wakeLock' in navigator && document.visibilityState === 'visible') { if (!wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } }
      else if (!S.wake && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch (e) { /* non supporté */ }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wake(); else if (rec) IDB.putTrack(rec); });
  window.addEventListener('pagehide', () => { if (rec) IDB.putTrack(rec); });
  document.addEventListener('touchend', wake, { once: true });

  /* ---------- Démarrage ---------- */
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW', e));
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  initMap(); updateOrientBtn(); updateNavButtons(); onFixUpdate();
  loadData();
  startGps(); wake();
  // traces interrompues (app fermée en vol) : marquées terminées
  IDB.allTracks().then(ts => ts.filter(t => !t.done).forEach(t => { t.done = true; IDB.putTrack(t); })).catch(() => {});
  if (!LS.get('dataDate', null)) setTimeout(() => toast('Premier lancement : Réglages → « Télécharger les terrains » pour charger les aérodromes.', 6000), 1500);
})();
