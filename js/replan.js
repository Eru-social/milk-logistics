// ПЕРЕСТРОЕНИЕ В ТЕЧЕНИЕ ДНЯ. Что делать, если что-то пошло не так:
// машина сломалась, застряла в пробке или точка не принимает товар.
// Ничего не знает про экран: получает утверждённый план и происшествие, возвращает предложение.
//
// Идея в четырёх шагах:
//   1. Делаем «снимок дня» на момент происшествия: что каждая машина уже сделала и где она сейчас.
//      Сделанное замораживается. Машина, которая едет к точке или разгружается, сначала заканчивает эту точку.
//   2. Вносим происшествие: сломанная машина дальше не едет, её оставшиеся точки становятся «бесхозными»;
//      у задержанной сдвигается время; закрытую точку откладываем или снимаем.
//   3. Раздаём бесхозные точки другим машинам: каждую туда, где она добавит меньше всего езды, опозданий
//      и переработки. Груз лежит в сломанной машине, поэтому помощник сначала заезжает к ней на перегрузку.
//      Груз, который едет в исправной машине, между машинами не перекладываем: на дороге это невозможно.
//   4. Сравниваем план «до» и «после» и объясняем словами: кто что забирает и чего это стоит.
//
// Это только предложение. Если без переработки не обойтись, предложений два: «довезти всё»
// и «без переработки» (часть точек сегодня не доставляем). Выбирает и утверждает логист.
(function () {
  'use strict';
  var S = (typeof module !== 'undefined' && module.exports) ? require('./solver.js') : window.MilkSolver;
  var core = S.core;

  // ---------- мелочи ----------
  function clock(min) { min = Math.round(min); var h = Math.floor(min / 60) % 24, m = min % 60; return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m; }
  function hours(min) { min = Math.round(min); return min < 60 ? min + ' мин' : Math.floor(min / 60) + ' ч ' + (min % 60 < 10 ? '0' : '') + (min % 60) + ' мин'; }
  function num(x) { return Math.round(x).toLocaleString('ru-RU'); }
  function plural(n, one, few, many) {
    var a = n % 10, b = n % 100;
    return n + ' ' + (a === 1 && b !== 11 ? one : (a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many));
  }
  function points(n) { return plural(n, 'точка', 'точки', 'точек'); }
  function pointsToTake(n) { return plural(n, 'точку', 'точки', 'точек'); }
  function r1(x) { return Math.round(x * 10) / 10; }
  function copy(x) { return JSON.parse(JSON.stringify(x || {})); }
  function shortName(v) { return v.name.split(' · ')[0]; }
  function oidOf(plan, stop) { return plan.stops[stop].orders[0].id; }
  function stopName(s) { return '«' + s.orders[0].name + '»' + (s.orders.length > 1 ? ' и ещё ' + (s.orders.length - 1) : ''); }
  function routeOf(plan, vehicleId) {
    for (var i = 0; i < plan.routes.length; i++) if (plan.routes[i].vehicle.id === vehicleId) return plan.routes[i];
    return null;
  }
  function fail(message) { return { ok: false, message: message, variants: [] }; }

  // ---------- шаг 1: снимок дня ----------
  // Сколько остановок с начала маршрута машина уже не бросит к моменту T: сделанные, текущая и та, к которой она едет.
  // strict — для сломанной машины: считаем только точки, до которых она доехала.
  // marks — отметки водителей («машина:заказ» → этап): отмеченная точка считается начатой, даже если по плану ещё рано.
  function committed(plan, r, T, marks, strict) {
    var c = 0;
    for (var i = 0; i < r.stops.length; i++) {
      var x = r.stops[i], mark = marks && marks[r.vehicle.id + ':' + oidOf(plan, x.stop)];
      if (x.fixed || mark || (strict ? x.arrive <= T : x.leave <= T)) c = i + 1; else break;
    }
    return c;
  }

  // Запись об одной машине: время в сделанных точках, где и когда она освободится.
  function record(plan, r, c, T, st) {
    var rec = { t: {}, depart: r1(r.depart), ready: r1(r.depart), pos: 0, km: 0, drive: 0 };
    if (!r.seq.length) { rec.depart = rec.ready = T + st.reserveReadyMin; return rec; }       // стояла в гараже
    for (var i = 0; i < c; i++) rec.t[oidOf(plan, r.stops[i].stop)] = r1(r.stops[i].start);
    if (c) {
      var last = r.stops[c - 1];
      rec.pos = oidOf(plan, last.stop); rec.ready = r1(last.end); rec.km = r1(last.km); rec.drive = r1(last.drive);
    } else rec.ready = r1(r.stops[0].leave);
    if (c === r.stops.length && r.back <= T) {                                                // уже вернулась на завод
      rec.back = r1(r.back); rec.pos = 0; rec.km = r1(r.km); rec.drive = r1(r.driveMin); rec.ready = T + st.reserveReadyMin;
    }
    return rec;
  }

  // cuts — сколько остановок считать сделанными у машин, с которыми случилось происшествие (у остальных считаем сами).
  function snapshot(plan, T, marks, st, cuts) {
    var old = plan.live || {};
    var live = { id: Math.round(T) + '-' + Date.now().toString(36), now: T, vehicles: {}, from: copy(old.from), retry: copy(old.retry),
      dropped: (old.dropped || []).slice(), moved: copy(old.moved), log: (old.log || []).slice(-4) };
    plan.routes.forEach(function (r) {
      var id = r.vehicle.id;
      if (r.broken) { live.vehicles[id] = copy(old.vehicles[id]); cuts[id] = r.seq.length; return; }
      if (cuts[id] === undefined) cuts[id] = committed(plan, r, T, marks, false);
      live.vehicles[id] = record(plan, r, cuts[id], T, st);
      // Перегрузка, на которую машина уже поехала, считается сделанной: этот груз теперь её собственный.
      var got = {}, i, f;
      for (i = 0; i < cuts[id]; i++) { f = live.from[oidOf(plan, r.seq[i])]; if (f !== undefined) got[f] = true; }
      r.seq.forEach(function (stop) {
        var oid = oidOf(plan, stop);
        if (live.from[oid] !== undefined && got[live.from[oid]]) delete live.from[oid];
      });
    });
    return live;
  }

  // ---------- шаг 3: раздаём бесхозные точки ----------
  // tails — что каждой машине осталось проехать; pool — точки, которые можно отдать любой машине;
  // touch — машины, у которых можно менять порядок оставшихся точек; allowDrop — можно ли не доставить точку.
  function distribute(P, orig, pool, touch, allowDrop, deadline) {
    var tails = orig.map(function (t) { return t.slice(); }), dropped = [], inPool = {};
    pool.forEach(function (stop) { inPool[stop] = true; });
    function cost(k, t) { return core.liveTail(P, k, t).cost; }
    var costs = tails.map(function (t, k) { return cost(k, t); });
    // Не доставить точку — крайняя мера: «дороже» любой езды, а важную и тяжёлую бросаем в последнюю очередь.
    function dropCost(stop) { var s = P.stops[stop]; return 1e6 + (s.important ? 5e5 : 0) + s.kg * 100; }
    function holds(k) { return tails[k].some(function (stop) { return inPool[stop]; }); }

    function put(stop) {                       // ставим точку в лучшее место; возвращает, во что это обошлось
      var best = Infinity, bestK = -1, bestPos = 0, bestCost = 0;
      tails.forEach(function (t, k) {
        if (P.lv[k].broken) return;
        for (var pos = 0; pos <= t.length; pos++) {
          var trial = t.slice(0, pos); trial.push(stop); trial = trial.concat(t.slice(pos));
          var c = cost(k, trial);
          if (c - costs[k] < best) { best = c - costs[k]; bestK = k; bestPos = pos; bestCost = c; }
        }
      });
      if (bestK < 0 || (allowDrop && dropCost(stop) < best)) { dropped.push(stop); return dropCost(stop); }
      tails[bestK].splice(bestPos, 0, stop); costs[bestK] = bestCost;
      return best;
    }
    function take(stop) {                      // вынимаем точку; возвращает, сколько она «стоила» на своём месте
      var d = dropped.indexOf(stop);
      if (d >= 0) { dropped.splice(d, 1); return dropCost(stop); }
      for (var k = 0; k < tails.length; k++) {
        var i = tails[k].indexOf(stop);
        if (i < 0) continue;
        var before = costs[k];
        tails[k].splice(i, 1); costs[k] = cost(k, tails[k]);
        return before - costs[k];
      }
      return 0;
    }
    function reorder(k) {                      // пробуем переставить точки внутри одной машины
      var t = tails[k], better = false, i, j, trial, c;
      for (i = 0; i < t.length; i++) for (j = 0; j < t.length; j++) {
        if (i === j) continue;
        trial = t.slice(); trial.splice(j, 0, trial.splice(i, 1)[0]);
        c = cost(k, trial);
        if (c < costs[k] - 0.5) { tails[k] = t = trial; costs[k] = c; better = true; }
      }
      for (i = 0; i < t.length - 1; i++) for (j = i + 1; j < t.length; j++) {
        trial = t.slice(0, i).concat(t.slice(i, j + 1).reverse(), t.slice(j + 1));
        c = cost(k, trial);
        if (c < costs[k] - 0.5) { tails[k] = t = trial; costs[k] = c; better = true; }
      }
      return better;
    }

    // Сначала важные точки, потом тяжёлые: им труднее найти место.
    pool.slice().sort(function (a, b) {
      return (P.stops[b].important ? 1 : 0) - (P.stops[a].important ? 1 : 0) || P.stops[b].kg - P.stops[a].kg;
    }).forEach(put);
    var improved = true, guard = 0;
    while (improved && guard++ < 30 && Date.now() < deadline) {
      improved = false;
      pool.forEach(function (stop) { var was = take(stop), now = put(stop); if (now < was - 0.01) improved = true; });
      tails.forEach(function (t, k) { if ((touch[k] || holds(k)) && reorder(k)) improved = true; });
    }
    // Машины, которым ничего не досталось, едут как ехали.
    tails.forEach(function (t, k) { if (!touch[k] && !holds(k)) tails[k] = orig[k].slice(); });
    return { tails: tails, dropped: dropped };
  }

  // ---------- шаг 4: объяснение словами ----------
  function summarize(base, plan) {
    var s = { km: plan.km - base.km, lastBack: plan.lastBack, lastBackWas: base.lastBack, overtime: 0, overtimeWas: 0, overtimeVehicles: 0,
      overtimeMax: 0, late: [], dropped: plan.dropped.length, droppedKg: 0 };
    var lateWas = {};
    base.routes.forEach(function (r) {
      if (r.overtimeBad) s.overtimeWas += r.overtime;
      r.stops.forEach(function (x) { lateWas[x.stop] = x.late; });
    });
    plan.routes.forEach(function (r) {
      if (r.overtimeBad) { s.overtime += r.overtime; s.overtimeVehicles++; s.overtimeMax = Math.max(s.overtimeMax, r.overtime); }
      // Опоздания считаем только новые: те, что появились или выросли из-за происшествия.
      r.stops.forEach(function (x) { if (!x.fixed && x.late > 0.5 && x.late > (lateWas[x.stop] || 0) + 1) s.late.push({ stop: x.stop, min: x.late }); });
    });
    plan.dropped.forEach(function (stop) { s.droppedKg += plan.stops[stop].kg; });
    return s;
  }
  function priceLines(plan, s) {
    var lines = [], text = 'Чего это стоит: пробег за день ' + (Math.abs(s.km) < 0.5 ? 'не меняется' : (s.km > 0 ? '+' : '−') + num(Math.abs(s.km)) + ' км') +
      ', последняя машина вернётся в ' + clock(s.lastBack);
    if (Math.abs(s.lastBack - s.lastBackWas) >= 1) text += ' (было ' + clock(s.lastBackWas) + ')';
    text += s.overtime > 0.5 ? '. Переработка: ' + plural(s.overtimeVehicles, 'водитель', 'водителя', 'водителей') + ', всего ' + hours(s.overtime) +
      (s.overtimeWas > 0.5 ? (Math.abs(s.overtime - s.overtimeWas) < 1 ? ' (как и было)' : ' (было ' + hours(s.overtimeWas) + ')') : '') + '.' : '. Переработки нет.';
    lines.push(text);
    if (s.late.length) {
      lines.push('Опоздают ' + points(s.late.length) + ': ' + s.late.slice(0, 3).map(function (l) {
        return stopName(plan.stops[l.stop]) + ' на ' + hours(l.min);
      }).join(', ') + (s.late.length > 3 ? ' и другие' : '') + '.');
    }
    return lines;
  }
  function backText(r, was) {
    var text = 'На завод вернётся в ' + clock(r.back);
    if (was && was.seq.length && Math.abs(was.back - r.back) >= 1) text += ' вместо ' + clock(was.back);
    if (r.overtimeBad) text += ', переработка ' + hours(r.overtime);
    return text + '.';
  }

  function explainBreakdown(P, base, plan, info, pool) {
    var v = P.vehicles[info.k], inPool = {}, lines = [], helpers = [], others = 0;
    pool.forEach(function (stop) { inPool[stop] = true; });
    lines.push('Машина стоит ' + (info.place >= 0 ? 'у точки ' + stopName(plan.stops[info.place]) + ' (' + plan.stops[info.place].address + ')' : 'на заводе') +
      '. В ней осталось ' + points(pool.length) + ', ' + num(info.kg) + ' кг.');
    // Кто из исправных машин ближе к месту поломки: это пойдёт в объяснение.
    var placeNode = info.place + 1, order = [];
    P.vehicles.forEach(function (x, k) { if (!P.lv[k].broken) order.push(k); });
    order.sort(function (a, b) { return P.M.min[P.lv[a].node][placeNode] - P.M.min[P.lv[b].node][placeNode]; });
    plan.routes.forEach(function (r, k) {
      var mine = r.seq.filter(function (stop) { return inPool[stop]; });
      if (!mine.length) { if (r.seq.length > r.cut && !r.broken) others++; return; }
      var kg = 0, pick = null;
      mine.forEach(function (stop) { kg += plan.stops[stop].kg; });
      r.stops.forEach(function (x) { if (!pick && x.pickup && inPool[x.stop]) pick = x.pickup; });
      helpers.push({ r: r, k: k, n: mine.length, kg: kg, pick: pick });
    });
    helpers.sort(function (a, b) { return (a.pick ? a.pick.arrive : 0) - (b.pick ? b.pick.arrive : 0); });
    if (helpers.length) lines.push('Точки отданы тем машинам, которым это добавляет меньше всего езды, опозданий и переработки. ' +
      'Груз лежит в сломанной машине, поэтому сначала перегрузка (' + P.st.transferMin + ' мин).');
    helpers.forEach(function (h) {
      var lv = P.lv[h.k], was = base.routes[h.k], rank = order.indexOf(h.k), min = Math.round(P.M.min[lv.node][placeNode]), why;
      if (!was.seq.length) why = 'резервная, стояла в гараже';
      else if (lv.back !== undefined) why = 'уже вернулась на завод и свободна';
      else if (h.pick && h.pick.arrive - lv.ready > min + 30) why = 'сначала развезёт часть своих точек, потом заедет за грузом';
      else why = (rank === 0 ? 'ближе всех к месту поломки' : (rank <= 2 ? 'одна из ближайших к месту поломки' : 'до места поломки')) +
        ' — ' + min + ' мин езды, освобождается в ' + clock(lv.ready);
      var text = shortName(h.r.vehicle) + ' забирает ' + pointsToTake(h.n) + ' (' + num(h.kg) + ' кг): ' + why + '.';
      if (h.pick) text += ' Перегрузка в ' + clock(h.pick.arrive) + ', после неё в кузове ' + num(h.pick.load) + ' из ' + num(h.r.vehicle.cap) + ' кг.';
      lines.push(text + ' ' + backText(h.r, was));
    });
    if (others) lines.push((helpers.length ? 'Остальные ' : '') + plural(others, 'машина едет', 'машины едут', 'машин едут') + ' по прежним маршрутам.');
    if (plan.dropped.length) {
      var names = [], kg = 0;
      plan.dropped.forEach(function (stop) { if (inPool[stop]) { names.push(stopName(plan.stops[stop])); kg += plan.stops[stop].kg; } });
      if (names.length) lines.push('Сегодня не доставим ' + pointsToTake(names.length) + ' (' + num(kg) + ' кг): ' + names.slice(0, 4).join(', ') +
        (names.length > 4 ? ' и другие' : '') + '. Груз остаётся в сломанной машине.');
    }
    return { title: shortName(v) + ' сломалась в ' + clock(info.at), lines: lines };
  }

  function explainDelay(P, base, plan, info, tailWas) {
    var r = plan.routes[info.k], tail = r.seq.slice(r.cut), lines = [];
    if (!tail.length) lines.push('Все точки уже начаты, сдвигается только возвращение на завод.');
    else if (tail.join() === tailWas.join()) lines.push('Порядок оставшихся точек прежний (' + points(tail.length) + '), сдвигается только время.');
    else lines.push('Порядок оставшихся точек изменён, чтобы меньше опоздать: следующей теперь ' + stopName(plan.stops[tail[0]]) + '.');
    lines.push(backText(r, base.routes[info.k]));
    return { title: shortName(P.vehicles[info.k]) + ' задерживается на ' + hours(info.delay) + ' (с ' + clock(info.at) + ')', lines: lines };
  }

  function explainStop(P, base, plan, info) {
    var r = plan.routes[info.k], s = plan.stops[info.stop], name = shortName(P.vehicles[info.k]), lines = [];
    if (info.action === 'drop') lines.push('Сегодня точку не доставляем: ' + num(s.kg) + ' кг вернутся на завод в машине ' + P.vehicles[info.k].id + '.');
    else r.stops.forEach(function (x, i) {
      if (x.stop === info.stop) lines.push(name + ' вернётся к точке не раньше ' + clock(info.retryAt) + ': теперь она ' + (i - r.cut + 1) + '-я из ' +
        (r.seq.length - r.cut) + ' оставшихся, разгрузка около ' + clock(x.start) + '.');
    });
    lines.push(backText(r, base.routes[info.k]));
    return { title: stopName(s) + (info.later ? ' просит привезти не раньше ' + clock(info.retryAt) : ' не принимает товар') + ' (' + clock(info.at) + ')', lines: lines };
  }

  // ---------- ГЛАВНАЯ ФУНКЦИЯ ----------
  // input — те же данные, что у решателя; base — утверждённый план, как его вернул решатель;
  // incident = { type: 'breakdown' | 'delay' | 'stop' | 'later', vehicleId, at, delayMin, orderId, action: 'retry' | 'drop', retryAt };
  // 'later' (этап 1Б) — магазин просит привезти в другое время: то же «вернуться к точке позже», что у 'stop',
  // только время (retryAt, минуты от полуночи) задаёт логист, а не настройка «Вернуться через».
  // marks — отметки водителей. Возвращает { ok, message, variants: [{ key, name, plan, assignment, live, title, lines, stats }] }.
  function propose(input, base, incident, marks) {
    var st = input.settings, id = incident.vehicleId, r = routeOf(base, id);
    var T = Math.max(incident.at || 0, base.live ? base.live.now : 0);
    if (!r) return fail('Этой машины нет на линии.');
    if (r.broken) return fail('Эта машина уже снята с маршрута.');
    if (!r.seq.length) return fail('У этой машины сегодня нет маршрута.');
    var k = base.routes.indexOf(r), cuts = {}, pool = [], touch = {}, info = { type: incident.type, vehicleId: id, k: k, at: T }, live, rec, c;

    if (incident.type === 'breakdown') {
      c = committed(base, r, T, marks, true);
      if (c === r.stops.length) return fail('К этому времени машина уже развезла все свои точки: перестраивать нечего.');
      // Где стоит машина: если проехала больше половины пути к следующей точке — рядом с ней, иначе рядом с предыдущей.
      var next = r.stops[c];
      info.place = T >= (next.leave + next.arrive) / 2 ? next.stop : (c ? r.stops[c - 1].stop : -1);
      cuts[id] = c;
      live = snapshot(base, T, marks, st, cuts);
      rec = live.vehicles[id];
      rec.broken = true; rec.ready = T; rec.pos = info.place >= 0 ? oidOf(base, info.place) : 0; delete rec.back;
      info.kg = 0;
      r.seq.slice(c).forEach(function (stop) {
        var oid = oidOf(base, stop);
        if (live.from[oid] === undefined) live.from[oid] = rec.pos;
        live.moved[oid] = id; pool.push(stop); info.kg += base.stops[stop].kg;
      });
    } else if (incident.type === 'delay') {
      info.delay = Math.max(1, Math.round(incident.delayMin || 0));
      live = snapshot(base, T, marks, st, cuts);
      rec = live.vehicles[id]; c = cuts[id];
      if (rec.back !== undefined) return fail('Эта машина уже вернулась на завод.');
      // Если машина ещё едет к точке, она приедет позже; если уже стоит на точке — позже с неё уедет.
      if (c && r.stops[c - 1].arrive > T && !r.stops[c - 1].fixed) rec.t[oidOf(base, r.stops[c - 1].stop)] = r1(r.stops[c - 1].start + info.delay);
      rec.ready = r1(Math.max(rec.ready, T) + info.delay);
      touch[k] = true;
    } else if (incident.type === 'stop' || incident.type === 'later') {
      var stop = -1, j;
      base.stops.forEach(function (s, i) { s.orders.forEach(function (o) { if (o.id === incident.orderId) stop = i; }); });
      j = r.seq.indexOf(stop);
      if (j < 0) return fail('Этой точки нет в маршруте машины.');
      c = committed(base, r, T, marks, false);
      if (r.stops[j].fixed || j < c - 1 || (marks && marks[id + ':' + oidOf(base, stop)] === 'done')) return fail('Эта точка уже пройдена.');
      cuts[id] = Math.min(c, j);
      live = snapshot(base, T, marks, st, cuts);
      rec = live.vehicles[id];
      var oid = oidOf(base, stop), at = T;
      if (j === c - 1) {                       // машина как раз у этой точки (или подъезжает к ней)
        var x = r.stops[j];
        rec.pos = oid; rec.ready = at = r1(Math.max(T, x.arrive)); rec.km = r1(x.km); rec.drive = r1(x.drive);
        var source = live.from[oid];           // по пути к этой точке была перегрузка — значит, груз уже забран
        if (source !== undefined) r.seq.forEach(function (other) { if (live.from[oidOf(base, other)] === source) delete live.from[oidOf(base, other)]; });
      }
      var later = incident.type === 'later';
      if (later && !(typeof incident.retryAt === 'number' && isFinite(incident.retryAt) && incident.retryAt >= 0 && incident.retryAt < 24 * 60)) return fail('Не указано, к какому времени привезти.');
      info.stop = stop; info.action = !later && incident.action === 'drop' ? 'drop' : 'retry'; info.later = later;
      if (info.action === 'drop') live.dropped.push(oid);
      else live.retry[oid] = info.retryAt = later ? Math.round(Math.max(at, incident.retryAt)) : Math.round(at + st.retryMin);
      touch[k] = true;
    } else return fail('Неизвестный вид происшествия.');

    var started = Date.now();
    // cap — сколько минут переработки разрешено одному водителю; без cap довозим всё любой ценой.
    function make(key, name, cap) {
      var mine = copy(live), P = core.prepare(input, mine), noOvertime = cap !== undefined;
      if (noOvertime) P.overtimeCap = cap;
      var orig = base.routes.map(function (rt) {
        return rt.seq.slice(cuts[rt.vehicle.id]).filter(function (stop) { return pool.indexOf(stop) < 0 && !P.dropped[stop]; });
      });
      var res = distribute(P, orig, pool, touch, noOvertime, Date.now() + 600);
      res.dropped.forEach(function (stop) {
        var oid = oidOf(base, stop);
        mine.dropped.push(oid); P.dropped[stop] = true;
      });
      var seqs = base.routes.map(function (rt, i) { return rt.seq.slice(0, cuts[rt.vehicle.id]).concat(res.tails[i]); });
      var plan = core.finish(P, core.describe(P, seqs));
      var text = info.type === 'breakdown' ? explainBreakdown(P, base, plan, info, pool) :
        (info.type === 'delay' ? explainDelay(P, base, plan, info, orig[k]) : explainStop(P, base, plan, info));
      var stats = summarize(base, plan);
      text.lines = text.lines.concat(priceLines(plan, stats));
      mine.log.push({ at: T, type: info.type, vehicleId: id, title: text.title, lines: text.lines });
      plan.ms = Date.now() - started;
      return { key: key, name: name, plan: plan, assignment: S.toAssignment(plan), live: mine, title: text.title, lines: text.lines, stats: stats };
    }
    var first = make('all', info.type === 'breakdown' ? 'Довезти всё' : 'Новый маршрут'), variants = [first];
    // Если без переработки не обошлось, считаем ещё варианты: часть точек — не сегодня, зато водители не перерабатывают.
    if (info.type === 'breakdown' && first.stats.overtime > 0.5) {
      var calm = make('calm', 'Без переработки', st.overtimeToleranceMin || 0), mid = null, limit = st.replanOvertimeMin || 0;
      if (limit > (st.overtimeToleranceMin || 0) && first.stats.overtimeMax > limit) mid = make('mid', 'Переработка до ' + (limit % 60 ? hours(limit) : limit / 60 + ' ч'), limit);
      // Средний вариант показываем, только если он правда отличается: довозит больше, чем «без переработки»,
      // и при этом либо что-то не довозит, либо заметно снимает нагрузку с самого занятого водителя.
      if (mid && mid.stats.dropped < calm.stats.dropped &&
        (mid.stats.dropped > first.stats.dropped || mid.stats.overtimeMax < first.stats.overtimeMax - 5)) variants.push(mid);
      if (calm.stats.dropped > first.stats.dropped) variants.push(calm);
    }
    return { ok: true, message: '', at: T, variants: variants };
  }

  // ---------- подсказки для окна «Форс-мажор» ----------
  // Что машина делает в момент T по плану и какие точки у неё ещё впереди.
  function status(plan, vehicleId, T, marks) {
    var r = routeOf(plan, vehicleId), out = { text: '', remaining: [] };
    if (!r || !r.seq.length) { out.text = 'У этой машины сегодня нет маршрута.'; return out; }
    if (r.broken) { out.text = 'Эта машина уже снята с маршрута.'; return out; }
    var c = committed(plan, r, T, marks, false), n = r.stops.length, done = 0, i;
    for (i = 0; i < n; i++) if (r.stops[i].end <= T) done++;
    for (i = Math.max(0, c - 1); i < n; i++) {
      if (r.stops[i].fixed || r.stops[i].end <= T) continue;
      out.remaining.push({ orderId: oidOf(plan, r.stops[i].stop), title: plan.stops[r.stops[i].stop].orders[0].name, at: r.stops[i].start });
    }
    var cur = c ? r.stops[c - 1] : null, text = 'К ' + clock(T) + ' по плану: ';
    if (!c) text += 'ещё на заводе, выезд в ' + clock(r.stops[0].leave) + '.';
    else if (c === n && r.back <= T) text += 'уже вернулась на завод (в ' + clock(r.back) + ').';
    else if (c === n && cur.end <= T) text += 'все точки разгружены, едет на завод.';
    else text += 'разгружено ' + done + ' из ' + n + ', ' + (cur.arrive <= T ? 'стоит у точки ' : 'едет к точке ') + stopName(plan.stops[cur.stop]) + '.';
    out.text = text;
    return out;
  }

  // Какое время происшествия предложить. Отметки водителя важнее часов: демо показывают днём, а план — на раннее утро.
  function suggestTime(plan, vehicleId, marks, clockNow) {
    var r = routeOf(plan, vehicleId), floor = plan.live ? plan.live.now : 0;
    if (!r || !r.stops.length) return Math.max(floor, clockNow);
    var last = null, kind = '';
    r.stops.forEach(function (x) { var m = marks && marks[vehicleId + ':' + oidOf(plan, x.stop)]; if (m) { last = x; kind = m; } });
    if (last) return Math.max(floor, Math.round(kind === 'done' ? last.end + 5 : (kind === 'unloading' ? last.start + 5 : last.arrive)));
    var lo = Math.max(floor, r.depart), hi = Math.max(lo, r.back);
    if (clockNow >= lo && clockNow <= hi) return clockNow;
    return Math.round((lo + hi) / 2 / 5) * 5;
  }

  var api = { propose: propose, status: status, suggestTime: suggestTime };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.MilkReplan = api;
})();
