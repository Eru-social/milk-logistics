// СТРАНИЦА ВОДИТЕЛЯ. Показывает утверждённый маршрут одной машины
// и отправляет диспетчеру отметки: выехал, приехал, начал и закончил разгрузку, проблема.
(function () {
  'use strict';
  var DATA = window.MILK_DATA, DEFAULTS = window.MILK_SETTINGS, Store = window.MilkStore, KEY = 'milk.driver.vehicle';
  var REASONS = ['Поломка машины', 'Пробка или ДТП', 'Магазин закрыт', 'Не принимают товар', 'Негде разгрузиться', 'Другое'];
  var KIND = { departed: 'Выехал с завода', arrived: 'Приехал', unloading: 'Начал разгрузку', done: 'Закончил разгрузку',
    returned: 'Вернулся на завод', problem: 'Проблема' };

  var data = null, plan = null, vehicleId = null, busy = false, reason = '', toastTimer = null, refreshTimer = null, banner = '';
  try { vehicleId = +localStorage.getItem(KEY) || null; } catch (e) { /* без хранилища просто спросим машину снова */ }

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function clock(min) { min = Math.round(min); var h = Math.floor(min / 60) % 24, m = min % 60; return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m; }
  function clockOf(iso) { var d = new Date(iso); return clock(d.getHours() * 60 + d.getMinutes()); }
  function num(x) { return Math.round(x).toLocaleString('ru-RU'); }
  function toast(text, kind) {
    var el = $('toast');
    el.textContent = text; el.className = 'toast show ' + (kind || '');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { el.className = 'toast'; }, 3500);
  }

  // ---------- маршрут этой машины ----------
  function compute() {
    plan = null;
    if (!data || !data.approved) return;
    var settings = Object.assign({}, DEFAULTS, data.settings || {});
    // Если план перестраивали в течение дня, к нему приложен «снимок дня» (см. js/replan.js): с ним и считаем.
    var live = (data.approved.summary && data.approved.summary.live) || null;
    plan = window.MilkSolver.fromAssignment({ depot: DATA.depot, orders: data.orders, vehicles: data.vehicles, settings: settings, roads: data.roads },
      data.approved.assignment, null, live);
  }

  // ---------- если день перестроили ----------
  function placeOf(node) { return node ? plan.stops[node - 1] : DATA.depot; }
  function placeText(node) { return node ? plan.stops[node - 1].address + ' (у точки «' + plan.stops[node - 1].orders[0].name + '»)' : 'на заводе'; }
  function movedFrom(orderId) {            // из какой машины пришла точка (0 — она всегда была нашей)
    var moved = (plan.live && plan.live.moved) || {};
    return moved[orderId] !== undefined && moved[orderId] !== vehicleId ? moved[orderId] : 0;
  }
  // Машина сломана: показываем водителю, кто и когда приедет за грузом.
  function brokenCard(route) {
    var rec = plan.live.vehicles[vehicleId] || {}, node = 0, helpers = [];
    plan.stops.forEach(function (s, i) { if (s.orders[0].id === rec.pos) node = i + 1; });
    plan.routes.forEach(function (r) {
      r.stops.forEach(function (x) {
        if (x.pickup && x.pickup.node === node) helpers.push({ name: r.vehicle.name, at: x.pickup.arrive, count: x.pickup.count, kg: x.pickup.kg });
      });
    });
    helpers.sort(function (a, b) { return a.at - b.at; });
    var html = '<div class="card bad-card"><b>Машина снята с маршрута в ' + clock(route.back) + '</b>' +
      '<p>Оставайтесь на месте. ' + (helpers.length ? 'За грузом приедут:' : 'Диспетчер решает, что делать с грузом.') + '</p>';
    if (helpers.length) html += '<ul class="log">' + helpers.map(function (h) {
      return '<li><b>около ' + clock(h.at) + '</b> ' + esc(h.name) + ' · ' + h.count + ' точ., ' + num(h.kg) + ' кг</li>';
    }).join('') + '</ul>';
    return html + '</div>';
  }
  function pickupCard(x) {                 // перед этой точкой нужно забрать груз из сломанной машины
    var p = placeOf(x.pickup.node), from = movedFrom(plan.stops[x.stop].orders[0].id);
    return '<section class="card now pickup-card"><span class="eyebrow">Сначала перегрузка · около ' + clock(x.pickup.arrive) + '</span>' +
      '<h2>Заберите груз из сломанной машины' + (from ? ' ' + from : '') + '</h2>' +
      '<p>' + esc(placeText(x.pickup.node)) + ' · ' + x.pickup.count + ' точ., ' + num(x.pickup.kg) + ' кг</p>' +
      '<a class="nav-link" href="https://yandex.by/maps/?rtext=~' + p.lat + ',' + p.lon + '&rtt=auto" target="_blank" rel="noopener">Открыть в Яндекс Картах</a></section>';
  }
  function myRoute() {
    if (!plan) return null;
    for (var i = 0; i < plan.routes.length; i++) if (plan.routes[i].vehicle.id === vehicleId) return plan.routes[i];
    return null;
  }
  function vehicleName(id) {
    for (var i = 0; i < data.vehicles.length; i++) if (data.vehicles[i].id === id) return data.vehicles[i].name;
    return 'Машина ' + id;
  }

  // Где водитель сейчас: считаем по его же отметкам.
  function progress(route) {
    var mine = data.events.filter(function (e) { return e.vehicleId === vehicleId; });
    var departed = false, returned = false, stopStatus = {};
    mine.forEach(function (e) {
      if (e.kind === 'departed') departed = true;
      if (e.kind === 'returned') returned = true;
      if (e.orderId && e.kind !== 'problem') stopStatus[e.orderId] = e.kind;
    });
    var current = -1;
    if (route) for (var i = 0; i < route.stops.length; i++) {
      var oid = plan.stops[route.stops[i].stop].orders[0].id;
      if (stopStatus[oid] !== 'done') { current = i; break; }
    }
    return { departed: departed, returned: returned, stopStatus: stopStatus, current: current, events: mine };
  }
  function nextAction(route, pr) {
    if (!pr.departed) return { kind: 'departed', label: 'Выехал с завода' };
    if (pr.current >= 0) {
      var oid = plan.stops[route.stops[pr.current].stop].orders[0].id, st = pr.stopStatus[oid];
      if (!st) return { kind: 'arrived', label: 'Приехал на точку', orderId: oid };
      if (st === 'arrived') return { kind: 'unloading', label: 'Начал разгрузку', orderId: oid };
      return { kind: 'done', label: 'Закончил разгрузку', orderId: oid };
    }
    if (!pr.returned) return { kind: 'returned', label: 'Вернулся на завод' };
    return null;
  }

  // ---------- показ ----------
  function render() {
    var app = $('app');
    $('btn-change').hidden = !vehicleId;
    if (!data) {
      app.innerHTML = '<div class="card bad-card"><b>Нет связи с сервером</b><p>Проверьте мобильный интернет и обновите страницу.</p>' +
        '<button type="button" class="btn primary" id="btn-retry">Повторить</button></div>';
      $('btn-retry').onclick = function () { location.reload(); };
      return;
    }
    if (!vehicleId) return renderPicker(app);
    var route = myRoute(), html = '';
    html += '<h1 class="title">' + esc(vehicleName(vehicleId)) + '</h1>';
    if (banner) html += '<div class="banner">' + esc(banner) + '</div>';
    if (!data.approved) {
      html += '<div class="card"><b>Маршрут ещё не утверждён</b><p>Логист утверждает план на экране диспетчера. Страница обновится сама.</p></div>';
      app.innerHTML = html; return;
    }
    if (route && route.broken) {
      html += brokenCard(route) + '<button type="button" class="btn danger-outline big" id="btn-problem">Сообщить о проблеме</button>';
      app.innerHTML = html;
      $('btn-problem').onclick = function () { openSheet(null); };
      return;
    }
    if (!route || !route.seq.length) {
      html += '<div class="card"><b>На сегодня маршрута нет</b><p>Эта машина остаётся в гараже по утверждённому плану.</p></div>';
      app.innerHTML = html; return;
    }
    var pr = progress(route), act = nextAction(route, pr), doneCount = 0;
    route.stops.forEach(function (x) { if (pr.stopStatus[plan.stops[x.stop].orders[0].id] === 'done') doneCount++; });
    html += '<p class="sub">Утверждён в ' + clockOf(data.approved.at) + ' · ' + route.seq.length + ' точек · ' + num(route.load) + ' кг · выезд ' + clock(route.depart) + '</p>';
    html += '<div class="progress" aria-label="Разгружено ' + doneCount + ' из ' + route.seq.length + '"><i style="width:' + (doneCount / route.seq.length * 100).toFixed(0) + '%"></i></div>';

    if (pr.current >= 0 && pr.departed) {
      var x = route.stops[pr.current], s = plan.stops[x.stop];
      if (x.pickup && !pr.stopStatus[s.orders[0].id]) html += pickupCard(x);
      html += '<section class="card now"><span class="eyebrow">Точка ' + (pr.current + 1) + ' из ' + route.seq.length + ' · по плану ' + clock(x.start) + '</span>' +
        '<h2>' + esc(s.orders.map(function (o) { return o.name; }).join(' + ')) + '</h2>' +
        '<p>' + esc(s.address) + ' · ' + num(s.kg) + ' кг</p>' +
        '<a class="nav-link" href="https://yandex.by/maps/?rtext=~' + s.lat + ',' + s.lon + '&rtt=auto" target="_blank" rel="noopener">Открыть в Яндекс Картах</a></section>';
    }
    if (act) html += '<button type="button" class="btn primary big" id="btn-main"' + (busy ? ' disabled' : '') + '>' + esc(act.label) + '</button>';
    else html += '<div class="card good-card"><b>Маршрут завершён</b><p>Спасибо! Все точки разгружены.</p></div>';
    html += '<button type="button" class="btn danger-outline big" id="btn-problem">Сообщить о проблеме</button>';

    html += '<h3 class="list-title">Все точки</h3><ol class="stops">';
    route.stops.forEach(function (x, i) {
      var s = plan.stops[x.stop], st = pr.stopStatus[s.orders[0].id], from = movedFrom(s.orders[0].id);
      if (x.pickup) html += '<li class="pickup"><span class="t">' + clock(x.pickup.arrive) + '</span><span class="w"><b>Перегрузка из сломанной машины</b><small>' +
        esc(placeText(x.pickup.node)) + ' · ' + x.pickup.count + ' точ., ' + num(x.pickup.kg) + ' кг</small></span></li>';
      html += '<li class="' + (st ? 'st-' + st : '') + (i === pr.current && pr.departed ? ' cur' : '') + '"><span class="t">' + clock(x.start) + '</span>' +
        '<span class="w"><b>' + esc(s.orders.map(function (o) { return o.name; }).join(' + ')) + '</b><small>' + esc(s.address) + ' · ' + num(s.kg) + ' кг' +
        (from ? ' · из машины ' + from : '') + (st ? ' · ' + esc(KIND[st].toLowerCase()) : '') + '</small></span></li>';
    });
    html += '</ol>';
    var last = pr.events.slice(-3).reverse();
    if (last.length) {
      html += '<h3 class="list-title">Ваши отметки</h3><ul class="log">';
      last.forEach(function (e) { html += '<li class="' + (e.kind === 'problem' ? 'bad' : '') + '"><b>' + clockOf(e.at) + '</b> ' + esc(KIND[e.kind]) + (e.note ? ': ' + esc(e.note) : '') + '</li>'; });
      html += '</ul>';
    }
    app.innerHTML = html;
    if (act) $('btn-main').onclick = function () { send(act.kind, act.orderId, ''); };
    $('btn-problem').onclick = function () { openSheet(pr.current >= 0 ? plan.stops[route.stops[pr.current].stop].orders[0].id : null); };
  }

  function renderPicker(app) {
    var html = '<h1 class="title">Какая у вас машина?</h1>';
    html += data.approved ? '<p class="sub">Маршрут утверждён в ' + clockOf(data.approved.at) + '</p>' : '<p class="sub">Маршрут ещё не утверждён логистом</p>';
    html += '<div class="pick">';
    data.vehicles.forEach(function (v) {
      if (v.active === false) return;
      var r = null;
      if (plan) for (var i = 0; i < plan.routes.length; i++) if (plan.routes[i].vehicle.id === v.id) r = plan.routes[i];
      html += '<button type="button" class="pick-btn" data-id="' + v.id + '"><b>' + esc(v.name) + '</b><small>' +
        (r && r.seq.length ? r.seq.length + ' точек · выезд ' + clock(r.depart) : (plan ? 'в гараже' : '')) + '</small></button>';
    });
    app.innerHTML = html + '</div>';
    app.querySelectorAll('.pick-btn').forEach(function (b) {
      b.onclick = function () {
        vehicleId = +b.getAttribute('data-id');
        try { localStorage.setItem(KEY, vehicleId); } catch (e) { /* не страшно */ }
        banner = ''; render(); window.scrollTo(0, 0);
      };
    });
  }

  // ---------- отправка отметок ----------
  function send(kind, orderId, note) {
    if (busy) return;
    busy = true; render();
    Store.addEvent({ vehicleId: vehicleId, orderId: orderId, kind: kind, note: note }).then(function (ev) {
      busy = false;
      if (!ev) { render(); toast('Не отправилось. Проверьте интернет и нажмите ещё раз.', 'bad'); return; }
      addEvent(ev);
      if (navigator.vibrate) { try { navigator.vibrate(40); } catch (e) { /* нет вибрации */ } }
      toast('Диспетчер видит: ' + KIND[kind].toLowerCase(), kind === 'problem' ? 'bad' : '');
    });
  }
  function addEvent(ev) {
    for (var i = 0; i < data.events.length; i++) if (data.events[i].id === ev.id) return;
    data.events.push(ev); render();
  }

  var sheetOrder = null;
  function openSheet(orderId) {
    sheetOrder = orderId; reason = '';
    $('reasons').innerHTML = REASONS.map(function (r) { return '<button type="button" class="reason" aria-pressed="false">' + r + '</button>'; }).join('');
    $('problem-note').value = ''; $('sheet-send').disabled = true; $('sheet').hidden = false;
  }
  $('reasons').addEventListener('click', function (e) {
    var b = e.target.closest('.reason');
    if (!b) return;
    $('reasons').querySelectorAll('.reason').forEach(function (x) { x.setAttribute('aria-pressed', x === b); });
    reason = b.textContent; $('sheet-send').disabled = false;
  });
  $('sheet-cancel').onclick = function () { $('sheet').hidden = true; };
  $('sheet-send').onclick = function () {
    var note = reason + ($('problem-note').value.trim() ? ': ' + $('problem-note').value.trim() : '');
    $('sheet').hidden = true; send('problem', sheetOrder, note);
  };
  $('btn-change').onclick = function () {
    vehicleId = null;
    try { localStorage.removeItem(KEY); } catch (e) { /* не страшно */ }
    render();
  };

  // ---------- изменения от диспетчера ----------
  function refreshSoon() { clearTimeout(refreshTimer); refreshTimer = setTimeout(function () { compute(); render(); }, 500); }
  function upsert(list, row, oldId) {
    var id = row ? row.id : oldId;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) { if (row) list[i] = row; else list.splice(i, 1); return; }
    if (row) { list.push(row); list.sort(function (a, b) { return a.id - b.id; }); }
  }

  // Таблица дорог обычно приходит из базы. Файл js/roads.js большой, а мобильный интернет медленный,
  // поэтому телефон грузит его, только если база ответила, но таблицы дорог в ответе нет.
  // Без базы маршрута у водителя всё равно нет (утверждённый план лежит в базе), и файл не нужен.
  function ensureRoads(d) {
    if (!d || d.roads || typeof document === 'undefined' || !document.createElement) return Promise.resolve(d);
    return new Promise(function (done) {
      var tag = document.createElement('script');
      tag.src = 'js/roads.js?v=11';
      tag.onload = function () { d.roads = window.MilkSolver.roadsFrom(window.MILK_ROADS); done(d); };
      tag.onerror = function () { done(d); };          // не загрузился — считаем по прямой, как раньше
      document.head.appendChild(tag);
    });
  }

  Store.load().then(ensureRoads).then(function (d) {
    data = d;
    compute(); render();
    if (!d) return;
    Store.subscribe({
      order: function (row, oldId) { upsert(data.orders, row, oldId); refreshSoon(); },
      vehicle: function (row, oldId) { upsert(data.vehicles, row, oldId); refreshSoon(); },
      settings: function (s) { data.settings = s || {}; refreshSoon(); },
      plan: function (kind, p) {
        if (kind !== 'approved') return;
        data.approved = p;
        banner = p ? 'Логист обновил маршрут в ' + clockOf(p.at) : '';
        if (p) toast('Маршрут обновлён логистом');
        refreshSoon();
      },
      event: function (ev) { if (!ev) { data.events = []; refreshSoon(); } else addEvent(ev); },
      status: function () { /* связь показываем только при ошибке отправки */ }
    });
  });
})();
