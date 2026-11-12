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
  var view = 'best', selected = -1, roadKm = {};
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
  function input() { return { depot: DATA.depot, orders: state.orders, vehicles: state.vehicles, settings: state.settings }; }
  function colorOf(vehicleId) {
    for (var i = 0; i < state.vehicles.length; i++) if (state.vehicles[i].id === vehicleId) return COLORS[i % COLORS.length];
    return '#888';
  }

  // ---------- работа без сервера (запасной режим) ----------
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
  function summaryOf(p) { return { km: Math.round(p.km), used: p.used, problems: p.problems.length }; }

  // Считаем новый план здесь и делимся им со всеми экранами.
  function solveAndShare() {
    clearTimeout(solveTimer); clearTimeout(fallbackTimer); remoteData = false;
    plans.best = window.MilkSolver.solve(input());
    plans.naive = window.MilkSolver.naive(input());
    draft = { assignment: window.MilkSolver.toAssignment(plans.best), at: new Date().toISOString() };
    Store.saveDraft(draft.assignment, summaryOf(plans.best));
    saveLocal();
    selected = -1; roadKm = {};
    render(true);
    setStatus('расчёт за ' + num(plans.best.ms / 1000, 1) + ' с');
  }
  function schedule() { clearTimeout(solveTimer); setStatus('Считаю…'); solveTimer = setTimeout(solveAndShare, 350); }

  // Показываем общий черновик как есть, без нового расчёта (так все экраны видят один и тот же план).
  function showDraft(message) {
    plans.best = window.MilkSolver.fromAssignment(input(), draft.assignment);
    plans.naive = window.MilkSolver.naive(input());
    if (selected >= plans.best.routes.length) selected = -1;
    roadKm = {};
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
    var p = plans[view];
    if (!p) return;
    var idx = eventIndex();
    renderMeta(); renderApproval(); renderKpis(p); renderFeed(); renderProblems(p); renderRoutes(p, idx); renderChips(p); renderVehicles(p); renderMap(p, fit, idx);
  }

  function renderMeta() {
    var kg = 0, n = 0;
    state.orders.forEach(function (o) { if (o.kg > 0) { kg += o.kg; n++; } });
    $('meta').textContent = 'План доставки по Гродно · ' + plural(n, 'заказ', 'заказа', 'заказов') + ' · ' +
      plural(plans.best.stopsTotal, 'остановка', 'остановки', 'остановок') + ' · ' + num(kg / 1000, 1) + ' т';
  }

  function approvalState() {
    if (!approved) return 'none';
    return draft && JSON.stringify(approved.assignment) === JSON.stringify(draft.assignment) ? 'same' : 'changed';
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
  function renderKpis(p) {
    var st = state.settings, active = state.vehicles.filter(function (v) { return v.active !== false; }).length;
    var refKm = st.refKmPerRoute * plans.naive.used, diff = refKm ? (p.km - refKm) / refKm * 100 : 0;
    var longest = 0, loadSum = 0;
    p.routes.forEach(function (r) { if (r.seq.length) { longest = Math.max(longest, st.loadMin + r.back - r.depart); loadSum += r.loadPct; } });
    var bad = p.problems.length > 0, html = '';
    html += tile('Пробег за день', num(p.km), 'км',
      '<span class="pill ' + (diff <= 0 ? 'good' : 'bad') + '">' + (diff <= 0 ? '−' : '+') + num(Math.abs(diff)) + '%</span>',
      'Сейчас около ' + num(refKm) + ' км: ' + st.refKmPerRoute + ' км × ' + plans.naive.used + ' маршрутов, со слов логистов');
    html += tile('Машин на линии', p.used, 'из ' + active,
      p.used < active ? '<span class="pill good">' + (active - p.used) + ' в гараже</span>' : '',
      'Средняя загрузка ' + num(p.used ? loadSum / p.used : 0) + '%, правило: не ниже ' + st.minLoadPct + '%');
    html += tile('Самая длинная смена', hours(longest), '',
      '<span class="pill ' + (longest <= st.shiftMin + 0.5 ? 'good' : 'bad') + '">' + (longest <= st.shiftMin + 0.5 ? 'в норме' : 'переработка') + '</span>',
      'Норма ' + hours(st.shiftMin) + ' с загрузкой. Всего в рейсах ' + num(p.workMin / 60) + ' ч, последняя машина вернётся в ' + clock(p.lastBack));
    html += tile('Нарушения правил', p.problems.length, '',
      '<span class="pill ' + (bad ? 'bad' : 'good') + '">' + (bad ? 'нужно внимание' : 'план выполним') + '</span>',
      'Опозданий: ' + p.lateStops + ' · переработка: ' + num(p.overtimeMin) + ' мин · перегруз: ' + num(p.overloadKg) + ' кг');
    $('kpis').innerHTML = html;
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
      html += '<li class="' + (e.kind === 'problem' ? 'bad' : '') + '"><b>' + clockOf(e.at) + '</b> ' + esc(eventText(e)) + '</li>';
    });
    $('feed').innerHTML = html + '</ul>';
  }

  function renderProblems(p) {
    if (!p.problems.length) { $('problems').innerHTML = '<div class="problems ok">Все правила соблюдены</div>'; return; }
    var items = p.problems.slice(0, 6).map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('');
    if (p.problems.length > 6) items += '<li>и ещё ' + (p.problems.length - 6) + '</li>';
    $('problems').innerHTML = '<div class="problems has"><b>Что не сходится</b><ul>' + items + '</ul></div>';
  }

  function stopTitle(s) { return s.orders.map(function (o) { return o.name; }).join(' + '); }
  var STOP_MARK = { arrived: '●', unloading: '▶', done: '✓' };

  function renderRoutes(p, idx) {
    var html = '', garage = [], active = state.vehicles.filter(function (v) { return v.active !== false; });
    p.routes.forEach(function (r, k) {
      if (!r.seq.length) { garage.push(r.vehicle.name); return; }
      var c = colorOf(r.vehicle.id), sel = k === selected, flags = '', last = idx.lastByVehicle[r.vehicle.id];
      var barClass = r.overload > 0.5 ? 'bad' : (r.loadPct < state.settings.minLoadPct ? 'warn' : '');
      if (r.overload > 0.5) flags += '<span class="pill bad">перегруз ' + num(r.overload) + ' кг</span>';
      if (r.overtime > 0.5) flags += '<span class="pill bad">переработка ' + num(r.overtime) + ' мин</span>';
      if (r.late > 0.5) flags += '<span class="pill bad">опоздание</span>';
      if (r.center > 0) flags += '<span class="pill bad">большая машина в центре</span>';
      if (r.loadPct < state.settings.minLoadPct) flags += '<span class="pill warn">недогруз</span>';
      var done = 0;
      r.seq.forEach(function (si) { if (idx.byStop[r.vehicle.id + ':' + p.stops[si].orders[0].id] === 'done') done++; });
      var km = roadKm[k] ? num(roadKm[k], 1) + ' км по дорогам' : num(r.km, 1) + ' км';
      html += '<div class="route' + (sel ? ' sel' : '') + '" style="--c:' + c + '">' +
        '<button type="button" class="route-head" data-k="' + k + '" aria-expanded="' + sel + '">' +
        '<span class="route-title"><span>' + esc(r.vehicle.name) + '</span><span>' + num(r.load) + ' / ' + num(r.vehicle.cap) + ' кг</span></span>' +
        '<span class="bar ' + barClass + '"><i style="width:' + Math.min(100, r.loadPct).toFixed(0) + '%"></i></span>' +
        '<span class="route-meta">' + r.seq.length + ' точ. · ' + km + ' · ' + clock(r.depart) + '–' + clock(r.back) + ' · загрузка ' + num(r.loadPct) + '%</span>' +
        (last ? '<span class="route-now' + (last.kind === 'problem' ? ' bad' : '') + '">' + clockOf(last.at) + ' · ' + esc(KIND[last.kind]) +
          (last.note ? ': ' + esc(last.note) : '') + (done ? ' · разгружено ' + done + ' из ' + r.seq.length : '') + '</span>' : '') +
        (flags ? '<span class="route-flags">' + flags + '</span>' : '') + '</button>';
      if (sel) {
        html += '<ol>';
        r.stops.forEach(function (x) {
          var s = p.stops[x.stop], oid = s.orders[0].id, st = idx.byStop[r.vehicle.id + ':' + oid];
          var move = '';
          if (view === 'best') {
            move = '<select class="move" data-oid="' + oid + '" aria-label="Перенести в другую машину"><option value="">Перенести…</option>';
            active.forEach(function (v) { if (v.id !== r.vehicle.id) move += '<option value="' + v.id + '">' + esc(v.name) + '</option>'; });
            move += '</select>';
          }
          html += '<li class="' + (x.late > 0.5 ? 'late ' : '') + (st ? 'st-' + st : '') + '"><b>' + (st ? STOP_MARK[st] + ' ' : '') + clock(x.start) + '</b> ' +
            (s.important ? '★ ' : '') + esc(stopTitle(s)) +
            '<br><span>' + esc(s.address) + ' · ' + num(s.kg) + ' кг' + (x.late > 0.5 ? ' · опоздание ' + num(x.late) + ' мин' : '') + '</span>' + move + '</li>';
        });
        html += '</ol>';
      }
      html += '</div>';
    });
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
    var routes = [];
    p.routes.forEach(function (r, k) {
      if (!r.seq.length) return;
      routes.push({ k: k, color: colorOf(r.vehicle.id), name: r.vehicle.name, road: r.road || null,
        points: r.stops.map(function (x, i) {
          var s = p.stops[x.stop], title = stopTitle(s), st = idx.byStop[r.vehicle.id + ':' + s.orders[0].id];
          return { lat: s.lat, lon: s.lon, n: i + 1, color: st === 'done' ? '#9aa8b5' : null,
            title: esc(clock(x.start) + ' ' + title + ', ' + num(s.kg) + ' кг'),
            html: '<b>' + esc(title) + '</b><br>' + esc(s.address) + '<br>' + esc(r.vehicle.name) + ', остановка ' + (i + 1) +
              '<br>Разгрузка с ' + clock(x.start) + ', ' + num(s.kg) + ' кг' + (st ? '<br>Статус: ' + esc(KIND[st].toLowerCase()) : '') };
        }) });
    });
    window.MilkMap.draw({ depot: DATA.depot, selected: selected, routes: routes }, fit);
    var note = 'Расстояния оценены по прямой с поправкой ×' + String(state.settings.detour).replace('.', ',') + '. Выберите маршрут, чтобы увидеть его по дорогам.';
    if (window.MilkMap.mode() === 'svg') note = 'Карта-подложка недоступна, показана схема. ' + note;
    $('map-note').textContent = note;
  }

  // Клик по маршруту: раскрываем список точек и подгружаем настоящую линию по дорогам.
  function pick(k) {
    selected = selected === k ? -1 : k;
    render(false);
    if (selected < 0) return;
    var p = plans[view], r = p.routes[k];
    if (!r || r.road) return;
    var pts = r.stops.map(function (x) { return p.stops[x.stop]; });
    window.MilkMap.roadRoute(DATA.depot, pts).then(function (res) {
      if (!res || plans[view] !== p) return;
      r.road = res.coords; roadKm[k] = res.km;
      if (selected === k) render(false);
    });
  }

  // Логист переносит остановку в другую машину. Остальное не трогаем, только пересчитываем время.
  function moveStop(orderId, vehicleId) {
    var before = plans.best.km;
    plans.best = window.MilkSolver.fromAssignment(input(), window.MilkSolver.toAssignment(plans.best), { orderId: orderId, vehicleId: vehicleId });
    draft = { assignment: window.MilkSolver.toAssignment(plans.best), at: new Date().toISOString() };
    Store.saveDraft(draft.assignment, summaryOf(plans.best));
    saveLocal(); roadKm = {};
    render(false);
    var v = vehicleById(vehicleId), d = plans.best.km - before;
    toast('Перенесено в машину ' + v.id + '. Пробег ' + (d >= 0 ? '+' : '−') + num(Math.abs(d), 1) + ' км', plans.best.problems.length ? 'warn' : '');
    setStatus('правка логиста');
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
  var FIELDS = [
    ['serviceMin', 'Разгрузка в обычной точке, мин', 'В среднем 30 минут, со слов логистов'],
    ['smallServiceMin', 'Разгрузка в мелкой точке, мин', 'Мелким точкам хватает 10 минут, со слов логистов'],
    ['smallStopKg', 'Мелкая точка — до, кг', 'Наше допущение: мелкой считаем точку с грузом до 100 кг'],
    ['shiftMin', 'Смена водителя, мин', '8 часов, загрузка входит, обед не входит'],
    ['loadMin', 'Загрузка на заводе, мин', 'Час, со слов логистов'],
    ['earliestDepart', 'Первый выезд', 'Первая машина выезжает в 5:00', 'time'],
    ['dayEnd', 'Последняя разгрузка не позже', 'Наше допущение: конец рабочего дня', 'time'],
    ['importantWindowMin', 'Окно для важных точек, мин', 'К точкам со звёздочкой приезжаем в течение этого времени'],
    ['minLoadPct', 'Минимальная загрузка, %', 'Жёсткое правило: иначе машина остаётся в гараже'],
    ['delayWeight', 'Важность приезда ко времени', '0 — важен только пробег; чем больше, тем раньше разгрузка', 'step'],
    ['speedKmh', 'Средняя скорость, км/ч', 'Наше допущение для города'],
    ['detour', 'Поправка «дорога длиннее прямой»', 'Сверено с реальными дорогами на нескольких маршрутах', 'step'],
    ['refKmPerRoute', 'Пробег маршрута сейчас, км', 'Со слов логистов, для сравнения'],
    ['fillDownTimes', 'Время в таблице действует на все точки ниже', 'Если выключить, время учитывается только у точек со звёздочкой', 'check']
  ];
  function buildSettings() {
    var html = '';
    FIELDS.forEach(function (f) {
      var key = f[0], v = state.settings[key], id = 'set-' + key;
      if (f[3] === 'check') html += '<label class="check" for="' + id + '"><input type="checkbox" id="' + id + '" data-key="' + key + '"' + (v ? ' checked' : '') + '><span>' + f[1] + '</span><em>' + f[2] + '</em></label>';
      else if (f[3] === 'time') html += '<label for="' + id + '"><span>' + f[1] + '</span><input type="time" id="' + id + '" data-key="' + key + '" value="' + clock(v) + '"><em>' + f[2] + '</em></label>';
      else html += '<label for="' + id + '"><span>' + f[1] + '</span><input type="number" id="' + id + '" data-key="' + key + '" min="0" step="' + (f[3] === 'step' ? '0.01' : '1') + '" value="' + v + '"><em>' + f[2] + '</em></label>';
    });
    $('settings-form').innerHTML = html;
  }

  // ---------- изменения с других экранов ----------
  // Изменения копятся долю секунды и применяются разом: при сбросе демо их приходят сотни.
  function queueRemote(dataChanged) {
    if (dataChanged) remoteData = true;
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
    fallbackTimer = setTimeout(solveAndShare, 8000);
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
      if (kind === 'draft') {
        draft = plan;
        if (!plan) return;
        clearTimeout(fallbackTimer); clearTimeout(remoteTimer); remoteData = false;
        if (remoteStructure) { buildOrders(); remoteStructure = false; }
        showDraft('план обновлён на другом экране');
      } else if (kind === 'approved') {
        approved = plan; renderApproval();
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
      var tr = e.target.closest('tr'), o = tr && orderById(+tr.getAttribute('data-id'));
      if (!o) return;
      if (e.target.classList.contains('kg')) { o.kg = Math.max(0, +e.target.value || 0); tr.classList.toggle('off', o.kg === 0); }
      if (e.target.classList.contains('tm')) o.from = parseClock(e.target.value);
      Store.saveOrder(o); saveLocal(); schedule();
    });
    $('orders-table').addEventListener('click', function (e) {
      if (!e.target.classList.contains('star')) return;
      var o = orderById(+e.target.closest('tr').getAttribute('data-id'));
      o.timeExplicit = !o.timeExplicit; e.target.setAttribute('aria-pressed', o.timeExplicit);
      Store.saveOrder(o); saveLocal(); schedule();
    });
    $('order-search').addEventListener('input', function (e) { filterOrders(e.target.value.trim().toLowerCase()); });
    $('vehicles-table').addEventListener('change', function (e) {
      var v = vehicleById(+e.target.getAttribute('data-id'));
      if (!v) return;
      if (e.target.classList.contains('veh-on')) v.active = e.target.checked;
      if (e.target.classList.contains('veh-cap')) v.cap = Math.max(0, +e.target.value || 0);
      Store.saveVehicle(v); saveLocal(); schedule();
    });
    $('btn-add-vehicle').addEventListener('click', function () {
      var id = state.vehicles.reduce(function (m, v) { return Math.max(m, v.id); }, 0) + 1;
      var v = { id: id, name: 'Машина ' + id + ' · 4 т', cap: 4000, active: true };
      state.vehicles.push(v); Store.saveVehicle(v); saveLocal(); schedule();
    });
    $('settings-form').addEventListener('change', function (e) {
      var key = e.target.getAttribute('data-key');
      if (!key) return;
      if (e.target.type === 'checkbox') state.settings[key] = e.target.checked;
      else if (e.target.type === 'time') state.settings[key] = parseClock(e.target.value);
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
    $('view-naive').addEventListener('click', function () { setView('naive'); });
    $('btn-recalc').addEventListener('click', function () { setStatus('Считаю…'); setTimeout(solveAndShare, 30); });
    $('btn-approve').addEventListener('click', function () {
      if (!draft) return;
      approved = { assignment: clone(draft.assignment), at: new Date().toISOString() };
      Store.approve(approved.assignment, summaryOf(plans.best)); saveLocal(); renderApproval();
      var n = plans.best.problems.length;
      toast(n ? 'План утверждён с нарушениями (' + n + '). Водители видят свои маршруты.' : 'План утверждён. Водители видят свои маршруты.', n ? 'warn' : '');
    });
    $('btn-qr').addEventListener('click', openQr);
    $('qr-close').addEventListener('click', function () { $('qr-overlay').hidden = true; });
    $('qr-overlay').addEventListener('click', function (e) { if (e.target === $('qr-overlay')) $('qr-overlay').hidden = true; });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') $('qr-overlay').hidden = true; });
    $('btn-reset').addEventListener('click', resetDemo);
  }
  function setView(v) {
    view = v; selected = -1; roadKm = {};
    $('view-best').classList.toggle('on', v === 'best'); $('view-naive').classList.toggle('on', v === 'naive');
    render(true);
  }

  function resetDemo() {
    setStatus('Сбрасываю…');
    if (!Store.isOnline()) {
      state = fresh(); draft = null; approved = null; events = [];
      buildOrders(); buildSettings(); $('order-search').value = ''; solveAndShare();
      return;
    }
    Store.reset().then(function () { return Store.load(); }).then(function (data) {
      if (!data) return;
      state = { orders: data.orders, vehicles: data.vehicles, settings: Object.assign(clone(DEFAULTS), data.settings || {}) };
      draft = null; approved = null; events = data.events;
      clearTimeout(remoteTimer); remoteData = false; remoteStructure = false;
      buildOrders(); buildSettings(); $('order-search').value = ''; filterOrders('');
      solveAndShare();
      toast('Демо сброшено: исходные заказы и машины, план не утверждён');
    });
  }

  // ---------- запуск ----------
  var mapReady = window.MilkMap.init($('map'), DATA.depot, pick);
  setConn('Подключаюсь…', '');
  Store.onError = function () { setConn('Не удалось сохранить', 'bad'); };
  Store.load().then(function (data) {
    if (data && data.orders.length) {
      state = { orders: data.orders, vehicles: data.vehicles, settings: Object.assign(clone(DEFAULTS), data.settings || {}) };
      draft = data.draft; approved = data.approved; events = data.events;
      setConn('Онлайн', 'good');
    } else {
      state = loadLocal();
      setConn('Без сервера: правки видны только здесь', 'warn');
    }
    buildOrders(); buildSettings(); bind();
    if (draft) showDraft('план загружен из базы'); else solveAndShare();
    Store.subscribe(remote);
    mapReady.then(function () { render(true); });
  });
})();
