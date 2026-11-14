// ЭКРАН ДИСПЕТЧЕРА. Связывает всё вместе: данные из базы, решатель, таблицы, показатели, маршруты.
// Любая правка сохраняется в базу и запускает пересчёт; другие открытые экраны получают её сразу.
(function () {
  'use strict';
  var DATA = window.MILK_DATA, DEFAULTS = window.MILK_SETTINGS, Store = window.MilkStore, LOCAL_KEY = 'milk.plan.v3';
  var COLORS = ['#e6194b', '#2a9d3a', '#4363d8', '#f58231', '#911eb4', '#0aa5b5', '#d43fb8', '#7a9a01',
    '#b3541e', '#00897b', '#6a5acd', '#9a6324', '#c2185b', '#2e7d32', '#1565c0', '#5d4037'];
  var KIND = { departed: 'Выехал с завода', arrived: 'Приехал на точку', unloading: 'Начал разгрузку',
    done: 'Закончил разгрузку', returned: 'Вернулся на завод', problem: 'Проблема' };

  var state;                                 // { orders, vehicles, settings }
  var plans = { best: null, naive: null };   // показанный план и «план по списку» для сравнения
  var draft = null, approved = null;         // общий черновик и утверждённый план: { assignment, at }
  var events = [];                           // события от водителей
  var roads = null;                          // таблица расстояний по дорогам: из базы, а без базы — из js/roads.js
  // Эталонный план (js/base-plan.js): посчитан заранее на исходных данных с большим запасом времени
  // (tools/make-base-plan.js). Тот же план лежит в базе и возвращается кнопкой «Сбросить демо».
  var BASE = window.MILK_BASE_PLAN || null;
  var view = 'best', selected = -1, mapTimer = null;
  var solveTimer = null, remoteTimer = null, fallbackTimer = null, toastTimer = null;
  var remoteData = false, remoteStructure = false;

  function $(id) { return document.getElementById(id); }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function num(x, digits) { return x.toLocaleString('ru-RU', { maximumFractionDigits: digits || 0, minimumFractionDigits: digits || 0 }); }
  function clock(min) { min = Math.round(min); var h = Math.floor(min / 60) % 24, m = min % 60; return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m; }
  function clockOf(iso) { var d = new Date(iso); return clock(d.getHours() * 60 + d.getMinutes()); }
  function hours(min) { min = Math.round(min); return Math.floor(min / 60) + ' ч ' + (min % 60 < 10 ? '0' : '') + (min % 60) + ' мин'; }
  function plural(n, one, few, many) {   // 1 остановка, 2 остановки, 5 остановок
    var a = n % 10, b = n % 100;
    return n + ' ' + (a === 1 && b !== 11 ? one : (a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many));
  }
  function parseClock(s) { var p = String(s).split(':'); return (+p[0] || 0) * 60 + (+p[1] || 0); }
  function orderById(id) { for (var i = 0; i < state.orders.length; i++) if (state.orders[i].id === id) return state.orders[i]; return null; }
  function vehicleById(id) { for (var i = 0; i < state.vehicles.length; i++) if (state.vehicles[i].id === id) return state.vehicles[i]; return null; }
  function input() { return { depot: DATA.depot, orders: state.orders, vehicles: state.vehicles, settings: state.settings, roads: roads }; }
  function colorOf(vehicleId) {
    for (var i = 0; i < state.vehicles.length; i++) if (state.vehicles[i].id === vehicleId) return COLORS[i % COLORS.length];
    return '#888';
  }

  // ---------- работа без сервера (запасной режим) ----------
  function roadsFromFile() { return window.MILK_ROADS ? window.MilkSolver.roadsFrom(window.MILK_ROADS) : null; }
  function baseDraft() {
    return BASE ? { assignment: clone(BASE.assignment), summary: clone(BASE.summary), live: null, at: new Date().toISOString() } : null;
  }
  function fresh() { return { orders: clone(DATA.orders), vehicles: clone(DATA.vehicles), settings: clone(DEFAULTS) }; }
  function loadLocal() {
    try {
      var s = JSON.parse(localStorage.getItem(LOCAL_KEY));
      if (s && s.version === DATA.version && s.orders) {
        draft = s.draft || null; approved = s.approved || null;
        return { orders: s.orders, vehicles: s.vehicles, settings: Object.assign(clone(DEFAULTS), s.settings || {}) };
      }
    } catch (e) { /* хранилище недоступно */ }
    return fresh();
  }
  function saveLocal() {
    if (Store.isOnline()) return;
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify({ version: DATA.version, orders: state.orders, vehicles: state.vehicles,
        settings: state.settings, draft: draft, approved: approved }));
    } catch (e) { /* не страшно */ }
  }

  // ---------- расчёт ----------
  // Снимок дня: он есть у плана, который перестраивали, когда машины уже в рейсе (см. js/replan.js).
  // У плана из базы снимок лежит внутри summary.
  function liveOf(p) { return p ? (p.live || (p.summary && p.summary.live) || null) : null; }
  function summaryOf(p) { return { km: Math.round(p.km), used: p.used, problems: p.problems.length, byRoad: !!p.byRoad, live: p.live || null }; }
  // Показанный план становится общим черновиком: его видят все экраны диспетчера.
  function shareDraft() {
    draft = { assignment: window.MilkSolver.toAssignment(plans.best), live: plans.best.live || null, at: new Date().toISOString() };
    Store.saveDraft(draft.assignment, summaryOf(plans.best));
    saveLocal();
  }

  // Расчёт на экране ограничен 2,5 секунды и может выйти хуже эталона, который считали минуту.
  // Поэтому сравниваем с эталоном на тех же данных и берём лучший: меньше нарушений, при равенстве — меньше км.
  // Если состав данных изменился (появились остановки, которых нет в эталоне), эталон не подходит.
  // В режиме «меньше машин» эталон не подходит и тогда, когда он выводит больше машин, чем выбрано по весу:
  // в лёгкий день у эталона (16 машин) может оказаться меньше нарушений, но он нарушает главное правило.
  function notWorseThanBase(p, inp) {          // inp — данные; без него текущие (предложение передаёт свою копию)
    inp = inp || input();
    if (!BASE) return p;
    var b = window.MilkSolver.fromAssignment(inp, BASE.assignment);
    if (b.leftover) return p;
    if (inp.settings.fleetPriority !== 'overtime' && b.used > p.used) return p;
    if (b.problems.length < p.problems.length || (b.problems.length === p.problems.length && b.km < p.km - 0.05)) {
      b.ms = p.ms; b.fromBase = true; return b;
    }
    return p;
  }
  // Считаем новый план здесь и делимся им со всеми экранами.
  // Сначала по весу выбирается число машин (js/fleet.js), потом решатель строит маршруты для них.
  function solveAndShare() {
    clearTimeout(solveTimer); clearTimeout(fallbackTimer); remoteData = false;
    plans.best = notWorseThanBase(window.MilkFleet.solve(input()));
    plans.naive = window.MilkSolver.naive(input());
    shareDraft();
    selected = -1;
    render(true);
    setStatus('расчёт за ' + num(plans.best.ms / 1000, 1) + ' с' + (plans.best.fromBase ? ': эталонный план лучше, оставлен он' : ''));
  }
  // День уже идёт: с нуля считать нельзя (машины в рейсе), поэтому только обновляем время и нарушения.
  function refreshLive() {
    clearTimeout(solveTimer); clearTimeout(fallbackTimer); remoteData = false;
    plans.best = window.MilkSolver.fromAssignment(input(), draft.assignment, null, liveOf(draft));
    plans.naive = window.MilkSolver.naive(input());
    shareDraft();
    render(false);
    setStatus('день идёт: маршруты с нуля не строятся');
  }
  function recalc() { if (liveOf(draft)) refreshLive(); else solveAndShare(); }
  function schedule() { clearTimeout(solveTimer); setStatus('Считаю…'); solveTimer = setTimeout(recalc, 350); }

  // Показываем общий черновик как есть, без нового расчёта (так все экраны видят один и тот же план).
  function showDraft(message) {
    plans.best = window.MilkSolver.fromAssignment(input(), draft.assignment, null, liveOf(draft));
    plans.naive = window.MilkSolver.naive(input());
    if (selected >= plans.best.routes.length) selected = -1;
    render(false);
    setStatus(message);
  }

  // ---------- показ ----------
  function setStatus(text) { $('status').textContent = text || ''; }
  function setConn(text, kind) { var el = $('conn'); el.textContent = text; el.className = 'pill ' + (kind || ''); }
  function toast(text, kind) {
    var el = $('toast');
    el.textContent = text; el.className = 'toast show ' + (kind || '');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { el.className = 'toast'; }, 4500);
  }

  function render(fit) {
    // Пока открыто предложение (этап 1Б), экран на время отрисовки берёт его данные и план, потом возвращает свои.
    var keep = proposal && proposal.ok ? { state: state, best: plans.best, naive: plans.naive, view: view } : null;
    if (keep) { state = proposal.data; plans.best = proposal.plan; plans.naive = proposal.naive; view = 'best'; }
    try {
      var p = plans[view];
      if (!p) return;
      var idx = eventIndex(), fleet = fleetNote(p);
      renderMeta(); renderApproval(); renderKpis(p); renderFeed(); renderBanner(p); renderProblems(p, fleet); renderFleet(fleet); renderRoutes(p, idx); renderChips(p); renderVehicles(p); renderMap(p, fit, idx);
    } finally {
      if (keep) { state = keep.state; plans.best = keep.best; plans.naive = keep.naive; view = keep.view; }
    }
    renderProposal();
  }

  function renderMeta() {
    var kg = 0, n = 0;
    state.orders.forEach(function (o) { if (o.kg > 0) { kg += o.kg; n++; } });
    $('meta').textContent = 'План доставки по Гродно · ' + plural(n, 'заказ', 'заказа', 'заказов') + ' · ' +
      plural(plans.best.stopsTotal, 'остановка', 'остановки', 'остановок') + ' · ' + num(kg / 1000, 1) + ' т';
  }

  // Короткая «подпись» плана: по ней видно, совпадает ли черновик с утверждённым.
  function planKey(p) {
    var live = liveOf(p);
    return p.assignment.map(function (a) { return a.v + ':' + a.s.join(','); }).join('|') + '|' + (live ? live.id : '');
  }
  function approvalState() {
    if (!approved) return 'none';
    return draft && planKey(approved) === planKey(draft) ? 'same' : 'changed';
  }
  function renderApproval() {
    var s = approvalState(), pill = $('approval'), btn = $('btn-approve');
    if (s === 'none') { pill.textContent = 'План не утверждён'; pill.className = 'pill warn'; }
    else if (s === 'same') { pill.textContent = 'Утверждён в ' + clockOf(approved.at); pill.className = 'pill good'; }
    else { pill.textContent = 'Изменён после утверждения'; pill.className = 'pill warn'; }
    btn.disabled = s === 'same' || view !== 'best';
    btn.textContent = s === 'same' ? 'План утверждён' : 'Утвердить план';
  }

  function tile(label, value, unit, pill, sub) {
    return '<div class="kpi"><span class="kpi-label">' + label + '</span><span class="kpi-value">' + value +
      (unit ? ' <small>' + unit + '</small>' : '') + (pill || '') + '</span><span class="kpi-sub">' + sub + '</span></div>';
  }
  // Верхняя строка — четыре цели заказчика его словами (этап 1Б): время доставки, суммарный пробег,
  // количество транспорта, окно доставки. Числа и плитки собирает js/proposal.js.
  function renderKpis(p) {
    $('kpis').innerHTML = window.MilkProposal.tiles(window.MilkProposal.goals(p, input(), plans.naive), p);
  }

  // ---------- события водителей ----------
  function eventIndex() {
    var lastByVehicle = {}, byStop = {};
    events.forEach(function (e) {
      lastByVehicle[e.vehicleId] = e;
      if (e.orderId && e.kind !== 'problem') byStop[e.vehicleId + ':' + e.orderId] = e.kind;
    });
    return { lastByVehicle: lastByVehicle, byStop: byStop };
  }
  function eventText(e) {
    var v = vehicleById(e.vehicleId), o = e.orderId ? orderById(e.orderId) : null;
    return (v ? v.name.split(' · ')[0] : 'Машина ' + e.vehicleId) + ': ' + KIND[e.kind].toLowerCase() +
      (o ? ' · ' + o.name : '') + (e.note ? ' · ' + e.note : '');
  }
  function renderFeed() {
    if (!events.length) {
      $('feed').innerHTML = '<p class="feed-empty">Событий от водителей пока нет. Откройте страницу водителя кнопкой «Водителю».</p>';
      return;
    }
    var html = '<ul class="feed">';
    events.slice(-5).reverse().forEach(function (e) {
      html += '<li class="' + (e.kind === 'problem' ? 'bad' : '') + '"><b>' + clockOf(e.at) + '</b> ' + esc(eventText(e)) +
        (e.kind === 'problem' ? ' <button type="button" class="link" data-event="' + e.id + '">Перестроить</button>' : '') + '</li>';
    });
    $('feed').innerHTML = html + '</ul>';
  }

  // Что случилось сегодня и что предлагается: последнее происшествие с объяснением.
  function renderBanner(p) {
    var live = view === 'best' ? p.live : null, log = live && live.log ? live.log : [];
    if (!log.length) { $('incident').innerHTML = ''; return; }
    var last = log[log.length - 1], pending = approvalState() !== 'same';
    var html = '<div class="incident' + (pending ? ' pending' : '') + '"><b>' + esc(last.title) + '</b><ul>' +
      last.lines.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>';
    if (log.length > 1) html += '<p class="incident-old">Раньше сегодня: ' + esc(log.slice(0, -1).map(function (e) { return e.title; }).join('; ')) + '</p>';
    html += pending ? '<p>Это предложение: водители едут по прежнему плану, пока вы его не утвердите.</p>' +
        '<div class="incident-actions"><button type="button" class="btn primary" id="inc-approve">Утвердить</button>' +
        '<button type="button" class="btn" id="inc-cancel">Отменить</button></div>' :
      '<p>Утверждено в ' + clockOf(approved.at) + ': водители видят новые маршруты.</p>';
    $('incident').innerHTML = html + '</div>';
  }

  function renderProblems(p, fleet) {
    if (!p.problems.length) {
      var within = p.overtimeMin > 0.5 || p.overloadKg > 0.5;
      $('problems').innerHTML = '<div class="problems ok">' + (within ? 'План выполним. Есть мелкие отклонения в пределах допуска, они отмечены на маршрутах' : 'Все правила соблюдены') + '</div>';
      return;
    }
    var items = p.problems.slice(0, 6).map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('');
    if (p.problems.length > 6) items += '<li>и ещё ' + (p.problems.length - 6) + '</li>';
    // Переработку не прячем: если машины, выбранные по весу, не укладываются в смену, логист видит это здесь
    // и рядом — где взять второй вариант (кнопку «а если» для него сделает этап 1Б).
    var hint = fleet && fleet.overtimeHint ? '<p class="problems-hint">Без переработки нужно больше машин — это второй вариант: ' +
      'вкладка «Правила», «Что важнее, если всё сразу не сходится».</p>' : '';
    $('problems').innerHTML = '<div class="problems has"><b>Что не сходится</b><ul>' + items + '</ul>' + hint + '</div>';
  }
  // Одна строка над маршрутами: почему машин столько (текст собирает js/fleet.js).
  function fleetNote(p) {
    return view === 'best' ? window.MilkFleet.explain(p, input()) : null;
  }
  function renderFleet(fleet) {
    $('fleet-note').innerHTML = fleet ? '<p class="fleet-note">' + esc(fleet.text) + '</p>' : '';
  }

  function stopTitle(s) { return s.orders.map(function (o) { return o.name; }).join(' + '); }
  var STOP_MARK = { arrived: '●', unloading: '▶', done: '✓' };

  function placeName(p, node) {          // место перегрузки словами
    if (!node) return 'на заводе';
    return 'у точки «' + p.stops[node - 1].orders[0].name + '», ' + p.stops[node - 1].address;
  }
  function moveSelect(oid, skipId, label, broken) {
    var html = '<select class="move" data-oid="' + oid + '" aria-label="' + label + '"><option value="">' + label + '…</option>';
    state.vehicles.forEach(function (v) {
      if (v.active !== false && v.cap > 0 && v.id !== skipId && !broken[v.id]) html += '<option value="' + v.id + '">' + esc(v.name) + '</option>';
    });
    return html + '</select>';
  }

  function renderRoutes(p, idx) {
    var html = '', garage = [], live = p.live, broken = {}, st = state.settings;
    // Из снимка дня: у каких точек груз ещё в сломанной машине, какие пришли из другой машины, к каким вернуться позже.
    var from = (live && live.from) || {}, moved = (live && live.moved) || {}, retry = (live && live.retry) || {};
    p.routes.forEach(function (r) { if (r.broken) broken[r.vehicle.id] = true; });
    p.routes.forEach(function (r, k) {
      if (!r.seq.length) { garage.push(r.vehicle.name + (r.broken ? ' (сломана)' : '')); return; }
      var c = colorOf(r.vehicle.id), sel = k === selected, flags = '', last = idx.lastByVehicle[r.vehicle.id];
      var left = live ? r.seq.length - r.cut : 0, got = 0, done = 0;
      r.seq.forEach(function (si) {
        var oid = p.stops[si].orders[0].id;
        if (moved[oid] !== undefined && moved[oid] !== r.vehicle.id) got++;
        if (idx.byStop[r.vehicle.id + ':' + oid] === 'done') done++;
      });
      var barClass = r.overloadBad ? 'bad' : (!live && r.loadPct < st.minLoadPct ? 'warn' : '');
      if (r.broken) flags += '<span class="pill bad">сломалась в ' + clock(r.back) + '</span>';
      if (got) flags += '<span class="pill warn">+' + got + ' точ. из сломанной машины</span>';
      if (r.overloadBad) flags += '<span class="pill bad">перегруз ' + num(r.overload) + ' кг</span>';
      else if (r.overload > 0.5) flags += '<span class="pill warn">+' + num(r.overload) + ' кг, в допуске</span>';
      if (r.overtimeBad) flags += '<span class="pill bad">переработка ' + num(r.overtime) + ' мин</span>';
      else if (r.overtime > 0.5) flags += '<span class="pill warn">+' + num(r.overtime) + ' мин, в допуске</span>';
      if (r.late > 0.5) flags += '<span class="pill bad">опоздание</span>';
      if (r.center > 0) flags += '<span class="pill bad">большая машина в центре</span>';
      if (!live && r.loadPct < st.minLoadPct) flags += '<span class="pill warn">недогруз</span>';
      // Пока день не начался, справа загрузка; когда идёт — что машине осталось.
      var right = !live ? num(r.load) + ' / ' + num(r.vehicle.cap) + ' кг' :
        (r.broken ? 'снята с маршрута' : (left ? 'осталось ' + left + ' точ.' : (r.returned ? 'на заводе' : 'едет на завод')));
      html += '<div class="route' + (sel ? ' sel' : '') + (r.broken ? ' broken' : '') + '" style="--c:' + c + '">' +
        '<button type="button" class="route-head" data-k="' + k + '" aria-expanded="' + sel + '">' +
        '<span class="route-title"><span>' + esc(r.vehicle.name) + '</span><span>' + right + '</span></span>' +
        '<span class="bar ' + barClass + '"><i style="width:' + Math.min(100, r.loadPct).toFixed(0) + '%"></i></span>' +
        '<span class="route-meta">' + r.seq.length + ' точ. · ' + num(r.km, 1) + ' км · ' + clock(r.depart) + '–' + clock(r.back) +
          (live ? '' : ' · загрузка ' + num(r.loadPct) + '%') + '</span>' +
        (last ? '<span class="route-now' + (last.kind === 'problem' ? ' bad' : '') + '">' + clockOf(last.at) + ' · ' + esc(KIND[last.kind]) +
          (last.note ? ': ' + esc(last.note) : '') + (done ? ' · разгружено ' + done + ' из ' + r.seq.length : '') + '</span>' : '') +
        (flags ? '<span class="route-flags">' + flags + '</span>' : '') + '</button>';
      if (sel) {
        html += '<ol>';
        r.stops.forEach(function (x) {
          var s = p.stops[x.stop], oid = s.orders[0].id, mark = idx.byStop[r.vehicle.id + ':' + oid], note = '';
          if (x.pickup) html += '<li class="pickup"><b>⇄ ' + clock(x.pickup.arrive) + '</b> Перегрузка из сломанной машины<br><span>' +
            esc(placeName(p, x.pickup.node)) + ' · забрать ' + x.pickup.count + ' точ., ' + num(x.pickup.kg) + ' кг</span></li>';
          if (moved[oid] !== undefined && moved[oid] !== r.vehicle.id) note += ' · из машины ' + moved[oid];
          if (retry[oid] !== undefined && !x.fixed) note += ' · вернуться не раньше ' + clock(retry[oid]);
          if (x.late > 0.5) note += ' · опоздание ' + num(x.late) + ' мин';
          // Пока день не начался, переносить можно любую точку; когда идёт — только груз, который ещё лежит в сломанной машине.
          var canMove = view === 'best' && !x.fixed && (!live || from[oid] !== undefined);
          html += '<li class="' + (x.late > 0.5 ? 'late ' : '') + (mark ? 'st-' + mark : (x.fixed ? 'st-done' : '')) + '"><b>' + (mark ? STOP_MARK[mark] + ' ' : '') + clock(x.start) + '</b> ' +
            (s.important ? '★ ' : '') + esc(stopTitle(s)) +
            '<br><span>' + esc(s.address) + ' · ' + num(s.kg) + ' кг' + esc(note) + '</span>' +
            (canMove ? moveSelect(oid, r.vehicle.id, 'Перенести', broken) : '') + '</li>';
        });
        html += '</ol>';
      }
      html += '</div>';
    });
    if (live && p.dropped.length) {
      html += '<div class="dropped"><b>Сегодня не доставим</b><ul>';
      p.dropped.forEach(function (si) {
        var s = p.stops[si], oid = s.orders[0].id;
        html += '<li>' + (s.important ? '★ ' : '') + esc(stopTitle(s)) + '<br><span>' + esc(s.address) + ' · ' + num(s.kg) + ' кг' +
          (from[oid] !== undefined ? ' · груз в сломанной машине' : ' · груз вернётся на завод') + '</span>' +
          (view === 'best' && from[oid] !== undefined ? moveSelect(oid, 0, 'Всё-таки отдать машине', broken) : '') + '</li>';
      });
      html += '</ul></div>';
    }
    if (garage.length) html += '<p class="garage">В гараже: ' + esc(garage.join(', ')) + '</p>';
    $('routes').innerHTML = html;
  }

  // В таблице заказов показываем, какой машине достался каждый заказ.
  function renderChips(p) {
    var byOrder = {};
    p.routes.forEach(function (r) {
      r.seq.forEach(function (si) { p.stops[si].orders.forEach(function (o) { byOrder[o.id] = r.vehicle; }); });
    });
    state.orders.forEach(function (o) {
      var chip = $('chip-' + o.id), v = byOrder[o.id];
      if (!chip) return;
      if (v) { chip.className = 'chip'; chip.style.background = colorOf(v.id); chip.textContent = v.id; chip.title = v.name; }
      else { chip.className = 'chip none'; chip.style.background = ''; chip.textContent = '–'; chip.title = 'Не везём'; }
    });
  }

  function renderVehicles(p) {
    var loadOf = {}, html = '';
    p.routes.forEach(function (r) { loadOf[r.vehicle.id] = r; });
    state.vehicles.forEach(function (v) {
      var r = loadOf[v.id], pct = r && r.seq.length ? r.loadPct : 0;
      var barClass = pct > 100 ? 'bad' : (pct > 0 && pct < state.settings.minLoadPct ? 'warn' : '');
      html += '<tr class="' + (v.active === false ? 'off' : '') + '">' +
        '<td><input type="checkbox" id="veh-on-' + v.id + '" data-id="' + v.id + '" class="veh-on"' + (v.active === false ? '' : ' checked') + ' aria-label="' + esc(v.name) + ' на линии"></td>' +
        '<td><span class="chip" style="background:' + colorOf(v.id) + '">' + v.id + '</span> ' + esc(v.name) + '</td>' +
        '<td><input type="number" id="veh-cap-' + v.id + '" data-id="' + v.id + '" class="veh-cap" min="0" step="100" value="' + v.cap + '" aria-label="Вместимость"></td>' +
        '<td class="cap-cell"><small>' + (r && r.seq.length ? num(pct) + '% · ' + r.seq.length + ' точ.' : (v.active === false ? 'снята' : 'в гараже')) + '</small>' +
        '<span class="bar ' + barClass + '"><i style="width:' + Math.min(100, pct).toFixed(0) + '%"></i></span></td></tr>';
    });
    $('vehicles-table').tBodies[0].innerHTML = html;
  }

  function renderMap(p, fit, idx) {
    var routes = [], marks = [], pending = 0, live = p.live, byOrder = {};
    p.stops.forEach(function (s) { byOrder[s.orders[0].id] = s; });
    p.routes.forEach(function (r, k) {
      if (r.broken) {                      // крестик там, где стоит сломанная машина
        var rec = live.vehicles[r.vehicle.id], at = rec && rec.pos ? byOrder[rec.pos] : DATA.depot;
        if (at) marks.push({ lat: at.lat, lon: at.lon, title: r.vehicle.name + ': сломалась в ' + clock(r.back) });
      }
      if (!r.seq.length) return;
      var points = [], path = [];          // points — кружки остановок; path — через что идёт линия (с заездом на перегрузку)
      r.stops.forEach(function (x, i) {
        var s = p.stops[x.stop], title = stopTitle(s), st = idx.byStop[r.vehicle.id + ':' + s.orders[0].id];
        if (x.pickup) path.push(x.pickup.node ? p.stops[x.pickup.node - 1] : DATA.depot);
        path.push(s);
        points.push({ lat: s.lat, lon: s.lon, n: i + 1, color: st === 'done' || x.fixed ? '#9aa8b5' : null,
          title: esc(clock(x.start) + ' ' + title + ', ' + num(s.kg) + ' кг'),
          html: '<b>' + esc(title) + '</b><br>' + esc(s.address) + '<br>' + esc(r.vehicle.name) + ', остановка ' + (i + 1) +
            '<br>Разгрузка с ' + clock(x.start) + ', ' + num(s.kg) + ' кг' + (x.pickup ? '<br>Перед ней перегрузка в ' + clock(x.pickup.arrive) : '') +
            (st ? '<br>Статус: ' + esc(KIND[st].toLowerCase()) : '') });
      });
      if (!r.road) askRoad(p, r, path);
      if (!r.road) pending++;
      routes.push({ k: k, color: colorOf(r.vehicle.id), name: r.vehicle.name, road: r.road || null, open: !!r.broken, points: points, path: path });
    });
    window.MilkMap.draw({ depot: DATA.depot, selected: selected, routes: routes, marks: marks }, fit);
    var note = p.byRoad ? 'Расстояния и время посчитаны по дорогам (данные OpenStreetMap), время в пути умножено на ' +
        String(state.settings.trafficFactor).replace('.', ',') + ' как запас на пробки.' :
      'Таблицы дорог нет: расстояния оценены по прямой с поправкой ×' + String(state.settings.detour).replace('.', ',') + '.';
    if (live) note = 'День идёт: серые точки уже пройдены' + (marks.length ? ', крестик — сломанная машина' : '') + '. ' + note;
    if (pending) note = 'Прокладываю линии по улицам, осталось маршрутов: ' + pending + '. ' + note;
    if (window.MilkMap.mode() === 'svg') note = 'Карта-подложка недоступна, показана схема. ' + note;
    $('map-note').textContent = note;
  }

  // Линия маршрута по улицам: берём готовую из памяти или запрашиваем один раз и перерисовываем карту.
  // Сломанная машина на завод не возвращается, её линия обрывается на последней точке.
  function askRoad(p, r, pts) {
    var hit = window.MilkMap.roadCached(DATA.depot, pts, r.broken);
    if (hit) { r.road = hit.coords; return; }
    if (r.roadAsked) return;
    r.roadAsked = true;
    window.MilkMap.roadRoute(DATA.depot, pts, r.broken).then(function (res) {
      if (!res) return;
      r.road = res.coords;
      if (plans[view] !== p) return;
      clearTimeout(mapTimer);
      mapTimer = setTimeout(function () { if (plans[view] === p) renderMap(p, false, eventIndex()); }, 80);
    });
  }

  // Клик по маршруту: раскрываем список его точек и выделяем его на карте.
  function pick(k) {
    selected = selected === k ? -1 : k;
    render(false);
  }

  // Логист переносит остановку в другую машину. Остальное не трогаем, только пересчитываем время.
  function moveStop(orderId, vehicleId) {
    var before = plans.best.km, live = plans.best.live ? clone(plans.best.live) : null, o = orderById(orderId);
    if (live) {                            // правка поверх перестроения; точка могла быть в списке «не доставим»
      live.dropped = (live.dropped || []).filter(function (x) { return x !== orderId; });
      live.id += '+';
      if (live.log && live.log.length && o) live.log[live.log.length - 1].lines.push('Правка логиста: «' + o.name + '» передана машине ' + vehicleId + '.');
    }
    plans.best = window.MilkSolver.fromAssignment(input(), window.MilkSolver.toAssignment(plans.best), { orderId: orderId, vehicleId: vehicleId }, live);
    shareDraft();
    render(false);
    var d = plans.best.km - before;
    toast('Перенесено в машину ' + vehicleId + '. Пробег ' + (d >= 0 ? '+' : '−') + num(Math.abs(d), 1) + ' км', plans.best.problems.length ? 'warn' : '');
    setStatus('правка логиста');
  }

  // ---------- форс-мажор: перестроение в течение дня ----------
  // Сам расчёт лежит в js/replan.js. Здесь только окно, где логист описывает, что случилось, и выбирает вариант.
  // Выбранный вариант становится черновиком; водители видят его после кнопки «Утвердить».
  var fm = null;                           // состояние окна, пока оно открыто
  var FM_TYPES = [['breakdown', 'Сломалась машина'], ['delay', 'Задержка в пути'], ['stop', 'Точка не принимает'], ['later', 'Просят другое время']];
  function nowMin() { var d = new Date(); return d.getHours() * 60 + d.getMinutes(); }

  function openIncident(pre) {
    if (!approved) { toast('Сначала утвердите план: перестраивать можно только маршруты, по которым машины уже едут.', 'warn'); return; }
    var base = window.MilkSolver.fromAssignment(input(), approved.assignment, null, liveOf(approved)), ids = [];
    base.routes.forEach(function (r) { if (r.seq.length && !r.broken) ids.push(r.vehicle.id); });
    if (!ids.length) { toast('Нет машин в рейсе: перестраивать нечего.', 'warn'); return; }
    pre = pre || {};
    // Этап 2: команда словами заранее заполняет окно (pre). Машина не в рейсе — молча брать другую нельзя.
    if (pre.vehicleId && ids.indexOf(pre.vehicleId) < 0) {
      var pv = vehicleById(pre.vehicleId);
      toast((pv ? pv.name : 'Машина ' + pre.vehicleId) + ' сейчас не в рейсе: перестраивать нечего.', 'warn'); return;
    }
    var open = selected >= 0 && plans.best.routes[selected] ? plans.best.routes[selected].vehicle.id : 0;
    var id = ids.indexOf(pre.vehicleId) >= 0 ? pre.vehicleId : (ids.indexOf(open) >= 0 ? open : ids[0]);
    fm = { type: pre.type || 'breakdown', vehicleId: id, delayMin: pre.delayMin || 40, orderId: pre.orderId || 0, action: pre.action || 'retry', laterAt: pre.laterAt || 0,
      base: base, marks: eventIndex().byStop, ids: ids, result: null, error: '', draftChanged: approvalState() === 'changed' };
    fm.at = pre.at != null ? pre.at : window.MilkReplan.suggestTime(base, id, fm.marks, nowMin());
    if (pre.orderId && (fm.type === 'stop' || fm.type === 'later') &&
        !window.MilkReplan.status(base, id, fm.at, fm.marks).remaining.some(function (x) { return x.orderId === pre.orderId; })) {
      var po = orderById(pre.orderId);
      fm.error = 'Точки «' + (po ? po.name : pre.orderId) + '» нет среди оставшихся у этой машины к ' + clock(fm.at) + '. Проверьте время и точку.';
    }
    renderIncident();
    $('fm-overlay').hidden = false;
  }
  function closeIncident() { $('fm-overlay').hidden = true; fm = null; }
  // Сообщение водителя о проблеме → заготовка происшествия.
  function incidentFromEvent(e) {
    var note = e.note || '', type = 'delay';
    if (note.indexOf('Поломка') === 0) type = 'breakdown';
    else if (e.orderId && /^(Магазин закрыт|Не принимают|Негде)/.test(note)) type = 'stop';
    return { type: type, vehicleId: e.vehicleId, orderId: e.orderId || 0 };
  }

  function stopOptions(info) {
    if (!info.remaining.some(function (x) { return x.orderId === fm.orderId; })) fm.orderId = info.remaining.length ? info.remaining[0].orderId : 0;
    if (!info.remaining.length) return '<option value="0">Точек впереди нет</option>';
    return info.remaining.map(function (x) {
      return '<option value="' + x.orderId + '"' + (x.orderId === fm.orderId ? ' selected' : '') + '>' + clock(x.at) + ' · ' + esc(x.title) + '</option>';
    }).join('');
  }
  function renderIncident() {
    if (!fm) return;
    var html = '';
    if (fm.result) {                       // шаг 2: варианты с объяснением
      var many = fm.result.variants.length > 1;
      html += '<p class="fm-lead">' + esc(fm.result.variants[0].title) + '. ' +
        (many ? 'Довезти всё без переработки не получается, поэтому вариантов несколько. Выбор за вами.' : 'Вот что предлагается.') + '</p><div class="variants">';
      fm.result.variants.forEach(function (v, n) {
        var s = v.stats, pills = '';
        pills += s.dropped ? '<span class="pill bad">не доставим ' + s.dropped + ' точ., ' + num(s.droppedKg) + ' кг</span>' : '<span class="pill good">довезём всё</span>';
        var more = s.overtime - s.overtimeWas;          // переработка могла быть ещё до этого происшествия: показываем, что добавилось
        if (s.overtime <= 0.5) pills += '<span class="pill good">без переработки</span>';
        else if (s.overtimeWas > 0.5) pills += more > 0.5 ? '<span class="pill warn">переработка +' + hours(more) + '</span>' : '<span class="pill good">переработка не растёт</span>';
        else pills += '<span class="pill warn">переработка ' + hours(s.overtime) + ' на ' + s.overtimeVehicles + ' вод.</span>';
        if (s.late.length) pills += '<span class="pill warn">опоздают ' + s.late.length + ' точ.</span>';
        html += '<article class="variant"><h3>' + esc(v.name) + '</h3><div class="route-flags">' + pills + '</div>' +
          '<button type="button" class="btn primary" data-pick="' + n + '">Показать на карте</button><ul>' +
          v.lines.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul></article>';
      });
      html += '</div><p class="fm-hint">Выбранный вариант станет черновиком: он виден на карте и в маршрутах, точки из сломанной машины можно вручную передать другой. ' +
        'Водители увидят новые маршруты только после кнопки «Утвердить».</p>' +
        '<div class="fm-actions"><button type="button" class="btn" id="fm-back">Назад</button><button type="button" class="btn" id="fm-cancel">Закрыть</button></div>';
      $('fm-body').innerHTML = html;
      return;
    }
    var info = window.MilkReplan.status(fm.base, fm.vehicleId, fm.at, fm.marks);   // шаг 1: что случилось
    html += '<div class="fm-row"><span>Что случилось</span><div class="seg">' + FM_TYPES.map(function (t) {
      return '<button type="button" data-type="' + t[0] + '"' + (fm.type === t[0] ? ' class="on"' : '') + '>' + t[1] + '</button>';
    }).join('') + '</div></div>';
    html += '<label class="fm-row" for="fm-vehicle"><span>Машина</span><select id="fm-vehicle">' + fm.ids.map(function (id) {
      var v = vehicleById(id);
      return '<option value="' + id + '"' + (id === fm.vehicleId ? ' selected' : '') + '>' + esc(v ? v.name : 'Машина ' + id) + '</option>';
    }).join('') + '</select></label>';
    html += '<label class="fm-row" for="fm-at"><span>Когда</span><input type="time" id="fm-at" value="' + clock(fm.at) + '"></label>';
    html += '<p class="fm-status" id="fm-status">' + esc(info.text) + '</p>';
    if (fm.type === 'delay') html += '<label class="fm-row" for="fm-delay"><span>На сколько минут</span><input type="number" id="fm-delay" min="5" step="5" value="' + fm.delayMin + '"></label>';
    if (fm.type === 'stop' || fm.type === 'later') html += '<label class="fm-row" for="fm-stop"><span>Какая точка</span><select id="fm-stop">' + stopOptions(info) + '</select></label>';
    if (fm.type === 'later') {             // этап 1Б: магазин просит привезти не раньше указанного времени
      if (!fm.laterAt) fm.laterAt = Math.ceil((fm.at + state.settings.retryMin) / 30) * 30;
      html += '<label class="fm-row" for="fm-later"><span>Привезти не раньше</span><input type="time" id="fm-later" value="' + clock(fm.laterAt) + '"></label>';
    }
    if (fm.type === 'stop') {
      html += '<div class="fm-row"><span>Что делаем</span><div class="seg">' +
        '<button type="button" data-action="retry"' + (fm.action === 'retry' ? ' class="on"' : '') + '>Вернуться через ' + state.settings.retryMin + ' мин</button>' +
        '<button type="button" data-action="drop"' + (fm.action === 'drop' ? ' class="on"' : '') + '>Не доставлять сегодня</button></div></div>';
    }
    if (fm.error) html += '<p class="fm-error">' + esc(fm.error) + '</p>';
    html += '<p class="fm-hint">Время здесь — по плану, а не по часам на стене: демо показывают днём, а маршруты утренние. ' +
      (fm.draftChanged ? 'Черновик отличается от утверждённого плана: перестроение считается от утверждённого, по нему едут водители. ' : '') +
      'Уже сделанное не меняется, каждая машина сначала заканчивает точку, которой занята.</p>';
    html += '<div class="fm-actions"><button type="button" class="btn" id="fm-cancel">Отмена</button>' +
      '<button type="button" class="btn primary" id="fm-go">Предложить перестроение</button></div>';
    $('fm-body').innerHTML = html;
  }
  // Поменяли время: обновляем только подсказку и список точек, чтобы поле не теряло фокус при вводе.
  function refreshIncident() {
    var info = window.MilkReplan.status(fm.base, fm.vehicleId, fm.at, fm.marks);
    $('fm-status').textContent = info.text;
    if ($('fm-stop')) $('fm-stop').innerHTML = stopOptions(info);
  }
  function readIncident() {               // на случай, если поле ещё в фокусе и его значение не успело записаться
    if ($('fm-at') && $('fm-at').value) fm.at = parseClock($('fm-at').value);
    if ($('fm-delay')) fm.delayMin = Math.max(1, +$('fm-delay').value || 0);
    if ($('fm-stop')) fm.orderId = +$('fm-stop').value;
    if ($('fm-later') && $('fm-later').value) fm.laterAt = parseClock($('fm-later').value);
  }
  function runIncident() {
    readIncident();
    var res = window.MilkReplan.propose(input(), fm.base, { type: fm.type, vehicleId: fm.vehicleId, at: fm.at, delayMin: fm.delayMin,
      orderId: fm.orderId, action: fm.action, retryAt: fm.laterAt }, fm.marks);
    if (res.ok) fm.result = res; else fm.error = res.message;
    renderIncident();
  }
  function pickVariant(n) {
    var v = fm.result.variants[n];
    clearTimeout(solveTimer); clearTimeout(fallbackTimer);
    plans.best = v.plan;
    shareDraft();
    closeIncident();
    selected = -1;
    if (view !== 'best') setView('best'); else render(true);
    setStatus('перестроение за ' + num(v.plan.ms / 1000, 2) + ' с');
    toast('Вариант «' + v.name + '» показан на карте. Проверьте и нажмите «Утвердить»: тогда его увидят водители.');
  }
  function cancelProposal() {
    if (!approved) return;
    draft = { assignment: clone(approved.assignment), live: clone(liveOf(approved)), at: new Date().toISOString() };
    plans.best = window.MilkSolver.fromAssignment(input(), draft.assignment, null, draft.live);
    shareDraft();
    render(true);
    toast('Предложение отменено: показан утверждённый план.');
  }
  function approvePlan() {
    if (!draft) return;
    approved = { assignment: clone(draft.assignment), live: clone(liveOf(draft)), at: new Date().toISOString() };
    Store.approve(approved.assignment, summaryOf(plans.best)); saveLocal(); render(false);
    var n = plans.best.problems.length;
    toast(n ? 'План утверждён с нарушениями (' + n + '). Водители видят свои маршруты.' : 'План утверждён. Водители видят свои маршруты.', n ? 'warn' : '');
  }

  // ---------- предложение «было → станет» и кнопки «а если» (этап 1Б) ----------
  // Расчёт и карточка — в js/proposal.js, формат изменений — в js/changes.js. Здесь только подключение к экрану.
  // Пока предложение открыто, таблицы слева закрыты для правки (подсказка в карточке и всплывающая строка):
  // иначе правка молча меняла бы данные, по которым предложение посчитано.
  var proposal = null;
  var assistant = null;                    // команда словами (js/assistant.js, этап 2): поле «Что изменилось?» и карточка «Я понял так»
  // Машина, которая везёт заказ по утверждённому плану: команда словами называет магазин, а окну «Форс-мажор» нужна машина.
  function vehicleOfOrder(oid) {
    if (!approved) return null;
    var p = window.MilkSolver.fromAssignment(input(), approved.assignment, null, liveOf(approved)), vid = null;
    p.routes.forEach(function (r) { r.seq.forEach(function (i) { p.stops[i].orders.forEach(function (o) { if (o.id === oid) vid = r.vehicle.id; }); }); });
    return vid;
  }
  function openProposal(list) {
    var opts = { solve: function (inp) { return notWorseThanBase(window.MilkFleet.solve(inp), inp); } };
    if (approved) { opts.base = window.MilkSolver.fromAssignment(input(), approved.assignment, null, liveOf(approved)); opts.marks = eventIndex().byStop; }
    setStatus('Считаю предложение…');
    proposal = window.MilkProposal.make({ input: input(), plan: plans.best, naive: plans.naive }, list, opts);
    if (view !== 'best') setView('best'); else render(true);
    setStatus(proposal.ok ? 'предложение посчитано за ' + num(proposal.ms / 1000, 1) + ' с, в общий план не попало' : 'предложение не построено');
  }
  function whatIfKey(key) {
    var sel = $('whatif-vehicle'), vid = sel && +sel.value ? +sel.value : window.MilkProposal.leastLoaded(plans.best);
    openProposal(window.MilkProposal.scenario(key, input(), vid));
  }
  function dropProposal(message) {
    if (!proposal) return;
    proposal = null; render(true);
    if (message) toast(message, 'warn');
  }
  function applyProposal() {
    var pr = proposal;
    if (!pr || !pr.ok) return dropProposal();
    proposal = null;
    clearTimeout(solveTimer); clearTimeout(fallbackTimer); remoteData = false;
    var before = state;
    state = { orders: pr.data.orders, vehicles: pr.data.vehicles, settings: pr.data.settings };
    plans.best = pr.plan; plans.naive = pr.naive; selected = -1;
    buildOrders(); buildSettings(); render(true);
    setStatus('сохраняю…');
    // Сначала данные, потом черновик: другие экраны получат план последним и покажут его, а не начнут считать сами.
    window.MilkProposal.save(Store, before, state).then(function () {
      shareDraft(); saveLocal(); setStatus('предложение применено');
      toast('Изменения применены: новый черновик виден на всех экранах. Водители увидят его после «Утвердить».');
    });
  }
  function renderProposal() {
    var day = !!approved || !!liveOf(draft);       // идущий день: с начала дня считать нельзя, кнопок «а если» нет
    $('whatif').innerHTML = day || proposal || !plans.best ? '' : window.MilkProposal.whatIf(plans.best, input());
    $('proposal').innerHTML = window.MilkProposal.card(proposal);
    $('map-flag').hidden = !(proposal && proposal.ok);
    if (assistant) assistant.refresh();      // примеры фраз зависят от того, идёт ли день
  }
  // Правка, пока открыто предложение: не принимаем, возвращаем таблицы как были и подсказываем, что делать.
  function busy() {
    if (!proposal) return false;
    toast('Открыто предложение: сначала нажмите «Применить» или «Отменить».', 'warn');
    buildOrders(); buildSettings(); render(false);
    return true;
  }

  // ---------- таблица заказов ----------
  function buildOrders() {
    var html = '';
    state.orders.forEach(function (o) {
      html += '<tr data-id="' + o.id + '" data-text="' + esc((o.name + ' ' + o.address).toLowerCase()) + '"' + (o.kg === 0 ? ' class="off"' : '') + '>' +
        '<td><button type="button" class="star" id="star-' + o.id + '" aria-pressed="' + !!o.timeExplicit + '" title="Важная точка: приехать в течение часа после указанного времени" aria-label="Важная точка">★</button></td>' +
        '<td class="who"><b>' + esc(o.name) + '</b><span>' + esc(o.address) + (o.approx ? ' · адрес найден примерно' : '') + '</span></td>' +
        '<td><input class="kg" id="kg-' + o.id + '" type="number" min="0" step="10" value="' + o.kg + '" aria-label="Килограммы"></td>' +
        '<td><input class="tm" id="tm-' + o.id + '" type="time" value="' + clock(o.from) + '" aria-label="Время выгрузки, не раньше"></td>' +
        '<td><span class="chip none" id="chip-' + o.id + '">–</span></td></tr>';
    });
    $('orders-table').tBodies[0].innerHTML = html;
    var q = $('order-search').value.trim().toLowerCase();
    if (q) filterOrders(q);
  }
  function updateOrderRow(o) {
    var kg = $('kg-' + o.id), tm = $('tm-' + o.id), star = $('star-' + o.id);
    if (!kg) return;
    if (document.activeElement !== kg) kg.value = o.kg;
    if (document.activeElement !== tm) tm.value = clock(o.from);
    star.setAttribute('aria-pressed', !!o.timeExplicit);
    kg.closest('tr').classList.toggle('off', o.kg === 0);
  }
  function filterOrders(q) {
    Array.prototype.forEach.call($('orders-table').tBodies[0].rows, function (tr) { tr.hidden = q && tr.getAttribute('data-text').indexOf(q) < 0; });
  }

  // ---------- правила ----------
  // Варианты для полей-списков: [значение, как написано на экране].
  var CHOICES = {
    fleetPriority: [['fewer', 'Меньше машин, загрузка не ниже 90%'], ['overtime', 'Без переработки, машин сколько нужно']]
  };
  var FIELDS = [
    ['fleetPriority', 'Что важнее, если всё сразу не сходится',
      'Пока логисты не ответили, сколько длится разгрузка, нужны оба ответа. «Меньше машин» — так работают логисты: число машин задаёт вес, переработка видна в «Что не сходится». «Без переработки» — как решатель считал раньше', 'select'],
    ['serviceMin', 'Разгрузка в обычной точке, мин', 'В среднем 30 минут, со слов логистов'],
    ['smallServiceMin', 'Разгрузка в мелкой точке, мин', 'Мелким точкам хватает 10 минут, со слов логистов'],
    ['smallStopKg', 'Мелкая точка — до, кг', 'Наше допущение: мелкой считаем точку с грузом до 100 кг'],
    ['shiftMin', 'Смена водителя, мин', '8 часов, загрузка входит, обед не входит'],
    ['loadMin', 'Загрузка на заводе, мин', 'Час, со слов логистов'],
    ['earliestDepart', 'Первый выезд', 'Первая машина выезжает в 5:00', 'time'],
    ['dayEnd', 'Последняя разгрузка не позже', 'Наше допущение: конец рабочего дня', 'time'],
    ['importantWindowMin', 'Окно для важных точек, мин', 'К точкам со звёздочкой приезжаем в течение этого времени'],
    ['minLoadPct', 'Минимальная загрузка, %', 'Жёсткое правило: иначе машина остаётся в гараже'],
    ['overtimeToleranceMin', 'Допуск по смене, мин', 'Переработку меньше этого не считаем нарушением. Наше допущение'],
    ['overloadTolerancePct', 'Допуск по загрузке, %', 'Тоннаж в заказах приблизительный. Наше допущение', 'step'],
    ['delayWeight', 'Важность приезда ко времени', '0 — важен только пробег; чем больше, тем раньше разгрузка', 'step'],
    ['trafficFactor', 'Запас на пробки, ×', 'Время в пути по дорогам умножается на это число. Наше допущение', 'step'],
    ['refKmPerRoute', 'Пробег маршрута сейчас, км', 'Со слов логистов, для сравнения'],
    ['transferMin', 'Перегрузка из сломанной машины, мин', 'Для перестроения в течение дня. Наше допущение'],
    ['retryMin', 'Вернуться к закрытой точке через, мин', 'Для перестроения в течение дня. Наше допущение'],
    ['replanOvertimeMin', 'Умеренная переработка — до, мин', 'Для среднего варианта перестроения. Наше допущение'],
    ['fillDownTimes', 'Запасное толкование: время из строки выше действует на точки ниже', 'Обычно выключено: по файлу заказчика время есть только у 10 важных точек (со звёздочкой), остальным можно в любое время смены', 'check']
  ];
  function buildSettings() {
    var html = '';
    FIELDS.forEach(function (f) {
      var key = f[0], v = state.settings[key], id = 'set-' + key;
      if (f[3] === 'select') {
        html += '<label class="choice" for="' + id + '"><span>' + f[1] + '</span><select id="' + id + '" data-key="' + key + '">' +
          CHOICES[key].map(function (c) { return '<option value="' + c[0] + '"' + (c[0] === v ? ' selected' : '') + '>' + c[1] + '</option>'; }).join('') +
          '</select><em>' + f[2] + '</em></label>';
      } else if (f[3] === 'check') html += '<label class="check" for="' + id + '"><input type="checkbox" id="' + id + '" data-key="' + key + '"' + (v ? ' checked' : '') + '><span>' + f[1] + '</span><em>' + f[2] + '</em></label>';
      else if (f[3] === 'time') html += '<label for="' + id + '"><span>' + f[1] + '</span><input type="time" id="' + id + '" data-key="' + key + '" value="' + clock(v) + '"><em>' + f[2] + '</em></label>';
      else html += '<label for="' + id + '"><span>' + f[1] + '</span><input type="number" id="' + id + '" data-key="' + key + '" min="0" step="' + (f[3] === 'step' ? '0.01' : '1') + '" value="' + v + '"><em>' + f[2] + '</em></label>';
    });
    $('settings-form').innerHTML = html;
  }

  // ---------- изменения с других экранов ----------
  // Изменения копятся долю секунды и применяются разом: при сбросе демо их приходят сотни.
  function queueRemote(dataChanged) {
    if (dataChanged) remoteData = true;
    if (dataChanged && proposal) dropProposal('Данные изменились на другом экране: предложение закрыто, откройте его заново.');
    clearTimeout(remoteTimer);
    remoteTimer = setTimeout(applyRemote, 400);
  }
  function applyRemote() {
    if (remoteStructure) { buildOrders(); remoteStructure = false; }
    if (!remoteData) { render(false); return; }
    remoteData = false;
    if (draft) showDraft('изменено на другом экране, жду новый план…');
    // Если тот экран не пришлёт план за 8 секунд, считаем сами.
    clearTimeout(fallbackTimer);
    fallbackTimer = setTimeout(recalc, 8000);
  }
  var remote = {
    order: function (row, oldId) {
      if (!row) { state.orders = state.orders.filter(function (o) { return o.id !== oldId; }); remoteStructure = true; return queueRemote(true); }
      var o = orderById(row.id);
      if (!o) {
        state.orders.push(row); state.orders.sort(function (a, b) { return a.id - b.id; });
        remoteStructure = true; return queueRemote(true);
      }
      if (o.kg === row.kg && o.from === row.from && !!o.timeExplicit === !!row.timeExplicit) return;   // своё же эхо
      o.kg = row.kg; o.from = row.from; o.timeExplicit = row.timeExplicit;
      updateOrderRow(o); queueRemote(true);
    },
    vehicle: function (row, oldId) {
      if (!row) { state.vehicles = state.vehicles.filter(function (v) { return v.id !== oldId; }); return queueRemote(true); }
      var v = vehicleById(row.id);
      if (!v) { state.vehicles.push(row); state.vehicles.sort(function (a, b) { return a.id - b.id; }); return queueRemote(true); }
      if (v.cap === row.cap && (v.active !== false) === (row.active !== false) && v.name === row.name) return;
      v.cap = row.cap; v.active = row.active; v.name = row.name;
      queueRemote(true);
    },
    settings: function (data) {
      var merged = Object.assign(clone(DEFAULTS), data || {});
      if (JSON.stringify(merged) === JSON.stringify(state.settings)) return;
      state.settings = merged; buildSettings(); queueRemote(true);
    },
    plan: function (kind, plan) {
      // При сбросе демо планы удаляются, и весть об этом иногда приходит с опозданием.
      // Если план здесь только что создан или утверждён (он новее сброса), запоздалое удаление его не стирает.
      var mine = kind === 'draft' ? draft : approved;
      if (!plan && mine && mine.at && Date.now() - new Date(mine.at).getTime() < 20000) return;
      if (kind === 'draft') {
        draft = plan;
        if (!plan) return;
        if (proposal) dropProposal('План изменился на другом экране: предложение закрыто, откройте его заново.');
        clearTimeout(fallbackTimer); clearTimeout(remoteTimer); remoteData = false;
        if (remoteStructure) { buildOrders(); remoteStructure = false; }
        showDraft(plan.author === 'base' ? 'демо сброшено: эталонный план' : 'план обновлён на другом экране');   // 'base' — черновик из reset_demo()
      } else if (kind === 'approved') {
        approved = plan; render(false);
        if (plan) toast('План утверждён на другом экране в ' + clockOf(plan.at));
      }
    },
    event: function (ev) {
      if (!ev) { events = []; return queueRemote(false); }
      for (var i = 0; i < events.length; i++) if (events[i].id === ev.id) return;
      events.push(ev);
      toast(eventText(ev), ev.kind === 'problem' ? 'bad' : '');
      queueRemote(false);
    },
    status: function (s) {
      if (s === 'SUBSCRIBED') setConn('Онлайн', 'good');
      else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT' || s === 'CLOSED') setConn('Нет связи с сервером', 'bad');
    }
  };

  // ---------- QR-код для водителя ----------
  function openQr() {
    var url = new URL('driver.html', location.href).href, box = $('qr-code');
    if (window.qrcode) {
      var qr = window.qrcode(0, 'M'); qr.addData(url); qr.make();
      box.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
    } else box.textContent = 'Не удалось загрузить генератор QR-кода.';
    $('qr-link').href = url; $('qr-link').textContent = url;
    $('qr-note').textContent = location.protocol === 'file:' ? 'Сейчас страница открыта с диска, поэтому телефон её не откроет. QR заработает, когда сайт выложен в интернет.' :
      'Наведите камеру телефона, выберите машину и отмечайте этапы доставки. Диспетчер увидит их сразу.';
    $('qr-overlay').hidden = false; $('qr-close').focus();
  }

  // ---------- события на странице ----------
  function bind() {
    $('orders-table').addEventListener('change', function (e) {
      if (busy()) return;
      var tr = e.target.closest('tr'), o = tr && orderById(+tr.getAttribute('data-id'));
      if (!o) return;
      if (e.target.classList.contains('kg')) { o.kg = Math.max(0, +e.target.value || 0); tr.classList.toggle('off', o.kg === 0); }
      if (e.target.classList.contains('tm')) o.from = parseClock(e.target.value);
      Store.saveOrder(o); saveLocal(); schedule();
    });
    $('orders-table').addEventListener('click', function (e) {
      if (!e.target.classList.contains('star') || busy()) return;
      var o = orderById(+e.target.closest('tr').getAttribute('data-id'));
      o.timeExplicit = !o.timeExplicit; e.target.setAttribute('aria-pressed', o.timeExplicit);
      Store.saveOrder(o); saveLocal(); schedule();
    });
    $('order-search').addEventListener('input', function (e) { filterOrders(e.target.value.trim().toLowerCase()); });
    $('vehicles-table').addEventListener('change', function (e) {
      if (busy()) return;
      var v = vehicleById(+e.target.getAttribute('data-id'));
      if (!v) return;
      if (e.target.classList.contains('veh-on')) v.active = e.target.checked;
      if (e.target.classList.contains('veh-cap')) v.cap = Math.max(0, +e.target.value || 0);
      Store.saveVehicle(v); saveLocal(); schedule();
    });
    $('btn-add-vehicle').addEventListener('click', function () {
      if (busy()) return;
      var id = state.vehicles.reduce(function (m, v) { return Math.max(m, v.id); }, 0) + 1;
      var v = { id: id, name: 'Машина ' + id + ' · 4 т', cap: 4000, active: true };
      state.vehicles.push(v); Store.saveVehicle(v); saveLocal(); schedule();
    });
    $('settings-form').addEventListener('change', function (e) {
      var key = e.target.getAttribute('data-key');
      if (!key || busy()) return;
      if (e.target.type === 'checkbox') state.settings[key] = e.target.checked;
      else if (CHOICES[key]) {                    // список: берём только известное значение, иначе — по умолчанию
        var ok = CHOICES[key].some(function (c) { return c[0] === e.target.value; });
        state.settings[key] = ok ? e.target.value : DEFAULTS[key];
      } else if (e.target.type === 'time') state.settings[key] = parseClock(e.target.value);
      else state.settings[key] = Math.max(0, +e.target.value || 0);
      Store.saveSettings(state.settings); saveLocal(); schedule();
    });
    $('settings-form').addEventListener('submit', function (e) { e.preventDefault(); });
    $('routes').addEventListener('click', function (e) {
      var head = e.target.closest('.route-head');
      if (head) pick(+head.getAttribute('data-k'));
    });
    $('routes').addEventListener('change', function (e) {
      if (!e.target.classList.contains('move') || !e.target.value) return;
      moveStop(+e.target.getAttribute('data-oid'), +e.target.value);
    });
    document.querySelectorAll('.tabs button').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('.tabs button').forEach(function (x) { x.classList.toggle('on', x === b); });
        ['orders', 'vehicles', 'settings'].forEach(function (t) { $('tab-' + t).hidden = t !== b.getAttribute('data-tab'); });
      });
    });
    $('view-best').addEventListener('click', function () { setView('best'); });
    $('view-naive').addEventListener('click', function () { if (!busy()) setView('naive'); });
    // «Пересчитать» всегда строит план с нуля, с начала дня. Если день уже перестраивали, предупреждаем.
    $('btn-recalc').addEventListener('click', function () {
      if (busy()) return;
      var wasLive = !!liveOf(draft);
      setStatus('Считаю…');
      setTimeout(function () {
        solveAndShare();
        if (wasLive) toast('План построен заново, с начала дня: перестроение из черновика убрано.', 'warn');
      }, 30);
    });
    $('btn-approve').addEventListener('click', function () { if (!busy()) approvePlan(); });
    $('btn-incident').addEventListener('click', function () { if (!busy()) openIncident(); });
    $('whatif').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (b && b.hasAttribute('data-whatif')) whatIfKey(b.getAttribute('data-whatif'));
    });
    $('proposal').addEventListener('click', function (e) {
      if (e.target.id === 'prop-apply') applyProposal();
      if (e.target.id === 'prop-cancel') { dropProposal(); toast('Предложение отменено: показан прежний план, в базе ничего не менялось.'); }
    });
    $('incident').addEventListener('click', function (e) {
      if (e.target.id === 'inc-approve') approvePlan();
      if (e.target.id === 'inc-cancel') cancelProposal();
    });
    $('feed').addEventListener('click', function (e) {
      var id = e.target.getAttribute('data-event');
      if (!id) return;
      for (var i = 0; i < events.length; i++) if (String(events[i].id) === id) return openIncident(incidentFromEvent(events[i]));
    });
    $('fm-body').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b || !fm) return;
      if (b.id === 'fm-cancel') return closeIncident();
      if (b.id === 'fm-back') { fm.result = null; return renderIncident(); }
      if (b.id === 'fm-go') return runIncident();
      if (b.hasAttribute('data-pick')) return pickVariant(+b.getAttribute('data-pick'));
      readIncident();
      if (b.hasAttribute('data-type')) fm.type = b.getAttribute('data-type');
      if (b.hasAttribute('data-action')) fm.action = b.getAttribute('data-action');
      fm.error = ''; renderIncident();
    });
    $('fm-body').addEventListener('change', function (e) {
      if (!fm) return;
      if (e.target.id === 'fm-vehicle') {
        fm.vehicleId = +e.target.value; fm.orderId = 0; fm.error = '';
        fm.at = window.MilkReplan.suggestTime(fm.base, fm.vehicleId, fm.marks, nowMin());
        return renderIncident();
      }
      readIncident(); refreshIncident();
    });
    $('fm-overlay').addEventListener('click', function (e) { if (e.target === $('fm-overlay')) closeIncident(); });
    $('btn-qr').addEventListener('click', openQr);
    $('qr-close').addEventListener('click', function () { $('qr-overlay').hidden = true; });
    $('qr-overlay').addEventListener('click', function (e) { if (e.target === $('qr-overlay')) $('qr-overlay').hidden = true; });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { $('qr-overlay').hidden = true; if (fm) closeIncident(); } });
    $('btn-reset').addEventListener('click', resetDemo);
    // Команда словами: режим (до утверждения или день идёт) определяет программа, а не логист (решение 5).
    assistant = window.MilkAssistant.mount('assistant', {
      data: input, live: function () { return !!approved || !!liveOf(draft); }, busy: busy, toast: toast,
      openProposal: openProposal, openIncident: function (pre) { if (!busy()) openIncident(pre); }, vehicleOfOrder: vehicleOfOrder
    });
  }
  function setView(v) {
    view = v; selected = -1;
    $('view-best').classList.toggle('on', v === 'best'); $('view-naive').classList.toggle('on', v === 'naive');
    render(true);
  }

  function resetDemo() {
    proposal = null;
    setStatus('Сбрасываю…');
    // После сброса показываем эталонный план и не пересчитываем: на любом экране числа одинаковые.
    if (!Store.isOnline()) {
      state = fresh(); draft = baseDraft(); approved = null; events = [];
      buildOrders(); buildSettings(); $('order-search').value = '';
      if (draft) { showDraft('демо сброшено: эталонный план'); saveLocal(); } else solveAndShare();
      return;
    }
    Store.reset().then(function () { return Store.load(); }).then(function (data) {
      if (!data) return;
      state = { orders: data.orders, vehicles: data.vehicles, settings: Object.assign(clone(DEFAULTS), data.settings || {}) };
      draft = data.draft; approved = null; events = data.events; roads = data.roads || roads;
      clearTimeout(remoteTimer); clearTimeout(fallbackTimer); remoteData = false; remoteStructure = false;
      buildOrders(); buildSettings(); $('order-search').value = ''; filterOrders('');
      if (draft) showDraft('демо сброшено: эталонный план'); else solveAndShare();   // эталона в базе нет — считаем
      toast('Демо сброшено: исходные заказы и машины, эталонный план, не утверждён');
    });
  }

  // ---------- запуск ----------
  var mapReady = window.MilkMap.init($('map'), DATA.depot, pick);
  setConn('Подключаюсь…', '');
  Store.onError = function () { setConn('Не удалось сохранить', 'bad'); };
  Store.load().then(function (data) {
    if (data && data.orders.length) {
      state = { orders: data.orders, vehicles: data.vehicles, settings: Object.assign(clone(DEFAULTS), data.settings || {}) };
      draft = data.draft; approved = data.approved; events = data.events; roads = data.roads || roadsFromFile();
      setConn('Онлайн', 'good');
    } else {
      state = loadLocal(); roads = roadsFromFile();
      if (!draft) draft = baseDraft();          // первый запуск без базы: показываем эталонный план
      setConn('Без сервера: правки видны только здесь', 'warn');
    }
    buildOrders(); buildSettings(); bind();
    // Черновик показываем как есть; если он был посчитан по прямой, а таблица дорог есть — считаем заново.
    var stale = draft && draft.summary && draft.summary.byRoad === false && roads;
    if (draft && !stale) showDraft(draft.summary && draft.summary.base ? 'эталонный план' : (Store.isOnline() ? 'план загружен из базы' : 'показан сохранённый план')); else solveAndShare();
    Store.subscribe(remote);
    mapReady.then(function () { render(true); });
  });
})();
