// КАРТА. Только рисует: получает готовые маршруты и ничего не знает про расчёт.
// Умеет два режима:
//   1) настоящая карта (библиотека MapLibre + бесплатные плитки OpenFreeMap);
//   2) запасная схема без подложки, если интернета или карты нет. Демо не падает в любом случае.
// С 15 ноября (правки автора): кружки остановок, которые легли друг на друга, раздвигаются (spread);
// focus(...) показывает заказ, выбранный в таблице слева: подлёт, кольцо, подпись.
(function () {
  'use strict';
  var STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
  var ROAD_URL = 'https://router.project-osrm.org/route/v1/driving/';   // открытый демо-сервер дорог, только для прототипа
  var el, map = null, mode = 'none', ready = false, lastModel = null, onPick = null, depotMarker = null, popup = null;
  var roadCache = {}, markPins = [];
  var stopFeatures = [], stopOids = [], popupOid = null, focused = null;   // для раздвигания точек и показа заказа

  // ---------- точки рядом не сливаются ----------
  // Две остановки по одному адресу (повтор магазина — отдельная остановка, их шесть) или в соседних домах
  // на экране ложатся кружок на кружок и выглядят как одна. Поэтому перед показом кружки раздвигаются, чтобы
  // не перекрываться. Каждый уходит от своего настоящего места не дальше MAX_SHIFT пикселей; линии маршрутов
  // не сдвигаются. Расстояния на экране зависят от масштаба, поэтому после приближения карты считается заново.
  // items: [{ x, y, r }] — место на экране и радиус кружка; функция дописывает sx, sy — куда его нарисовать.
  var MAX_SHIFT = 16;
  function spread(items) {
    items.forEach(function (it) { it.sx = it.x; it.sy = it.y; });
    function clamp(it) {
      var dx = it.sx - it.x, dy = it.sy - it.y, d = Math.sqrt(dx * dx + dy * dy);
      if (d > MAX_SHIFT) { it.sx = it.x + dx / d * MAX_SHIFT; it.sy = it.y + dy / d * MAX_SHIFT; }
    }
    for (var round = 0; round < 40; round++) {
      var moved = false;
      for (var i = 0; i < items.length; i++) {
        for (var j = i + 1; j < items.length; j++) {
          var a = items[i], b = items[j], need = a.r + b.r + 3, dx = b.sx - a.sx, dy = b.sy - a.sy;
          if (Math.abs(dx) >= need || Math.abs(dy) >= need) continue;     // далеко — не считаем корень
          var d = Math.sqrt(dx * dx + dy * dy), ux, uy;
          if (d >= need) continue;
          // Точки ровно в одном месте: направление берём «золотым углом» по номеру, чтобы они расходились веером.
          if (d < 0.01) { ux = Math.cos(j * 2.39996); uy = Math.sin(j * 2.39996); d = 0; } else { ux = dx / d; uy = dy / d; }
          var push = (need - d) / 2;
          a.sx -= ux * push; a.sy -= uy * push; b.sx += ux * push; b.sy += uy * push;
          clamp(a); clamp(b); moved = true;
        }
      }
      if (!moved) break;
    }
    return items;
  }

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
      // Кольцо вокруг заказа, выбранного в таблице слева.
      map.addLayer({ id: 'stops-focus', type: 'circle', source: 'stops', filter: ['==', ['get', 'focus'], true],
        paint: { 'circle-radius': 15, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#13212c', 'circle-stroke-width': 3 } });
      map.addLayer({ id: 'stops-circle', type: 'circle', source: 'stops',
        paint: { 'circle-color': ['get', 'color'], 'circle-radius': ['case', ['get', 'sel'], 9, 5],
          'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5, 'circle-opacity': ['case', ['get', 'dim'], 0.45, 1],
          'circle-stroke-opacity': ['case', ['get', 'dim'], 0.45, 1] } });
      map.addLayer({ id: 'stops-num', type: 'symbol', source: 'stops', filter: ['==', ['get', 'sel'], true],
        layout: { 'text-field': ['get', 'n'], 'text-size': 11, 'text-font': ['Noto Sans Bold'], 'text-allow-overlap': true },
        paint: { 'text-color': '#ffffff' } });
      map.on('click', 'stops-circle', function (e) {
        var f = e.features[0];
        showPopup(f.geometry.coordinates, f.properties.html, +f.properties.oid || null, false);
        if (onPick) onPick(f.properties.k);
      });
      map.on('zoomend', layoutStops);       // масштаб поменялся — точки раздвигаются заново
      map.on('click', 'routes-line', function (e) { if (onPick) onPick(e.features[0].properties.k); });
      map.on('mouseenter', 'stops-circle', function () { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'stops-circle', function () { map.getCanvas().style.cursor = ''; });
      var pin = document.createElement('div'); pin.className = 'depot-pin'; pin.title = 'Завод, Гаспадарчая, 28';
      depotMarker = new maplibregl.Marker({ element: pin }).setLngLat([depot.lon, depot.lat]).addTo(map);
      ready = true;
      if (lastModel) draw(lastModel, true);
      if (focused) showFocus();            // заказ выбрали, пока карта загружалась
    });
    map.on('error', function () { /* одиночные ошибки плиток не должны ломать страницу */ });
  }

  function empty() { return { type: 'FeatureCollection', features: [] }; }

  // model = { depot, selected, routes: [{ k, color, name, road, open, points: [{lat, lon, n, html}], path }], marks: [{lat, lon, title}] }
  // open — маршрут не возвращается на завод (сломанная машина); path — через что идёт линия, если это не только остановки;
  // marks — крестики на карте (где стоит сломанная машина).
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
      (r.path || r.points).forEach(function (p) { coords.push([p.lon, p.lat]); });
      r.points.forEach(function (p) {
        grow(p.lon, p.lat);
        pts.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, oids: p.oids || [], orig: [p.lon, p.lat],
          properties: { k: r.k, color: p.color || r.color, sel: sel, dim: dim, n: String(p.n), html: p.html, oid: (p.oids || [0])[0], focus: false } });
      });
      if (!r.open) coords.push([model.depot.lon, model.depot.lat]);
      lines.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: r.road || coords },
        properties: { k: r.k, color: r.color, sel: sel, dim: dim, pending: !r.road } });
    });
    // Выбранный маршрут рисуем последним, чтобы он лежал поверх остальных.
    lines.sort(function (a, b) { return (a.properties.sel ? 1 : 0) - (b.properties.sel ? 1 : 0); });
    pts.sort(function (a, b) { return (a.properties.sel ? 1 : 0) - (b.properties.sel ? 1 : 0); });
    map.getSource('routes').setData({ type: 'FeatureCollection', features: lines });
    markPins.forEach(function (m) { m.remove(); });
    markPins = (model.marks || []).map(function (m) {
      var pin = document.createElement('div'); pin.className = 'broken-pin'; pin.title = m.title; pin.textContent = '✕';
      return new maplibregl.Marker({ element: pin }).setLngLat([m.lon, m.lat]).addTo(map);
    });
    if (fit && box) { map.resize(); map.fitBounds([[box[0], box[1]], [box[2], box[3]]], { padding: 40, duration: 0 }); }
    // Сведения для раздвигания хранятся рядом с точками, на карту уходят только координаты и свойства.
    stopOids = pts.map(function (f) { return f.oids; });
    stopFeatures = pts.map(function (f) { return { type: 'Feature', orig: f.orig, geometry: f.geometry, properties: f.properties }; });
    layoutStops();
  }
  // Раздвигаем точки на экране (spread) и отдаём карте; подпись открытой точки едет вместе с ней.
  function layoutStops() {
    if (mode !== 'maplibre' || !ready) return;
    var items = stopFeatures.map(function (f, i) {
      var px = map.project(f.orig);
      f.properties.focus = !!(focused && stopOids[i].indexOf(focused.oid) >= 0);
      return { x: px.x, y: px.y, r: f.properties.sel ? 9 : 5 };
    });
    spread(items);
    stopFeatures.forEach(function (f, i) {
      var it = items[i], ll = it.sx === it.x && it.sy === it.y ? null : map.unproject([it.sx, it.sy]);
      f.geometry = { type: 'Point', coordinates: ll ? [ll.lng, ll.lat] : f.orig };
    });
    map.getSource('stops').setData({ type: 'FeatureCollection', features: stopFeatures.map(function (f) {
      return { type: 'Feature', geometry: f.geometry, properties: f.properties };
    }) });
    if (popup && popupOid) { var at = coordsOf(popupOid); if (at) popup.setLngLat(at); }
  }
  // Где сейчас нарисована точка заказа (после раздвигания) или null, если её нет в маршрутах.
  function coordsOf(oid) {
    for (var i = 0; i < stopFeatures.length; i++) if (stopOids[i].indexOf(oid) >= 0) return stopFeatures[i].geometry.coordinates;
    return null;
  }
  function showPopup(at, html, oid, isFocus) {
    if (popup) { var old = popup; popup = null; old.remove(); }
    var pp = new maplibregl.Popup({ closeButton: isFocus, maxWidth: '280px' }).setLngLat(at).setHTML(html).addTo(map);
    pp.on('close', function () {
      if (popup !== pp) return;                       // закрыли старую подпись, потому что открыли новую
      popup = null; popupOid = null;
      if (isFocus) { focused = null; layoutStops(); }  // кольцо вокруг заказа убираем вместе с подписью
    });
    popup = pp; popupOid = oid;
  }

  // ---------- показать заказ на карте (клик в таблице заказов) ----------
  // target = { oid, lat, lon, html }. Карта подлетает к точке, вокруг неё кольцо, открыта подпись.
  function focus(target) {
    focused = target;
    if (mode === 'svg') { if (lastModel) drawSvg(lastModel); return; }
    if (mode === 'maplibre' && ready) showFocus();
  }
  function showFocus() {
    layoutStops();
    var at = coordsOf(focused.oid) || [focused.lon, focused.lat];
    showPopup(at, focused.html, focused.oid, true);
    var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    map.flyTo({ center: at, zoom: Math.max(map.getZoom(), 14.5), duration: still ? 0 : 800 });
  }

  // ---------- запасная схема ----------
  function drawSvg(model) {
    var W = 1000, H = 700, pad = 30, all = [model.depot];
    model.routes.forEach(function (r) { r.points.forEach(function (p) { all.push(p); }); });
    if (focused && isFinite(focused.lat) && isFinite(focused.lon)) all.push(focused);   // заказ не в маршрутах тоже должен попасть на схему
    var minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    all.forEach(function (p) { minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat); minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon); });
    var kx = Math.cos((minLat + maxLat) / 2 * Math.PI / 180);
    var sx = (maxLon - minLon) * kx || 1, sy = (maxLat - minLat) || 1;
    var scale = Math.min((W - 2 * pad) / sx, (H - 2 * pad) / sy);
    var ox = (W - sx * scale) / 2, oy = (H - sy * scale) / 2;
    function X(p) { return (ox + (p.lon - minLon) * kx * scale).toFixed(1); }
    function Y(p) { return (oy + (maxLat - p.lat) * scale).toFixed(1); }
    var hasSel = model.selected >= 0, back = '', front = '', ring = '';
    // Раздвигаем кружки так же, как на карте (spread); на схеме единица — точка рисунка, а не пиксель.
    var items = [], at = [];
    model.routes.forEach(function (r) {
      at.push(r.points.map(function (p) {
        var it = { x: +X(p), y: +Y(p), r: r.k === model.selected ? 9 : 5 };
        items.push(it); return it;
      }));
    });
    spread(items);
    model.routes.forEach(function (r, ri) {
      var sel = r.k === model.selected, dim = hasSel && !sel, s = '';
      r.points.forEach(function (p, pi) {
        p.sx = at[ri][pi].sx.toFixed(1); p.sy = at[ri][pi].sy.toFixed(1);
        if (focused && (p.oids || []).indexOf(focused.oid) >= 0) ring = '<circle cx="' + p.sx + '" cy="' + p.sy + '" r="16" fill="none" stroke="var(--ink)" stroke-width="3"/>';
      });
      var d = 'M' + X(model.depot) + ' ' + Y(model.depot);
      if (r.road) r.road.forEach(function (c) { d += ' L' + X({ lon: c[0], lat: c[1] }) + ' ' + Y({ lon: c[0], lat: c[1] }); });
      else { (r.path || r.points).forEach(function (p) { d += ' L' + X(p) + ' ' + Y(p); }); if (!r.open) d += ' Z'; }
      s += '<path data-k="' + r.k + '" d="' + d + '" fill="none" stroke="' + r.color + '" stroke-width="' + (sel ? 4 : (r.road ? 2 : 1.2)) +
        '"' + (r.road ? '' : ' stroke-dasharray="2 6"') + ' stroke-linejoin="round" opacity="' + (dim ? 0.3 : 0.85) + '" style="cursor:pointer"/>';
      r.points.forEach(function (p) {
        s += '<g data-k="' + r.k + '" opacity="' + (dim ? 0.45 : 1) + '" style="cursor:pointer"><circle cx="' + p.sx + '" cy="' + p.sy + '" r="' + (sel ? 9 : 5) +
          '" fill="' + (p.color || r.color) + '" stroke="#fff" stroke-width="1.5"><title>' + p.title + '</title></circle>' +
          (sel ? '<text x="' + p.sx + '" y="' + (+p.sy + 3.5) + '" text-anchor="middle" font-size="10" font-weight="700" fill="#fff" pointer-events="none">' + p.n + '</text>' : '') + '</g>';
      });
      if (sel) front += s; else back += s;
    });
    var depot = '<rect x="' + (X(model.depot) - 9) + '" y="' + (Y(model.depot) - 9) + '" width="18" height="18" rx="4" fill="var(--ink)" stroke="#fff" stroke-width="2.5"><title>Завод, Гаспадарчая, 28</title></rect>';
    var crosses = (model.marks || []).map(function (m) {
      return '<text x="' + X(m) + '" y="' + (+Y(m) + 7) + '" text-anchor="middle" font-size="22" font-weight="700" fill="#c22b38" stroke="#fff" stroke-width="1" paint-order="stroke">✕<title>' + m.title + '</title></text>';
    }).join('');
    // Выбранный заказ не в маршрутах (0 кг, «не везём») — кольцо на его настоящем месте.
    if (focused && !ring && isFinite(focused.lat) && isFinite(focused.lon)) ring = '<circle cx="' + X(focused) + '" cy="' + Y(focused) + '" r="16" fill="none" stroke="var(--ink)" stroke-width="3" stroke-dasharray="4 3"/>';
    if (ring && focused) ring = '<g>' + ring.replace('/>', '><title>' + focused.html.replace(/<br>/g, ' · ').replace(/<\/?b>/g, '') + '</title></circle>') + '</g>';
    el.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Схема маршрутов">' + back + front + depot + crosses + ring + '</svg>';
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
  // Ждём ответа сервера не дольше 8 секунд: при плохом Wi-Fi запрос может «повиснуть», а линии идут
  // по очереди, и один повисший запрос задержал бы все остальные. Не дождались — линия остаётся пунктиром.
  function fetchRoad(path, attempt) {
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 8000);
    return fetch(ROAD_URL + path + '?overview=full&geometries=geojson', ctrl ? { signal: ctrl.signal } : {}).then(function (r) {
      clearTimeout(timer);
      if (r.status === 429 && attempt < 2) return wait(2500).then(function () { return fetchRoad(path, attempt + 1); });
      return r.json();
    }).then(function (j) {
      if (!j || !j.routes || !j.routes.length) return null;
      return { coords: j.routes[0].geometry.coordinates.map(function (c) { return [+c[0].toFixed(5), +c[1].toFixed(5)]; }),
        km: j.routes[0].distance / 1000, min: j.routes[0].duration / 60 };
    }).catch(function () { clearTimeout(timer); return null; });
  }
  function roadPath(depot, points, open) {       // open — без возвращения на завод
    return [depot].concat(points, open ? [] : [depot]).map(function (p) { return p.lon.toFixed(5) + ',' + p.lat.toFixed(5); }).join(';');
  }
  // Линии эталонного плана и «плана по списку» запрошены заранее и лежат в файле js/base-roads.js
  // (решение 12: после «Сбросить демо» карта рисует их без интернета и без демо-сервера OSRM).
  // Ключ в файле — тот же путь «завод → остановки → завод», поэтому если маршрут другой, файл просто молчит.
  // Линия записана сжато («encoded polyline»: каждое число — разница с предыдущей точкой, 5 знаков после запятой).
  function decodeLine(text) {
    var coords = [], i = 0, lat = 0, lon = 0;
    function next() {
      var v = 0, shift = 0, b;
      do { b = text.charCodeAt(i++) - 63; v |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20 && i < text.length);
      return v & 1 ? ~(v >> 1) : v >> 1;
    }
    while (i < text.length) { lat += next(); lon += next(); coords.push([lon / 1e5, lat / 1e5]); }
    return coords;
  }
  function fromFile(path) {
    var all = window.MILK_BASE_ROADS, rec = all && Object.prototype.hasOwnProperty.call(all, path) ? all[path] : null;
    if (!rec || typeof rec.line !== 'string') return null;
    try { return { coords: decodeLine(rec.line), km: rec.km, min: rec.min, fromFile: true }; } catch (e) { return null; }
  }
  // Уже известная линия (без запроса) или null: из памяти, из файла эталона, из браузера.
  function roadCached(depot, points, open) {
    var path = roadPath(depot, points, open);
    if (!roadCache[path]) roadCache[path] = fromFile(path) || readStored()[path] || null;
    return roadCache[path];
  }
  function roadRoute(depot, points, open) {
    var path = roadPath(depot, points, open), hit = roadCached(depot, points, open);
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

  window.MilkMap = { init: init, draw: draw, focus: focus, spread: spread, roadRoute: roadRoute, roadCached: roadCached, decodeLine: decodeLine, roadPath: roadPath, mode: function () { return mode; } };
})();
