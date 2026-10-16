/* VFR Nav — calculs de navigation (purs, testables) */
(function (root) {
  'use strict';
  const R_NM = 3440.065; // rayon terrestre moyen en NM
  const rad = d => d * Math.PI / 180;
  const deg = r => r * 180 / Math.PI;
  const norm360 = a => ((a % 360) + 360) % 360;
  const angDiff = (a, b) => { let d = norm360(a - b); return d > 180 ? d - 360 : d; }; // a - b dans [-180,180]

  function distNM(lat1, lon1, lat2, lon2) {
    const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function bearing(lat1, lon1, lat2, lon2) {
    const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
    const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
    return norm360(deg(Math.atan2(y, x)));
  }

  /* Triangle des vitesses.
     tc : route vraie (°), tas : vitesse propre (kt), wdir : direction d'OÙ vient le vent (° vrai), wspd : kt
     Retourne { wca (dérive à corriger, + = à droite), th (cap vrai), gs (vitesse sol) } ou null si impossible */
  function windTriangle(tc, tas, wdir, wspd) {
    if (!(tas > 0)) return null;
    if (!wspd) return { wca: 0, th: norm360(tc), gs: tas };
    const w = rad(wdir - tc);
    const s = wspd * Math.sin(w) / tas;
    if (Math.abs(s) > 1) return null;
    const wca = Math.asin(s);
    const gs = tas * Math.cos(wca) - wspd * Math.cos(w);
    if (gs <= 0) return null;
    return { wca: deg(wca), th: norm360(tc + deg(wca)), gs };
  }

  /* Calcule le log de nav. wps : [{name,lat,lon,alt,wdir,wspd}], ac : {tas, conso}, wind : {dir,spd} */
  function computeLog(wps, ac, wind) {
    const legs = [];
    let totDist = 0, totMin = 0, totFuel = 0, ok = true;
    for (let i = 1; i < wps.length; i++) {
      const a = wps[i - 1], b = wps[i];
      const useOwn = b.wspd !== undefined && b.wspd !== null && b.wspd !== '' && !isNaN(+b.wspd);
      const wdir = useOwn ? +b.wdir || 0 : +(wind && wind.dir) || 0;
      const wspd = useOwn ? +b.wspd : +(wind && wind.spd) || 0;
      const dist = distNM(a.lat, a.lon, b.lat, b.lon);
      const tc = bearing(a.lat, a.lon, b.lat, b.lon);
      const wt = windTriangle(tc, +ac.tas, wdir, wspd);
      if (!wt) ok = false;
      const gs = wt ? wt.gs : NaN;
      const min = wt ? dist / gs * 60 : NaN;
      const fuel = wt ? min / 60 * (+ac.conso || 0) : NaN;
      totDist += dist; totMin += min; totFuel += fuel;
      legs.push({ from: a.name, to: b.name, tc, dist, wca: wt ? wt.wca : NaN, th: wt ? wt.th : NaN, gs, min, fuel, cumMin: totMin, cumDist: totDist, alt: b.alt, wdir, wspd });
    }
    return { legs, totDist, totMin, totFuel, ok };
  }

  /* Bilan carburant (litres) */
  function fuelBalance(log, ac, opts) {
    const conso = +ac.conso || 0;
    const taxi = +ac.taxi || 0;
    const trip = log.totFuel || 0;
    const reserve = (+ac.reserveMin || 0) / 60 * conso;
    const extra = (+opts.extraMin || 0) / 60 * conso;
    const required = taxi + trip + reserve + extra;
    const onboard = opts.onboard === '' || opts.onboard === undefined || opts.onboard === null ? NaN : +opts.onboard;
    const margin = onboard - required;
    const endurMin = conso > 0 ? (onboard - taxi) / conso * 60 : NaN;
    return { taxi, trip, reserve, extra, required, onboard, margin, endurMin, overCapacity: ac.capacity ? required > +ac.capacity : false };
  }

  function fmtDur(min) {
    if (!isFinite(min) || min < 0) return '—';
    const t = Math.round(min);
    if (t < 60) return t + ' min';
    return Math.floor(t / 60) + 'h' + String(t % 60).padStart(2, '0');
  }
  function fmtEte(sec) {
    if (!isFinite(sec) || sec < 0) return '—';
    sec = Math.round(sec);
    if (sec >= 3600) return Math.floor(sec / 3600) + 'h' + String(Math.floor(sec % 3600 / 60)).padStart(2, '0');
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }
  function fmtClock(date, utc) {
    const h = utc ? date.getUTCHours() : date.getHours();
    const m = utc ? date.getUTCMinutes() : date.getMinutes();
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + (utc ? 'Z' : '');
  }
  const fmtHdg = h => isFinite(h) ? String(Math.round(norm360(h)) || 360).padStart(3, '0') + '°' : '—';
  function fmtCoord(lat, lon) {
    const f = (v, p, n) => { const a = Math.abs(v), d = Math.floor(a), m = (a - d) * 60; return d + '°' + m.toFixed(2).padStart(5, '0') + "'" + (v >= 0 ? p : n); };
    return f(lat, 'N', 'S') + ' ' + f(lon, 'E', 'W');
  }

  /* Parseur CSV (guillemets, virgules et retours ligne dans les champs) */
  function parseCSV(text, onRow) {
    let row = [], field = '', q = false, header = null;
    const n = text.length;
    const push = () => {
      row.push(field); field = '';
      if (!header) header = row; else if (row.length > 1 || row[0] !== '') {
        const o = {}; for (let k = 0; k < header.length; k++) o[header[k]] = row[k];
        onRow(o);
      }
      row = [];
    };
    for (let i = 0; i < n; i++) {
      const c = text.charCodeAt(i);
      if (q) {
        if (c === 34) { if (text.charCodeAt(i + 1) === 34) { field += '"'; i++; } else q = false; }
        else field += text[i];
      } else if (c === 34) q = true;
      else if (c === 44) { row.push(field); field = ''; }
      else if (c === 10) push();
      else if (c !== 13) field += text[i];
    }
    if (field !== '' || row.length) push();
  }

  /* Tuiles slippy-map couvrant une emprise */
  function tilesForBBox(minLat, minLon, maxLat, maxLon, z) {
    const n = 2 ** z;
    const x = lon => Math.floor((lon + 180) / 360 * n);
    const y = lat => { const r = rad(lat); return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n); };
    const out = [];
    for (let tx = x(minLon); tx <= x(maxLon); tx++) for (let ty = y(maxLat); ty <= y(minLat); ty++) out.push([z, tx, ty]);
    return out;
  }

  const Nav = { distNM, bearing, windTriangle, computeLog, fuelBalance, fmtDur, fmtEte, fmtClock, fmtHdg, fmtCoord, parseCSV, tilesForBBox, norm360, angDiff };
  if (typeof module !== 'undefined' && module.exports) module.exports = Nav; else root.Nav = Nav;
})(typeof window !== 'undefined' ? window : globalThis);
