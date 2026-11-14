// ПРЕДЛОЖЕНИЕ «БЫЛО → СТАНЕТ» (этап 1Б).
// Главная идея продукта: программа предлагает, логист решает. Поэтому изменение (список из js/changes.js)
// сначала накладывается на КОПИЮ данных, по копии считается новый план, и логист видит сравнение
// по четырём целям заказчика. В общий план и в базу оно попадает только по кнопке «Применить».
//
// Что здесь лежит:
//   make(...)    — посчитать предложение (в базу ничего не пишет);
//   save(...)    — записать в базу то, чем новые данные отличаются от прежних (вызывается по «Применить»);
//   goals(...)   — четыре цели заказчика для любого плана; tiles(...) — верхняя строка экрана;
//   card(...)    — карточка предложения; whatIf(...) и scenario(...) — пять кнопок «а если».
// Экран (js/app.js) только вызывает эти функции и вешает кнопки.
(function () {
  'use strict';
  var node = typeof module !== 'undefined' && module.exports;
  var S = node ? require('./solver.js') : window.MilkSolver;
  var C = node ? require('./changes.js') : window.MilkChanges;
  function R() { return node ? require('./replan.js') : window.MilkReplan; }       // нужен только в идущем дне
  function F() { return node ? require('./fleet.js') : window.MilkFleet; }

  var NOON = 12 * 60;                       // «время доставки»: сколько груза разгружено к 12:00
  function clock(min) { min = Math.round(min); var h = Math.floor(min / 60) % 24, m = min % 60; return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m; }
  function hours(min) { min = Math.round(min); return min < 60 ? min + ' мин' : Math.floor(min / 60) + ' ч ' + (min % 60 < 10 ? '0' : '') + (min % 60) + ' мин'; }
  function num(x) { return Math.round(x).toLocaleString('ru-RU'); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function plural(n, one, few, many) {
    var a = Math.abs(n) % 100, b = a % 10;
    return n + ' ' + (a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many);
  }

  // ---------- четыре цели заказчика ----------
  // Дословно из задания: «сократить время доставки, снизить суммарный пробег, уменьшить количество транспорта,
  // уложиться в окно доставки». plan — ответ решателя, input — данные, по которым он считан, naive — «план по списку».
  function goals(plan, input, naive) {
    var st = input.settings, total = 0, byNoon = 0, kgDone = 0, kgTime = 0, important = 0, onTime = 0, longest = 0, loadSum = 0;
    plan.stops.forEach(function (s) { total += s.kg; if (s.important) important++; });
    plan.routes.forEach(function (r) {
      if (r.seq.length) { longest = Math.max(longest, st.loadMin + r.back - r.depart); loadSum += r.loadPct; }
      r.stops.forEach(function (x) {
        var s = plan.stops[x.stop];
        kgDone += s.kg; kgTime += s.kg * x.start;
        if (x.end <= NOON + 0.01) byNoon += s.kg;     // разгрузка закончилась к 12:00
        if (s.important && x.late <= 0.5) onTime++;
      });
    });
    var active = input.vehicles.filter(function (v) { return v.active !== false; }).length;
    var overVeh = plan.routes.filter(function (r) { return r.overtime > 0.5; }).length;
    return {
      delivery: { pct: total ? byNoon / total * 100 : 0, avgStart: kgDone ? kgTime / kgDone : 0 },
      km: { km: plan.km, refKm: naive ? st.refKmPerRoute * naive.used : 0, listKm: naive ? naive.km : 0, refPerRoute: st.refKmPerRoute, refRoutes: naive ? naive.used : 0 },
      fleet: { used: plan.used, active: active, avgLoad: plan.used ? loadSum / plan.used : 0, garage: Math.max(0, active - plan.used), minLoad: st.minLoadPct },
      window: { onTime: onTime, important: important, longest: longest, overtime: plan.overtimeMin, overtimeVehicles: overVeh, shiftMin: st.shiftMin,
        tol: st.overtimeToleranceMin || 0 },
      dropped: (plan.dropped || []).length,
      problems: plan.problems.length
    };
  }

  // Верхняя строка экрана: четыре плитки, по одной на цель заказчика.
  function tile(label, value, unit, pill, sub) {
    return '<div class="kpi"><span class="kpi-label">' + label + '</span><span class="kpi-value">' + value +
      (unit ? ' <small>' + unit + '</small>' : '') + (pill || '') + '</span><span class="kpi-sub">' + sub + '</span></div>';
  }
  function pill(kind, text) { return '<span class="pill ' + kind + '">' + text + '</span>'; }
  function tiles(g, plan) {
    var k = g.km, f = g.fleet, w = g.window, html = '';
    function vs(ref) { var d = ref ? (k.km - ref) / ref * 100 : 0; return pill(d <= 0 ? 'good' : 'bad', (d <= 0 ? '−' : '+') + num(Math.abs(d)) + '%'); }
    html += tile('Время доставки', num(g.delivery.pct) + '%', 'груза к 12:00', '',
      'Доля груза по весу, разгруженного к 12:00. Средний час разгрузки ' + clock(g.delivery.avgStart) + ' (по весу)');
    html += tile('Суммарный пробег', num(k.km), 'км', '',
      'Как сейчас, две оценки:<br>' + vs(k.refKm) + ' от ' + num(k.refKm) + ' км — ' + k.refPerRoute + ' км × ' + k.refRoutes +
      ' маршрутов, со слов логистов<br>' + vs(k.listKm) + ' от ' + num(k.listKm) + ' км — «по списку»: список заказчика по порядку, нарезан по вместимости машин');
    html += tile('Количество транспорта', f.used, 'из ' + f.active, f.garage ? pill('good', f.garage + ' в гараже') : '',
      (plan && plan.live ? 'День идёт: снимок на ' + clock(plan.live.now) + ', уже сделанное не меняется. ' : '') +
      'Средняя загрузка ' + num(f.avgLoad) + '%, правило: не ниже ' + f.minLoad + '%');
    var shiftOk = w.longest <= w.shiftMin + Math.max(0.5, w.tol);
    html += tile('Окно доставки', w.onTime, 'из ' + w.important + ' важных вовремя',
      pill(w.onTime === w.important ? 'good' : 'bad', w.onTime === w.important ? 'все вовремя' : 'опоздания'),
      'Самая длинная смена ' + hours(w.longest) + (shiftOk ? ' — в норме ' : ' — больше нормы ') + hours(w.shiftMin) + '. ' +
      (w.overtime > 0.5 ? 'Переработка ' + hours(w.overtime) + ' на ' + plural(w.overtimeVehicles, 'водителя', 'водителей', 'водителей') : 'Переработки нет'));
    return html;
  }

  // ---------- предложение ----------
  // cur  = { input, plan, naive } — что сейчас на экране (общий черновик);
  // list — список изменений (js/changes.js);
  // opts = { solve(input) → план, base, marks } — solve по умолчанию MilkFleet.solve (как кнопка «Пересчитать»);
  //        base — утверждённый план (нужен только для происшествий идущего дня), marks — отметки водителей.
  // Возвращает { ok, errors, list, lines, data, plan, naive, before, after, live } и НИЧЕГО не пишет в базу.
  function make(cur, list, opts) {
    opts = opts || {};
    var chk;
    try { chk = C.check(list, cur.input); } catch (e) { chk = { ok: false, errors: ['Список изменений не прочитан: ' + e.message] }; }
    if (!chk.ok) return { ok: false, errors: chk.errors, list: [], lines: [] };
    var lines = chk.list.map(function (c) { return C.describe(c, cur.input); });
    var started = Date.now(), data, plan, naive, live = null;
    try {
      if (C.isLive(chk.list[0])) {
        // Идущий день: с начала дня считать нельзя, перестраивается остаток (js/replan.js). Данные не меняются.
        if (!opts.base) return { ok: false, errors: ['План ещё не утверждён: происшествия идущего дня разбираются только от утверждённого плана.'], list: chk.list, lines: lines };
        var res = R().propose(cur.input, opts.base, C.toIncident(chk.list[0], opts.base), opts.marks || null);
        if (!res.ok) return { ok: false, errors: [res.message], list: chk.list, lines: lines };
        var v = res.variants[0];
        data = cur.input; plan = v.plan; live = v; lines = lines.concat(v.lines);
      } else {
        data = C.apply(cur.input, chk.list);
        plan = (opts.solve || F().solve)(data);
      }
      naive = S.naive(data);
    } catch (e) {
      return { ok: false, errors: ['Не получилось посчитать предложение: ' + e.message], list: chk.list, lines: lines };
    }
    return { ok: true, errors: [], list: chk.list, lines: lines, data: data, plan: plan, naive: naive, live: live, ms: Date.now() - started,
      before: goals(cur.plan, cur.input, cur.naive), after: goals(plan, data, naive) };
  }

  // ---------- «Применить»: запись в базу ----------
  // Пишем только то, чем новые данные отличаются от прежних: так в базу попадает ровно список изменений.
  // Заказы пишутся пачкой (store.saveOrders): «обычный день» меняет вес у всех 214 заказов сразу.
  // Возвращает Promise; черновик плана экран сохраняет ПОСЛЕ записи данных, чтобы другие экраны
  // получили сначала данные, потом план, и не начали считать сами.
  function save(store, before, after) {
    var jobs = [], orders = [];
    after.orders.forEach(function (o) {
      var was = null;
      for (var i = 0; i < before.orders.length; i++) if (before.orders[i].id === o.id) { was = before.orders[i]; break; }
      var patch = { id: o.id }, changed = false;     // только поля, которые поменялись: так правок одного вида больше в одной пачке
      if (!was || was.kg !== o.kg) { patch.kg = o.kg; changed = true; }
      if (!was || was.from !== o.from) { patch.from = o.from; changed = true; }
      if (!was || !!was.timeExplicit !== !!o.timeExplicit) { patch.timeExplicit = !!o.timeExplicit; changed = true; }
      if (changed) orders.push(patch);
    });
    if (orders.length) jobs.push(store.saveOrders(orders));
    after.vehicles.forEach(function (v) {
      var was = before.vehicles.filter(function (x) { return x.id === v.id; })[0];
      if (!was || (was.active !== false) !== (v.active !== false) || was.cap !== v.cap || was.name !== v.name) jobs.push(store.saveVehicle(v));
    });
    if (JSON.stringify(before.settings) !== JSON.stringify(after.settings)) jobs.push(store.saveSettings(after.settings));
    return Promise.all(jobs).then(function () { return { orders: orders.length, jobs: jobs.length }; });
  }

  // ---------- карточка предложения ----------
  function goalRows(g) {
    var w = g.window;
    return [
      ['Время доставки', num(g.delivery.pct) + '% груза к 12:00, в среднем ' + clock(g.delivery.avgStart)],
      ['Суммарный пробег', num(g.km.km) + ' км'],
      ['Количество транспорта', g.fleet.used + ' из ' + g.fleet.active + ', загрузка ' + num(g.fleet.avgLoad) + '%'],
      ['Окно доставки', w.onTime + ' из ' + w.important + ' вовремя; смена до ' + hours(w.longest) + (w.overtime > 0.5 ? ', переработка ' + hours(w.overtime) : ', без переработки')],
      ['Не везём сегодня', plural(g.dropped, 'точка', 'точки', 'точек')],
      ['Нарушений правил', String(g.problems)]
    ];
  }
  function card(p) {
    if (!p) return '';
    var html = '<div class="proposal' + (p.ok ? '' : ' failed') + '"><b>' + (p.ok ? 'Предложение: ещё не в общем плане' : 'Предложение не построено') + '</b>';
    if (p.lines && p.lines.length) html += '<ul>' + p.lines.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>';
    if (!p.ok) {
      html += '<ul class="proposal-errors">' + p.errors.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>' +
        '<div class="proposal-actions"><button type="button" class="btn" id="prop-cancel">Закрыть</button></div></div>';
      return html;
    }
    var a = goalRows(p.before), b = goalRows(p.after);
    html += '<table class="proposal-goals"><thead><tr><th>Цель заказчика</th><th>Было</th><th>Станет</th></tr></thead><tbody>';
    a.forEach(function (row, i) {
      html += '<tr' + (row[1] !== b[i][1] ? ' class="changed"' : '') + '><th>' + row[0] + '</th><td>' + esc(row[1]) + '</td><td>' + esc(b[i][1]) + '</td></tr>';
    });
    html += '</tbody></table><p class="proposal-note">На карте и в маршрутах — предложенный план. Водители и другие экраны его не видят, ' +
      'пока вы не нажмёте «Применить». Таблицы слева пока закрыты для правки.</p>' +
      '<div class="proposal-actions"><button type="button" class="btn primary" id="prop-apply">Применить</button>' +
      '<button type="button" class="btn" id="prop-cancel">Отменить</button></div></div>';
    return html;
  }

  // ---------- пять кнопок «а если» ----------
  // Каждая — готовый список изменений. Почему эти: «обычный день» отвечает на цель «уменьшить количество транспорта»;
  // время разгрузки и порог мелкой точки — допущения, от которых результат зависит сильнее всего (ответа логистов нет);
  // «без переработки» показывает цену правила 90%.
  // Наименее загруженная машина в текущем плане — её по умолчанию предлагаем убрать.
  function leastLoaded(plan) {
    var best = null;
    plan.routes.forEach(function (r) { if (r.seq.length && (!best || r.loadPct < best.loadPct)) best = r; });
    return best ? best.vehicle.id : 0;
  }
  function scenario(key, input, vehicleId) {
    var st = input.settings;
    if (key === 'normal') return [{ kind: 'scale_kg', factor: 0.7 }];
    if (key === 'unload25') return [{ kind: 'setting', key: 'serviceMin', value: 25 }];
    if (key === 'small200') return [{ kind: 'setting', key: 'smallStopKg', value: 200 }];
    if (key === 'minus1') return [{ kind: 'vehicle_off', vehicleId: vehicleId }];
    if (key === 'priority') return [{ kind: 'setting', key: 'fleetPriority', value: st.fleetPriority === 'overtime' ? 'fewer' : 'overtime' }];
    return [];
  }
  var KEYS = ['normal', 'unload25', 'small200', 'minus1', 'priority'];
  function whatIf(plan, input) {
    var st = input.settings, least = leastLoaded(plan);
    var on = input.vehicles.filter(function (v) { return v.active !== false; });
    var opts = on.map(function (v) {
      var r = plan.routes.filter(function (x) { return x.vehicle.id === v.id; })[0];
      return '<option value="' + v.id + '"' + (v.id === least ? ' selected' : '') + '>' + esc(String(v.name).split(' · ')[0]) +
        (r && r.seq.length ? ' · загрузка ' + num(r.loadPct) + '%' : ' · в гараже') + '</option>';
    }).join('');
    return '<div class="whatif"><b>А если…</b><div class="whatif-buttons">' +
      '<button type="button" class="btn" data-whatif="normal" title="Те же точки, вес каждого заказа ×0,7">Обычный день: вес на 30% меньше</button>' +
      '<button type="button" class="btn" data-whatif="unload25">Разгрузка ' + 25 + ' мин вместо ' + st.serviceMin + '</button>' +
      '<button type="button" class="btn" data-whatif="small200">Мелкая точка — до 200 кг вместо ' + st.smallStopKg + '</button>' +
      '<span class="whatif-minus"><button type="button" class="btn" data-whatif="minus1">Минус одна машина:</button>' +
      '<select id="whatif-vehicle" aria-label="Какую машину убрать">' + opts + '</select></span>' +
      '<button type="button" class="btn" data-whatif="priority">' + (st.fleetPriority === 'overtime' ? 'Меньше машин, загрузка не ниже 90%' : 'Без переработки, машин сколько нужно') + '</button>' +
      '</div></div>';
  }

  var api = { make: make, save: save, goals: goals, tiles: tiles, card: card, whatIf: whatIf, scenario: scenario, leastLoaded: leastLoaded, KEYS: KEYS };
  if (typeof window !== 'undefined') window.MilkProposal = api;
  if (node) module.exports = api;
})();
