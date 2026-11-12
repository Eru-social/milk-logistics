// КАРТА. Только рисует: получает готовые маршруты и ничего не знает про расчёт.
// Умеет два режима:
//   1) настоящая карта (библиотека MapLibre + бесплатные плитки OpenFreeMap);
//   2) запасная схема без подложки, если интернета или карты нет. Демо не падает в любом случае.
(function () {
  'use strict';
  var STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
  var ROAD_URL = 'https://router.project-osrm.org/route/v1/driving/';   // открытый демо-сервер дорог, только для прототипа
  var el, map = null, mode = 'none', ready = false, lastModel = null, onPick = null, depotMarker = null, popup = null;
  var roadCache = {};

  function init(element, depot, pickHandler) {
    el = element; onPick = pickHandler;
    if (!window.maplibregl) { mode = 'svg'; return Promise.resolve(mode); }
    // Проверяем, что сервер карты отвечает; если нет — рисуем схему.
    var timer, ctrl = new AbortController();
    timer = setTimeout(function () { ctrl.abort(); }, 5000);
    return fetch(STYLE_URL, { signal: ctrl.signal }).then(function (r) {
      clearTimeout(timer);
      if (!r.ok) throw new Error('style');
      startMapLibre(depot);
      return mode;
    }).catch(function () { clearTimeout(timer); mode = 'svg'; if (lastModel) draw(lastModel); return mode; });
  }

  function startMapLibre(depot) {
    mode = 'maplibre';
    map = new maplibregl.Map({ container: el, style: STYLE_URL, center: [depot.lon, depot.lat], zoom: 11.2 });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.on('load', function () {
      map.addSource('routes', { type: 'geojson', data: empty() });
      map.addSource('stops', { type: 'geojson', data: empty() });
      // Пока линия по улицам не загружена, маршрут показан тонким пунктиром.
      map.addLayer({ id: 'routes-pending', type: 'line', source: 'routes', filter: ['==', ['get', 'pending'], true],
        paint: { 'line-color': ['get', 'color'], 'line-width': 1.5, 'line-dasharray': [1, 3],
          'line-opacity': ['case', ['get', 'dim'], 0.15, 0.5] } });
      map.addLayer({ id: 'routes-line', type: 'line', source: 'routes', filter: ['==', ['get', 'pending'], false],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-width': ['case', ['get', 'sel'], 5, 2.5],
          'line-opacity': ['case', ['get', 'dim'], 0.3, 0.85] } });
      map.addLayer({ id: 'stops-circle', type: 'circle', source: 'stops',
        paint: { 'circle-color': ['get', 'color'], 'circle-radius': ['case', ['get', 'sel'], 9, 5],
          'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5, 'circle-opacity': ['case', ['get', 'dim'], 0.45, 1],
          'circle-stroke-opacity': ['case', ['get', 'dim'], 0.45, 1] } });
      map.addLayer({ id: 'stops-num', type: 'symbol', source: 'stops', filter: ['==', ['get', 'sel'], true],
        layout: { 'text-field': ['get', 'n'], 'text-size': 11, 'text-font': ['Noto Sans Bold'], 'text-allow-overlap': true },
        paint: { 'text-color': '#ffffff' } });
      map.on('click', 'stops-circle', function (e) {
        var f = e.features[0];
        if (popup) popup.remove();
        popup = new maplibregl.Popup({ closeButton: false }).setLngLat(f.geometry.coordinates).setHTML(f.properties.html).addTo(map);
        if (onPick) onPick(f.properties.k);
      });
      map.on('click', 'routes-line', function (e) { if (onPick) onPick(e.features[0].properties.k); });
      map.on('mouseenter', 'stops-circle', function () { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'stops-circle', function () { map.getCanvas().style.cursor = ''; });
      var pin = document.createElement('div'); pin.className = 'depot-pin'; pin.title = 'Завод, Гаспадарчая, 28';
      depotMarker = new maplibregl.Marker({ element: pin }).setLngLat([depot.lon, depot.lat]).addTo(map);
      ready = true;
      if (lastModel) draw(lastModel, true);
    });
    map.on('error', function () { /* одиночные ошибки плиток не должны ломать страницу */ });
  }

  function empty() { return { type: 'FeatureCollection', features: [] }; }

  // model = { depot, selected, routes: [{ k, color, name, road, points: [{lat, lon, n, html}] }] }
  function draw(model, fit) {
    lastModel = model;
    if (mode === 'svg') return drawSvg(model);
    if (mode !== 'maplibre' || !ready) return;
    var lines = [], pts = [], hasSel = model.selected >= 0, box = null;
    function grow(lon, lat) {
      if (!box) box = [lon, lat, lon, lat];
      box[0] = Math.min(box[0], lon); box[1] = Math.min(box[1], lat); box[2] = Math.max(box[2], lon); box[3] = Math.max(box[3], lat);
    }
    grow(model.depot.lon, model.depot.lat);
    model.routes.forEach(function (r) {
      var sel = r.k === model.selected, dim = hasSel && !sel;
      var coords = [[model.depot.lon, model.depot.lat]];
      r.points.forEach(function (p) {
        coords.push([p.lon, p.lat]); grow(p.lon, p.lat);
        pts.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
          properties: { k: r.k, color: p.color || r.color, sel: sel, dim: dim, n: String(p.n), html: p.html } });
      });
      coords.push([model.depot.lon, model.depot.lat]);
      lines.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: r.road || coords },
        properties: { k: r.k, color: r.color, sel: sel, dim: dim, pending: !r.road } });
    });
    // Выбранный маршрут рисуем последним, чтобы он лежал поверх остальных.
    lines.sort(function (a, b) { return (a.properties.sel ? 1 : 0) - (b.properties.sel ? 1 : 0); });
    pts.sort(function (a, b) { return (a.properties.sel ? 1 : 0) - (b.properties.sel ? 1 : 0); });
    map.getSource('routes').setData({ type: 'FeatureCollection', features: lines });
    map.getSource('stops').setData({ type: 'FeatureCollection', features: pts });
    if (fit && box) map.fitBounds([[box[0], box[1]], [box[2], box[3]]], { padding: 40, duration: 0 });
  }

  // ---------- запасная схема ----------
  function drawSvg(model) {
    var W = 1000, H = 700, pad = 30, all = [model.depot];
    model.routes.forEach(function (r) { r.points.forEach(function (p) { all.push(p); }); });
    var minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    all.forEach(function (p) { minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat); minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon); });
    var kx = Math.cos((minLat + maxLat) / 2 * Math.PI / 180);
    var sx = (maxLon - minLon) * kx || 1, sy = (maxLat - minLat) || 1;
    var scale = Math.min((W - 2 * pad) / sx, (H - 2 * pad) / sy);
    var ox = (W - sx * scale) / 2, oy = (H - sy * scale) / 2;
    function X(p) { return (ox + (p.lon - minLon) * kx * scale).toFixed(1); }
    function Y(p) { return (oy + (maxLat - p.lat) * scale).toFixed(1); }
    var hasSel = model.selected >= 0, back = '', front = '';
    model.routes.forEach(function (r) {
      var sel = r.k === model.selected, dim = hasSel && !sel, s = '';
      var d = 'M' + X(model.depot) + ' ' + Y(model.depot);
      if (r.road) r.road.forEach(function (c) { d += ' L' + X({ lon: c[0], lat: c[1] }) + ' ' + Y({ lon: c[0], lat: c[1] }); });
      else { r.points.forEach(function (p) { d += ' L' + X(p) + ' ' + Y(p); }); d += ' Z'; }
      s += '<path data-k="' + r.k + '" d="' + d + '" fill="none" stroke="' + r.color + '" stroke-width="' + (sel ? 4 : (r.road ? 2 : 1.2)) +
        '"' + (r.road ? '' : ' stroke-dasharray="2 6"') + ' stroke-linejoin="round" opacity="' + (dim ? 0.3 : 0.85) + '" style="cursor:pointer"/>';
      r.points.forEach(function (p) {
        s += '<g data-k="' + r.k + '" opacity="' + (dim ? 0.45 : 1) + '" style="cursor:pointer"><circle cx="' + X(p) + '" cy="' + Y(p) + '" r="' + (sel ? 9 : 5) +
          '" fill="' + (p.color || r.color) + '" stroke="#fff" stroke-width="1.5"><title>' + p.title + '</title></circle>' +
          (sel ? '<text x="' + X(p) + '" y="' + (+Y(p) + 3.5) + '" text-anchor="middle" font-size="10" font-weight="700" fill="#fff" pointer-events="none">' + p.n + '</text>' : '') + '</g>';
      });
      if (sel) front += s; else back += s;
    });
    var depot = '<rect x="' + (X(model.depot) - 9) + '" y="' + (Y(model.depot) - 9) + '" width="18" height="18" rx="4" fill="var(--ink)" stroke="#fff" stroke-width="2.5"><title>Завод, Гаспадарчая, 28</title></rect>';
    el.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Схема маршрутов">' + back + front + depot + '</svg>';
    el.querySelectorAll('[data-k]').forEach(function (node) {
      node.addEventListener('click', function () { if (onPick) onPick(+node.getAttribute('data-k')); });
    });
  }

  // ЛИНИЯ ПО УЛИЦАМ для одного маршрута. Возвращает { coords, km, min } или null, если сервис недоступен.
  // Запросы идут по одному с паузой (у бесплатного сервера ограничение), готовые линии запоминаются
  // в памяти и в браузере, поэтому повторный показ того же маршрута мгновенный.
  var CACHE_KEY = 'milk.roadlines.v1', CACHE_MAX = 60, queue = Promise.resolve(), stored = null;
  function readStored() {
    if (stored) return stored;
    try { stored = JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; } catch (e) { stored = {}; }
    return stored;
  }
  function writeStored(path, value) {
    var all = readStored(), keys;
    all[path] = value;
    keys = Object.keys(all);
    while (keys.length > CACHE_MAX) delete all[keys.shift()];      // самые старые линии выбрасываем
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(all)); } catch (e) { /* хранилище переполнено — не страшно */ }
  }
  function wait(ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); }
  function fetchRoad(path, attempt) {
    return fetch(ROAD_URL + path + '?overview=full&geometries=geojson').then(function (r) {
      if (r.status === 429 && attempt < 2) return wait(2500).then(function () { return fetchRoad(path, attempt + 1); });
      return r.json();
    }).then(function (j) {
      if (!j || !j.routes || !j.routes.length) return null;
      return { coords: j.routes[0].geometry.coordinates.map(function (c) { return [+c[0].toFixed(5), +c[1].toFixed(5)]; }),
        km: j.routes[0].distance / 1000, min: j.routes[0].duration / 60 };
    }).catch(function () { return null; });
  }
  function roadPath(depot, points) {
    return [depot].concat(points, [depot]).map(function (p) { return p.lon.toFixed(5) + ',' + p.lat.toFixed(5); }).join(';');
  }
  // Уже известная линия (без запроса) или null.
  function roadCached(depot, points) {
    var path = roadPath(depot, points);
    return roadCache[path] || readStored()[path] || null;
  }
  function roadRoute(depot, points) {
    var path = roadPath(depot, points), hit = roadCached(depot, points);
    if (hit) { roadCache[path] = hit; return Promise.resolve(hit); }
    var result = queue.then(function () {
      if (roadCache[path]) return roadCache[path];
      return fetchRoad(path, 0).then(function (out) {
        if (out) { roadCache[path] = out; writeStored(path, out); }
        return wait(350).then(function () { return out; });
      });
    });
    queue = result.catch(function () { return null; });
    return result;
  }

  window.MilkMap = { init: init, draw: draw, roadRoute: roadRoute, roadCached: roadCached, mode: function () { return mode; } };
})();
