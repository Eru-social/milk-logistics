// РЕШАТЕЛЬ МАРШРУТОВ. Написан с нуля под эту задачу, без сторонних библиотек.
// Ничего не знает про карту и экран: получает данные, возвращает план.
//
// Идея в четырёх шагах:
//   1. Заказы на один адрес и одно время склеиваем в одну «остановку».
//   2. Строим стартовый план: режем город на сектора и раздаём их машинам.
//   3. Улучшаем: переставляем остановки между машинами и внутри маршрута,
//      пока план становится «дешевле».
//   4. Встряхиваем: вынимаем кучку соседних остановок и вставляем заново
//      в лучшие места. Если стало лучше — оставляем.
//
// «Цена» плана — это минуты в дороге плюс штрафы за нарушения:
// перегруз, переработка водителя, опоздание, большая машина в центре.
// Штрафы большие, поэтому план сначала убирает нарушения, потом экономит километры.
(function () {
  'use strict';

  var OVERLOAD_SOFT = 10, OVERLOAD_STRICT = 60;   // штраф за каждый лишний кг: обычный и строгий
  var PENALTY_OVERLOAD = OVERLOAD_SOFT;
  var PENALTY_UNDERLOAD = 5;   // за каждый кг недогруза ниже обязательных 90%
  var PENALTY_OVERTIME = 40;   // за каждую минуту сверх смены
  var PENALTY_LATE = 40;       // за каждую минуту опоздания
  var PENALTY_CENTER = 2000;   // за каждую точку центра на большой машине
  var WAIT_WEIGHT = 0.5;       // минута простоя «стоит» полминуты езды
  // Два числа для перестроения в течение дня:
  var OVERTIME_SPREAD = 0.2;   // переработку лучше разделить между водителями, чем повесить на одного (штраф растёт как квадрат)
  var PICKUP_WAIT = 0.5;       // за каждую минуту, что груз ждёт перегрузки в сломанной машине: молочка ждать не должна

  // ---------- расстояния ----------
  function haversineKm(a, b) {
    var R = 6371, rad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  // Таблица «от каждой точки до каждой»: километры и минуты. Точка 0 — склад, дальше остановки.
  // Если есть готовая таблица по реальным дорогам (roads), берём расстояния из неё,
  // а время в пути умножаем на запас на пробки. Для адресов, которых в таблице нет,
  // считаем по прямой с поправкой — это запасной вариант.
  function roadKey(p) { return p.lat.toFixed(5) + ',' + p.lon.toFixed(5); }
  function buildMatrix(points, st, roads) {
    var n = points.length, km = [], min = [], i, j, byRoad = !!roads;
    var idx = points.map(function (p) { return roads ? roads.index[roadKey(p)] : undefined; });
    for (i = 0; i < n; i++) {
      km.push(new Float64Array(n)); min.push(new Float64Array(n));
      for (j = 0; j < n; j++) {
        if (i === j) continue;
        if (idx[i] !== undefined && idx[j] !== undefined) {
          km[i][j] = roads.km10[idx[i] * roads.n + idx[j]] / 100;
          min[i][j] = roads.min10[idx[i] * roads.n + idx[j]] / 10 * st.trafficFactor;
        } else {
          byRoad = false;
          var d = haversineKm(points[i], points[j]) * st.detour;
          km[i][j] = d; min[i][j] = d / st.speedKmh * 60;
        }
      }
    }
    return { km: km, min: min, byRoad: byRoad };
  }

  // ---------- шаг 1: заказы -> остановки ----------
  function isCenter(address, st) {
    for (var i = 0; i < st.centerStreets.length; i++) {
      if (address.toLowerCase().indexOf(st.centerStreets[i].toLowerCase()) === 0) return true;
    }
    return false;
  }

  function buildStops(orders, st) {
    var byKey = {}, stops = [];
    orders.forEach(function (o) {
      if (!(o.kg > 0)) return;
      var hasTime = o.timeExplicit || st.fillDownTimes;
      var from = hasTime ? o.from : 0;
      var key = o.address.toLowerCase() + '|' + from;
      var s = byKey[key];
      if (!s) {
        s = byKey[key] = { orders: [], kg: 0, from: from, due: st.dayEnd, important: false,
          lat: o.lat, lon: o.lon, address: o.address, center: isCenter(o.address, st) };
        stops.push(s);
      }
      s.orders.push(o); s.kg += o.kg;
      if (o.timeExplicit) { s.important = true; s.due = Math.min(s.due, o.from + st.importantWindowMin); }
    });
    // Мелкой точке хватает короткой разгрузки.
    stops.forEach(function (s) { s.service = s.kg <= st.smallStopKg ? st.smallServiceMin : st.serviceMin; });
    return stops;
  }

  // ---------- оценка одного маршрута ----------
  // seq — номера остановок по порядку. Возвращает цену и расписание.
  function simulate(P, veh, seq, depart, withStops) {
    var st = P.st, M = P.M, t = depart, prev = 0, drive = 0, km = 0, wait = 0, late = 0, delay = 0, slack = 1e9;
    var load = 0, center = 0, list = withStops ? [] : null;
    for (var i = 0; i < seq.length; i++) {
      var s = P.stops[seq[i]], node = seq[i] + 1;
      var leave = t;
      drive += M.min[prev][node]; km += M.km[prev][node];
      var arrive = t + M.min[prev][node];
      var start = Math.max(arrive, s.from);
      wait += start - arrive;
      if (s.from > 0) delay += start - s.from;        // на сколько позже указанного времени начали разгрузку
      if (start > s.due) late += start - s.due; else slack = Math.min(slack, s.due - start);
      t = start + s.service;
      load += s.kg;
      if (s.center && veh.cap > st.centerMaxCap) center++;
      if (list) list.push({ stop: seq[i], leave: leave, arrive: arrive, start: start, end: t, late: Math.max(0, start - s.due), km: km, drive: drive });
      prev = node;
    }
    drive += M.min[prev][0]; km += M.km[prev][0];
    var back = t + M.min[prev][0];
    var overtime = Math.max(0, st.loadMin + back - depart - st.shiftMin);   // загрузка на заводе входит в смену
    var overload = Math.max(0, load - veh.cap);
    var underload = Math.max(0, veh.cap * st.minLoadPct / 100 - load);
    var cost = drive + WAIT_WEIGHT * wait + st.vehicleFixedMin + st.delayWeight * delay +
      PENALTY_OVERTIME * overtime + PENALTY_LATE * late + PENALTY_OVERLOAD * overload +
      PENALTY_UNDERLOAD * underload + PENALTY_CENTER * center;
    return { cost: cost, drive: drive, km: km, wait: wait, late: late, delay: delay, slack: slack, load: load, overload: overload,
      underload: underload, overtime: overtime, center: center, depart: depart, back: back, stops: list };
  }

  function evalRoute(P, veh, seq, withStops) {
    if (P.live && seq.length) return evalLive(P, P.vehicles.indexOf(veh), seq, withStops);
    if (!seq.length) return { cost: 0, drive: 0, km: 0, wait: 0, late: 0, delay: 0, underload: 0, load: 0, overload: 0, overtime: 0, center: 0,
      depart: 0, back: 0, stops: [] };
    // Выезжаем так, чтобы приехать к первой точке к её открытию, но не раньше разрешённого.
    var first = P.stops[seq[0]];
    var d0 = Math.max(P.st.earliestDepart, first.from - P.M.min[0][seq[0] + 1]);
    var a = simulate(P, veh, seq, d0, withStops);
    // Если по дороге машина стоит и ждёт открытия, пробуем выехать позже на это время.
    if (a.wait > 0 && a.late === 0 && a.slack > 0) {
      var b = simulate(P, veh, seq, d0 + Math.min(a.wait, a.slack), withStops);
      if (b.cost < a.cost) return b;
    }
    return a;
  }

  // ---------- день уже идёт ----------
  // Когда машины уже в рейсе, план нельзя считать с нуля. К плану прикладывается «снимок дня» (live):
  //   now       — время снимка, минуты от полуночи;
  //   vehicles  — по каждой машине: t — когда началась разгрузка в уже сделанных точках,
  //               ready и pos — когда и где машина освободится, depart — когда выехала,
  //               back — когда вернулась на завод, broken — сломана и дальше не едет;
  //   from      — у каких остановок груз лежит в сломанной машине и где она стоит (перед ними нужна перегрузка);
  //   retry     — к каким остановкам вернуться не раньше указанного времени;
  //   dropped   — какие остановки сегодня не доставляем.
  // Остановки и места здесь записаны номером первого заказа остановки, 0 — завод.
  function applyLive(P, live) {
    var st = P.st, now = live.now || 0;
    function node(oid) { return oid && P.stopOf[oid] !== undefined ? P.stopOf[oid] + 1 : 0; }
    P.live = live; P.now = now;
    P.lv = P.vehicles.map(function (v) {
      var r = (live.vehicles || {})[v.id];
      // Машины, которой в снимке нет (её добавили позже), считаем резервной: она на заводе и скоро готова.
      if (!r) return { t: {}, ready: now + st.reserveReadyMin, node: 0, km: 0, drive: 0, depart: now + st.reserveReadyMin, broken: false };
      return { t: r.t || {}, ready: r.ready || 0, node: node(r.pos), km: r.km || 0, drive: r.drive || 0,
        depart: r.depart || 0, back: r.back, broken: !!r.broken };
    });
    P.src = P.stops.map(function () { return -1; });       // -1 — груз уже в своей машине
    Object.keys(live.from || {}).forEach(function (oid) {
      if (P.stopOf[oid] !== undefined) P.src[P.stopOf[oid]] = node(live.from[oid]);
    });
    P.dropped = {};
    (live.dropped || []).forEach(function (oid) { if (P.stopOf[oid] !== undefined) P.dropped[P.stopOf[oid]] = true; });
    Object.keys(live.retry || {}).forEach(function (oid) {
      var s = P.stops[P.stopOf[oid]];
      if (!s) return;
      s.from = Math.max(s.from, live.retry[oid]);
      s.due = s.important ? s.from + st.importantWindowMin : Math.max(s.due, st.dayEnd);
    });
  }

  // Сколько остановок в начале маршрута уже сделано (их время известно и не меняется).
  function cutOf(P, k, seq) {
    var t = P.lv[k].t, cut = 0;
    while (cut < seq.length && t[P.stops[seq[cut]].orders[0].id] !== undefined) cut++;
    return cut;
  }

  // ХВОСТ МАРШРУТА: то, что машине ещё предстоит, начиная с места и времени, где она освободится.
  // Если груз остановки лежит в сломанной машине, перед первой такой остановкой заезжаем
  // на перегрузку и забираем сразу всё, что этой машине оттуда везти.
  function liveTail(P, k, tail, list) {
    var st = P.st, M = P.M, lv = P.lv[k], veh = P.vehicles[k];
    var t = lv.ready, prev = lv.node, drive = 0, km = 0, wait = 0, late = 0, delay = 0, center = 0;
    var load = 0, peak = 0, hold = 0, seen = null, i, j, back;
    if (lv.broken) {                                        // сломанная машина никуда не едет
      return { cost: tail.length * 1e9, drive: 0, km: 0, wait: 0, late: 0, delay: 0, center: 0, peak: 0, overload: 0, overtime: 0, back: lv.ready };
    }
    if (!tail.length) {
      if (lv.back !== undefined) back = lv.back;            // уже вернулась
      else if (prev === 0) back = t;                        // стоит на заводе
      else { drive = M.min[prev][0]; km = M.km[prev][0]; back = t + drive; }
    } else {
      for (i = 0; i < tail.length; i++) if (P.src[tail[i]] < 0) load += P.stops[tail[i]].kg;
      peak = load;
      for (i = 0; i < tail.length; i++) {
        var s = P.stops[tail[i]], node = tail[i] + 1, p = P.src[tail[i]], pick = null, leave = t;
        if (p >= 0 && !(seen && seen[p])) {                 // перегрузка из сломанной машины
          (seen = seen || {})[p] = true;
          var take = 0, count = 0;
          for (j = i; j < tail.length; j++) if (P.src[tail[j]] === p) { take += P.stops[tail[j]].kg; count++; }
          drive += M.min[prev][p]; km += M.km[prev][p];
          var pa = t + M.min[prev][p];
          hold += pa - P.now;
          t = pa + st.transferMin; load += take; peak = Math.max(peak, load);
          pick = { node: p, arrive: pa, end: t, kg: take, count: count, load: load };
          prev = p;
        }
        drive += M.min[prev][node]; km += M.km[prev][node];
        var arrive = t + M.min[prev][node];
        var start = Math.max(arrive, s.from);
        wait += start - arrive;
        if (s.from > 0) delay += start - s.from;
        if (start > s.due) late += start - s.due;
        t = start + s.service; load -= s.kg;
        if (s.center && veh.cap > st.centerMaxCap) center++;
        if (list) list.push({ stop: tail[i], leave: leave, arrive: arrive, start: start, end: t, late: Math.max(0, start - s.due),
          km: lv.km + km, drive: lv.drive + drive, pickup: pick });
        prev = node;
      }
      drive += M.min[prev][0]; km += M.km[prev][0];
      back = t + M.min[prev][0];
    }
    var overtime = Math.max(0, st.loadMin + back - lv.depart - st.shiftMin);
    var overload = Math.max(0, peak - veh.cap);
    var cost = drive + WAIT_WEIGHT * wait + st.delayWeight * delay + PENALTY_OVERTIME * overtime + PENALTY_LATE * late +
      OVERLOAD_STRICT * overload + PENALTY_CENTER * center + OVERTIME_SPREAD * overtime * overtime + PICKUP_WAIT * hold;
    // Вариант «без переработки»: смену длиннее разрешённого считаем недопустимой.
    if (P.overtimeCap !== undefined && overtime > P.overtimeCap) cost += 1e7 * (1 + overtime - P.overtimeCap);
    return { cost: cost, drive: drive, km: km, wait: wait, late: late, delay: delay, center: center, peak: peak,
      overload: overload, overtime: overtime, back: back };
  }

  // Весь маршрут в идущем дне: сделанное берём из снимка как есть, хвост считаем заново.
  function evalLive(P, k, seq, withStops) {
    var lv = P.lv[k], cut = cutOf(P, k, seq), list = withStops ? [] : null, load = 0, i;
    for (i = 0; i < seq.length; i++) load += P.stops[seq[i]].kg;
    if (list) for (i = 0; i < cut; i++) {
      var s = P.stops[seq[i]], ts = lv.t[s.orders[0].id];
      list.push({ stop: seq[i], leave: ts, arrive: ts, start: ts, end: i === cut - 1 ? Math.max(lv.ready, ts) : ts + s.service,
        late: 0, km: lv.km, drive: lv.drive, fixed: true });
    }
    var e = liveTail(P, k, seq.slice(cut), list);
    return { cost: e.cost, drive: lv.drive + e.drive, km: lv.km + e.km, wait: e.wait, late: e.late, delay: e.delay, slack: 0,
      load: load, peak: e.peak, overload: e.overload, underload: 0, overtime: e.overtime, center: e.center,
      depart: lv.depart, back: e.back, stops: list, cut: cut, broken: lv.broken };
  }

  // ---------- шаг 2: стартовый план ----------
  function initialPlan(P) {
    var n = P.stops.length, V = P.vehicles, routes = V.map(function () { return []; });
    if (!V.length) return routes;
    var cLat = 0, cLon = 0;
    P.stops.forEach(function (s) { cLat += s.lat / n; cLon += s.lon / n; });
    var order = [];
    for (var i = 0; i < n; i++) order.push(i);
    // Обходим остановки по кругу вокруг центра города.
    order.sort(function (a, b) {
      return Math.atan2(P.stops[a].lat - cLat, P.stops[a].lon - cLon) - Math.atan2(P.stops[b].lat - cLat, P.stops[b].lon - cLon);
    });
    var totalKg = 0, totalCap = 0;
    P.stops.forEach(function (s) { totalKg += s.kg; });
    V.forEach(function (v) { totalCap += v.cap; });
    var share = Math.min(1, totalKg / totalCap);
    // Точки центра сразу отдаём малой машине.
    var small = -1;
    V.forEach(function (v, k) { if (v.cap <= P.st.centerMaxCap && small < 0) small = k; });
    var loads = V.map(function () { return 0; }), k = 0;
    order.forEach(function (idx) {
      var s = P.stops[idx];
      if (s.center && small >= 0) { routes[small].push(idx); loads[small] += s.kg; return; }
      while (k < V.length - 1 && (k === small || loads[k] + s.kg > V[k].cap * share)) k++;
      routes[k].push(idx); loads[k] += s.kg;
    });
    return routes;
  }

  // ---------- шаг 3: улучшение перестановками ----------
  // Для каждой остановки заранее находим её ближайших соседей:
  // пробовать переставлять имеет смысл только рядом, это ускоряет расчёт в десятки раз.
  function buildNeighbours(P, count) {
    var n = P.stops.length, near = [];
    for (var v = 0; v < n; v++) {
      var ids = [];
      for (var w = 0; w < n; w++) if (w !== v) ids.push(w);
      ids.sort(function (x, y) { return P.M.min[v + 1][x + 1] - P.M.min[v + 1][y + 1]; });
      near.push(ids.slice(0, count));
    }
    return near;
  }

  function LocalSearch(P, routes, near) {
    var V = P.vehicles, n = P.stops.length;
    var costs = routes.map(function (r, k) { return evalRoute(P, V[k], r).cost; });
    var routeOf = new Array(n);
    routes.forEach(function (r, k) { r.forEach(function (s) { routeOf[s] = k; }); });
    function c(k, seq) { return evalRoute(P, V[k], seq).cost; }
    function insertAt(seq, pos, stop) { var t = seq.slice(0, pos); t.push(stop); return t.concat(seq.slice(pos)); }

    // Переносим остановку v к одному из её соседей (до него или после) либо в пустую машину.
    function relocate(v) {
      var a = routeOf[v], i = routes[a].indexOf(v);
      var without = routes[a].slice(0, i).concat(routes[a].slice(i + 1));
      var costWithout = c(a, without);
      var best = -1e-6, bestB = -1, bestSeq = null, bestCost = 0;
      function tryInsert(b, pos) {
        var base = b === a ? without : routes[b];
        var trial = insertAt(base, pos, v), cc = c(b, trial);
        var delta = b === a ? cc - costs[a] : (costWithout - costs[a]) + (cc - costs[b]);
        if (delta < best) { best = delta; bestB = b; bestSeq = trial; bestCost = cc; }
      }
      near[v].forEach(function (w) {
        var b = routeOf[w], base = b === a ? without : routes[b], pos = base.indexOf(w);
        tryInsert(b, pos); tryInsert(b, pos + 1);
      });
      for (var b = 0; b < routes.length; b++) if (!routes[b].length) tryInsert(b, 0);
      if (bestB < 0) return false;
      if (bestB !== a) { routes[a] = without; costs[a] = costWithout; }
      routes[bestB] = bestSeq; costs[bestB] = bestCost; routeOf[v] = bestB;
      return true;
    }

    // Меняем местами остановку v и её соседа из другого маршрута.
    function swap(v) {
      var done = false;
      near[v].forEach(function (w) {
        var a = routeOf[v], b = routeOf[w];
        if (a === b) return;
        var ra = routes[a].slice(), rb = routes[b].slice();
        ra[ra.indexOf(v)] = w; rb[rb.indexOf(w)] = v;
        var ca = c(a, ra), cb = c(b, rb);
        if (ca + cb < costs[a] + costs[b] - 1e-6) {
          routes[a] = ra; routes[b] = rb; costs[a] = ca; costs[b] = cb; routeOf[v] = b; routeOf[w] = a; done = true;
        }
      });
      return done;
    }

    // Разворачиваем кусок маршрута задом наперёд (убирает «петли»).
    function reverse(a) {
      var improved = false, r = routes[a];
      for (var i = 0; i < r.length - 1; i++) for (var j = i + 1; j < r.length; j++) {
        var t = r.slice(0, i).concat(r.slice(i, j + 1).reverse(), r.slice(j + 1));
        var ct = c(a, t);
        if (ct < costs[a] - 1e-6) { routes[a] = r = t; costs[a] = ct; improved = true; }
      }
      return improved;
    }

    // Пересаживаем два маршрута на машины друг друга: вдруг этому грузу больше подходит другая машина.
    function swapVehicles() {
      var improved = false;
      for (var a = 0; a < routes.length; a++) for (var b = a + 1; b < routes.length; b++) {
        if (V[a].cap === V[b].cap || (!routes[a].length && !routes[b].length)) continue;
        var ca = c(a, routes[b]), cb = c(b, routes[a]);
        if (ca + cb < costs[a] + costs[b] - 1e-6) {
          var t = routes[a]; routes[a] = routes[b]; routes[b] = t; costs[a] = ca; costs[b] = cb;
          routes[a].forEach(function (s) { routeOf[s] = a; }); routes[b].forEach(function (s) { routeOf[s] = b; });
          improved = true;
        }
      }
      return improved;
    }

    this.run = function (deadline) {
      var guard = 0, improved = true;
      while (improved && guard++ < 100 && Date.now() < deadline) {
        improved = false;
        for (var v = 0; v < n; v++) { if (relocate(v)) improved = true; if (swap(v)) improved = true; }
        for (var a = 0; a < routes.length; a++) if (reverse(a)) improved = true;
        if (swapVehicles()) improved = true;
      }
      var total = 0; costs.forEach(function (x) { total += x; });
      return total;
    };
  }

  // ---------- шаг 4: «встряхивание» ----------
  function makeRandom(seed) {       // свой генератор случайных чисел: одинаковые данные -> одинаковый план
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function shake(P, routes, rnd, round) {
    var copy = routes.map(function (r) { return r.slice(); }), removed = [], n = P.stops.length;
    if (round % 4 === 3) {
      // Иногда пробуем целиком разобрать самый лёгкий маршрут: вдруг машина не нужна.
      var lightest = -1, lightKg = 1e18;
      copy.forEach(function (r, k) {
        if (!r.length) return;
        var kg = 0; r.forEach(function (i) { kg += P.stops[i].kg; });
        if (kg < lightKg) { lightKg = kg; lightest = k; }
      });
      if (lightest >= 0) { removed = copy[lightest]; copy[lightest] = []; }
    } else {
      // Обычно вынимаем случайную остановку и её ближайших соседей.
      var seedStop = Math.floor(rnd() * n), count = 8 + Math.floor(rnd() * 14);
      var near = [];
      for (var i = 0; i < n; i++) near.push(i);
      near.sort(function (a, b) { return P.M.min[seedStop + 1][a + 1] - P.M.min[seedStop + 1][b + 1]; });
      var take = {}; near.slice(0, count).forEach(function (i) { take[i] = true; removed.push(i); });
      copy = copy.map(function (r) { return r.filter(function (i) { return !take[i]; }); });
    }
    // Вставляем обратно: сначала тяжёлые, каждую — в самое дешёвое место.
    removed.sort(function (a, b) { return P.stops[b].kg - P.stops[a].kg; });
    removed.forEach(function (stop) { insertCheapest(P, copy, stop); });
    return copy;
  }

  // Вставляет остановку туда, где она меньше всего ухудшает план.
  // onlyK — если задан, вставляем только в эту машину.
  function insertCheapest(P, routes, stop, onlyK) {
    var best = 1e18, bestK = -1, bestJ = 0;
    routes.forEach(function (r, k) {
      if (onlyK !== undefined && k !== onlyK) return;
      if (P.live && P.lv[k].broken) return;
      var base = evalRoute(P, P.vehicles[k], r).cost;
      for (var j = P.live ? cutOf(P, k, r) : 0; j <= r.length; j++) {
        var t = r.slice(0, j); t.push(stop); t = t.concat(r.slice(j));
        var d = evalRoute(P, P.vehicles[k], t).cost - base;
        if (d < best) { best = d; bestK = k; bestJ = j; }
      }
    });
    if (bestK >= 0) routes[bestK].splice(bestJ, 0, stop);
  }

  // ---------- сборка ответа ----------
  function describe(P, routes) {
    var out = { routes: [], km: 0, driveMin: 0, used: 0, overtimeMin: 0, lateStops: 0, overloadKg: 0,
      centerViolations: 0, underloaded: 0, lastBack: 0, workMin: 0, delayMin: 0, firstDepart: 1e9, problems: [] };
    routes.forEach(function (seq, k) {
      var v = P.vehicles[k], e = evalRoute(P, v, seq, true);
      var r = { vehicle: v, seq: seq, km: e.km, driveMin: e.drive, depart: e.depart, back: e.back, load: e.load,
        loadPct: v.cap ? e.load / v.cap * 100 : 0, overtime: e.overtime, overload: e.overload, late: e.late,
        center: e.center, wait: e.wait, stops: e.stops };
      if (P.live) {
        r.live = true; r.cut = e.cut || 0; r.broken = P.lv[k].broken; r.returned = P.lv[k].back !== undefined && r.cut === seq.length;
        // В идущем дне полоска загрузки показывает, сколько груза в кузове впереди (с учётом перегрузки).
        if (r.cut < seq.length && v.cap) r.loadPct = e.peak / v.cap * 100;
      }
      out.routes.push(r);
      if (!seq.length) return;
      out.used++; out.km += e.km; out.driveMin += e.drive; out.overtimeMin += e.overtime;
      out.overloadKg += e.overload; out.centerViolations += e.center;
      out.delayMin += e.delay; out.firstDepart = Math.min(out.firstDepart, e.depart);
      out.workMin += P.st.loadMin + e.back - e.depart; out.lastBack = Math.max(out.lastBack, e.back);
      e.stops.forEach(function (s) { if (s.late > 0.5) out.lateStops++; });
      // Мелкие отклонения в пределах допуска показываем, но нарушением не считаем.
      r.overloadBad = e.overload > Math.max(0.5, v.cap * (P.st.overloadTolerancePct || 0) / 100);
      r.overtimeBad = e.overtime > Math.max(0.5, P.st.overtimeToleranceMin || 0);
      if (r.overloadBad) out.problems.push(v.name + ': перегруз ' + Math.round(e.overload) + ' кг');
      if (r.overtimeBad) out.problems.push(v.name + ': переработка ' + Math.round(e.overtime) + ' мин');
      if (e.center > 0) out.problems.push(v.name + ': большая машина в центре (' + e.center + ' точ.)');
      if (e.underload > 0) { out.underloaded++; out.problems.push(v.name + ': загрузка ' + Math.round(r.loadPct) + '% (ниже ' + P.st.minLoadPct + '%)'); }
    });
    if (out.lateStops) out.problems.push('Опоздания: ' + out.lateStops + ' точ.');
    out.stopsTotal = P.stops.length;
    return out;
  }

  function hasViolations(out) {
    return out.overtimeMin > 0.5 || out.lateStops > 0 || out.overloadKg > 0.5 || out.underloaded > 0 || out.centerViolations > 0;
  }

  function prepare(input, live) {
    var st = input.settings;
    var stops = buildStops(input.orders, st);
    var vehicles = input.vehicles.filter(function (v) { return v.active !== false && v.cap > 0; });
    var points = [input.depot].concat(stops);
    var P = { st: st, stops: stops, vehicles: vehicles, M: buildMatrix(points, st, input.roads), stopOf: {} };
    stops.forEach(function (s, i) { s.orders.forEach(function (o) { P.stopOf[o.id] = i; }); });
    if (live) applyLive(P, live);
    return P;
  }

  // ГЛАВНАЯ ФУНКЦИЯ: строит оптимизированный план.
  function solve(input) {
    var started = Date.now(), P = prepare(input);
    PENALTY_OVERLOAD = OVERLOAD_SOFT;
    var routes = initialPlan(P);
    var hardStop = started + 2500;                       // страховка: дольше 2,5 секунды не считаем
    var near = buildNeighbours(P, 14);
    var best = routes, bestCost = P.vehicles.length ? new LocalSearch(P, best, near).run(hardStop) : 0;
    var rnd = makeRandom(12345);
    var round;
    for (round = 0; round < P.st.improveRounds && Date.now() < hardStop && P.vehicles.length; round++) {
      var trial = shake(P, best, rnd, round);
      var cost = new LocalSearch(P, trial, near).run(hardStop);
      if (cost < bestCost - 1e-6) { best = trial; bestCost = cost; }
    }
    var out = describe(P, best);
    // Если в плане остался перегруз, включаем строгий штраф и чиним: машину перегружать нельзя.
    if (out.overloadKg > 0.5 && P.vehicles.length) {
      PENALTY_OVERLOAD = OVERLOAD_STRICT;
      bestCost = new LocalSearch(P, best, near).run(hardStop);
      out = describe(P, best);
    }
    // Если остались нарушения правил, даём плану ещё попытки (пока не кончится запас времени).
    for (; hasViolations(out) && Date.now() < hardStop && P.vehicles.length; round++) {
      var again = shake(P, best, rnd, round);
      var againCost = new LocalSearch(P, again, near).run(hardStop);
      if (againCost < bestCost - 1e-6) { best = again; bestCost = againCost; out = describe(P, best); }
    }
    PENALTY_OVERLOAD = OVERLOAD_SOFT;
    finish(P, out);
    out.ms = Date.now() - started;
    return out;
  }

  // Общие итоги плана: остановки, общий вес и вместимость, предупреждение о нехватке машин.
  function finish(P, out) {
    var totalKg = 0, totalCap = 0;
    P.stops.forEach(function (s) { totalKg += s.kg; });
    P.vehicles.forEach(function (v) { totalCap += v.cap; });
    out.stops = P.stops; out.totalKg = totalKg; out.totalCap = totalCap; out.byRoad = P.M.byRoad;
    out.live = P.live || null; out.dropped = [];
    if (P.live) {
      var droppedKg = 0;
      P.stops.forEach(function (s, i) { if (P.dropped[i]) { out.dropped.push(i); droppedKg += s.kg; } });
      if (out.dropped.length) out.problems.unshift('Сегодня не доставим: ' + out.dropped.length + ' точ., ' + Math.round(droppedKg) + ' кг');
      return out;                                           // вместимость «на весь день» в идущем дне уже не важна
    }
    if (totalKg > totalCap) out.problems.unshift('Груз не помещается в машины: лишних ' + Math.round(totalKg - totalCap) + ' кг');
    return out;
  }

  // ПЛАН → КОРОТКАЯ ЗАПИСЬ для базы: для каждой машины — номера первых заказов её остановок по порядку.
  function toAssignment(plan) {
    return plan.routes.map(function (r) {
      return { v: r.vehicle.id, s: r.seq.map(function (i) { return plan.stops[i].orders[0].id; }) };
    });
  }

  // КОРОТКАЯ ЗАПИСЬ → ПЛАН. Считает время и нарушения для готового распределения, ничего не переставляя.
  // Если данные успели измениться (новая точка, машину сняли), лишние точки вставляются в самое дешёвое место.
  // move = { orderId, vehicleId } — логист вручную переносит остановку в другую машину.
  // live — снимок дня, если машины уже в рейсе (см. «день уже идёт»).
  function fromAssignment(input, assignment, move, live) {
    var P = prepare(input, live), stopOf = P.stopOf, vIndex = {}, used = {};
    P.vehicles.forEach(function (v, k) { vIndex[v.id] = k; });
    if (P.live) Object.keys(P.dropped).forEach(function (i) { used[i] = true; });
    var routes = P.vehicles.map(function () { return []; });
    var moved = move && stopOf[move.orderId] !== undefined ? stopOf[move.orderId] : -1;
    (assignment || []).forEach(function (a) {
      var k = vIndex[a.v];
      if (k === undefined) return;
      a.s.forEach(function (oid) {
        var i = stopOf[oid];
        if (i === undefined || used[i] || i === moved) return;
        used[i] = true; routes[k].push(i);
      });
    });
    // В идущем дне сделанные остановки всегда стоят в начале маршрута, в том порядке, как их проехали.
    if (P.live) routes = routes.map(function (r, k) {
      var t = P.lv[k].t, done = [], rest = [];
      r.forEach(function (i) { (t[P.stops[i].orders[0].id] !== undefined ? done : rest).push(i); });
      done.sort(function (a, b) { return t[P.stops[a].orders[0].id] - t[P.stops[b].orders[0].id]; });
      return done.concat(rest);
    });
    if (moved >= 0 && vIndex[move.vehicleId] !== undefined) { used[moved] = true; insertCheapest(P, routes, moved, vIndex[move.vehicleId]); }
    var leftover = 0;
    P.stops.forEach(function (s, i) { if (!used[i] && P.vehicles.length) { insertCheapest(P, routes, i); leftover++; } });
    var out = finish(P, describe(P, routes));
    out.ms = 0; out.leftover = leftover;
    return out;
  }

  // ПЛАН ДЛЯ СРАВНЕНИЯ: точки берутся в порядке списка и режутся по вместимости машин,
  // внутри машины водитель едет каждый раз к ближайшей точке. Так поступил бы человек без расчёта.
  function naive(input) {
    var P = prepare(input), V = P.vehicles, routes = V.map(function () { return []; });
    var loads = V.map(function () { return 0; }), k = 0, left = [];
    P.stops.forEach(function (s, i) {
      while (k < V.length && loads[k] + s.kg > V[k].cap) k++;
      if (k < V.length) { routes[k].push(i); loads[k] += s.kg; } else left.push(i);
    });
    left.forEach(function (i) {               // что не влезло подряд — в машину с самым большим остатком места
      var bestK = 0, room = -1e18;
      V.forEach(function (v, q) { if (v.cap - loads[q] > room) { room = v.cap - loads[q]; bestK = q; } });
      if (V.length) { routes[bestK].push(i); loads[bestK] += P.stops[i].kg; }
    });
    routes = routes.map(function (r) {         // порядок объезда: «к ближайшей»
      var rest = r.slice(), seq = [], cur = 0;
      while (rest.length) {
        var bi = 0;
        for (var j = 1; j < rest.length; j++) if (P.M.min[cur][rest[j] + 1] < P.M.min[cur][rest[bi] + 1]) bi = j;
        cur = rest[bi] + 1; seq.push(rest[bi]); rest.splice(bi, 1);
      }
      return seq;
    });
    return finish(P, describe(P, routes));
  }

  var api = { solve: solve, naive: naive, fromAssignment: fromAssignment, toAssignment: toAssignment, haversineKm: haversineKm,
    // Внутренние части для перестроения в течение дня (js/replan.js).
    core: { prepare: prepare, liveTail: liveTail, cutOf: cutOf, describe: describe, finish: finish } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.MilkSolver = api;
})();
