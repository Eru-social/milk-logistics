// ХРАНИЛИЩЕ. Всё общение с базой Supabase собрано здесь.
// Остальной код не знает, где лежат данные: в базе или (если сервер недоступен) в этом браузере.
(function () {
  'use strict';
  var cfg = window.MILK_CONFIG || {}, sb = null, online = false;
  var clientId = Math.random().toString(36).slice(2, 10);   // метка этого экрана, чтобы не ловить своё же эхо

  // ---------- перевод «база ↔ приложение» ----------
  function orderFromRow(r) {
    return { id: r.id, name: r.name, address: r.address, kg: r.kg, from: r.from_min, timeExplicit: r.time_explicit,
      lat: r.lat, lon: r.lon, approx: r.approx };
  }
  function vehicleFromRow(r) { return { id: r.id, name: r.name, cap: r.cap, active: r.active }; }
  function eventFromRow(r) {
    return { id: r.id, vehicleId: r.vehicle_id, orderId: r.order_id, kind: r.kind, note: r.note || '', at: r.created_at };
  }
  function planFromRow(r) { return r ? { assignment: r.assignment, summary: r.summary || {}, author: r.author, at: r.updated_at } : null; }
  // Таблица расстояний по дорогам: index говорит, в какой строке лежит точка "широта,долгота".
  function roadsFromRow(r) {
    if (!r || !r.keys || !r.km10 || !r.min10) return null;
    var index = {};
    r.keys.forEach(function (k, i) { index[k] = i; });
    return { n: r.keys.length, index: index, km10: r.km10, min10: r.min10 };
  }
  function now() { return new Date().toISOString(); }

  function withTimeout(promise, ms) {
    return Promise.race([promise, new Promise(function (_, bad) { setTimeout(function () { bad(new Error('timeout')); }, ms); })]);
  }
  function check(res) { if (res.error) throw res.error; return res.data; }

  // Загружает всё сразу. Если база недоступна, возвращает null — приложение работает локально.
  function load() {
    if (!window.supabase || !cfg.supabaseUrl) return Promise.resolve(null);
    sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey);
    return withTimeout(Promise.all([
      sb.from('orders').select('*').order('id'),
      sb.from('vehicles').select('*').order('id'),
      sb.from('app_settings').select('*').eq('id', 1).maybeSingle(),
      sb.from('plans').select('*'),
      sb.from('driver_events').select('*').order('created_at', { ascending: true }).limit(1000),
      // Таблица дорог — самая тяжёлая часть загрузки (сотни килобайт). На экране диспетчера её копия уже
      // загружена файлом js/roads.js (сверено с базой 15 ноября: те же 191 точка и те же числа), поэтому
      // при плохом Wi-Fi не тянем её второй раз. Странице водителя файл не нужен — ей таблица идёт из базы.
      window.MILK_ROADS ? Promise.resolve({ data: null }) : sb.from('road_matrix').select('keys,km10,min10').eq('id', 1).maybeSingle()
    ]), 12000).then(function (res) {
      var orders = check(res[0]), vehicles = check(res[1]), settings = check(res[2]), plans = check(res[3]), events = check(res[4]);
      online = true;
      var byId = {};
      plans.forEach(function (p) { byId[p.id] = p; });
      return {
        orders: orders.map(orderFromRow), vehicles: vehicles.map(vehicleFromRow),
        settings: settings ? settings.data : {}, draft: planFromRow(byId.draft), approved: planFromRow(byId.approved),
        events: events.map(eventFromRow), roads: roadsFromRow(res[5].data)
      };
    }).catch(function (e) { console.warn('База недоступна, работаем локально:', e && e.message); online = false; return null; });
  }

  // ---------- запись ----------
  // makeRequest вызывается только когда база на связи: без сервера запись просто пропускаем.
  function run(makeRequest) {
    if (!online) return Promise.resolve(null);
    return makeRequest().then(check).catch(function (e) {
      console.warn('Не удалось сохранить:', e && e.message);
      if (Store.onError) Store.onError(e);
      return null;
    });
  }
  function saveOrder(o) {
    return run(function () { return sb.from('orders').update({ kg: o.kg, from_min: o.from, time_explicit: !!o.timeExplicit, updated_at: now() }).eq('id', o.id); });
  }
  // Запись пачкой (этап 1Б, сценарий «обычный день» меняет вес у всех заказов сразу).
  // Вставлять строки демо-база не разрешает (правила доступа: читать и править можно, удалять и добавлять нельзя),
  // поэтому upsert не годится. Вместо 214 отдельных запросов заказы с одинаковыми новыми значениями
  // правятся одним запросом (update … where id in (…)): после ×0,7 разных весов несколько десятков.
  // Запросы идут по 6 одновременно, чтобы не душить сеть. Другие экраны всё равно получают правку по каждой строке,
  // но сами не пересчитывают: они ждут черновик, который этот экран сохранит после записи.
  // list — правки вида { id, kg?, from?, timeExplicit? }: только поля, которые поменялись.
  function saveOrders(list) {
    if (!online || !list.length) return Promise.resolve(null);
    var groups = {}, keys = [];
    list.forEach(function (o) {
      var row = {};
      if ('kg' in o) row.kg = o.kg;
      if ('from' in o) row.from_min = o.from;
      if ('timeExplicit' in o) row.time_explicit = !!o.timeExplicit;
      var key = JSON.stringify(row);
      if (!groups[key]) { groups[key] = { row: row, ids: [] }; keys.push(key); }
      groups[key].ids.push(o.id);
    });
    var next = 0, failed = null;
    function worker() {
      if (next >= keys.length) return Promise.resolve();
      var g = groups[keys[next++]];
      return sb.from('orders').update(Object.assign({ updated_at: now() }, g.row)).in('id', g.ids)
        .then(check).catch(function (e) { failed = e; }).then(worker);
    }
    var pool = [];
    for (var i = 0; i < Math.min(6, keys.length); i++) pool.push(worker());
    return Promise.all(pool).then(function () {
      if (failed) { console.warn('Не удалось сохранить заказы:', failed.message); if (Store.onError) Store.onError(failed); }
      return { requests: keys.length, failed: !!failed };
    });
  }
  function saveVehicle(v) {
    return run(function () { return sb.from('vehicles').upsert({ id: v.id, name: v.name, cap: v.cap, active: v.active !== false, updated_at: now() }); });
  }
  // keys — какие правила поменялись. В базу уходят только они (функция patch_settings дописывает их к остальным),
  // поэтому два экрана, поменявшие разные правила одновременно, не затирают друг друга (этап 6).
  // Если функции в базе нет (старая база), пишем все правила целиком, как раньше.
  function saveSettings(data, keys) {
    var patch = {};
    (keys || Object.keys(data || {})).forEach(function (k) { if (data && k in data) patch[k] = data[k]; });
    return run(function () {
      return sb.rpc('patch_settings', { patch: patch }).then(function (res) {
        if (!res.error) return res;
        console.warn('patch_settings недоступна, пишу правила целиком:', res.error.message);
        return sb.from('app_settings').upsert({ id: 1, data: data, updated_at: now() });
      });
    });
  }
  // ДВА ЭКРАНА ПРАВЯТ ОДНОВРЕМЕННО (этап 6). Каждый экран, поправив данные, сам считает план и сохраняет черновик.
  // Если два экрана сохранили черновик почти одновременно, в базе остаётся тот, что записан последним.
  // Чтобы оба экрана показали именно его, пользуемся тем, что база рассылает изменения строго в порядке записи:
  // пока наш черновик не вернулся к нам эхом, всё чужое, что приходит, записано РАНЬШЕ нашего — его пропускаем.
  // Наш черновик — последний, и другие экраны его получат. Пришло эхо — снова принимаем чужие.
  // Метка rev в summary узнаёт своё эхо. Если эхо не пришло за 15 секунд (связь пропала) или запись не прошла,
  // ожидание снимается, чтобы экран не застрял.
  var revCount = 0, waiting = {};
  function savePlan(kind, assignment, summary) {
    if (!online) return Promise.resolve(null);
    var rev = clientId + '-' + (++revCount);
    waiting[kind] = { rev: rev, until: Date.now() + 15000 };
    return sb.from('plans').upsert({ id: kind, assignment: assignment, summary: Object.assign({}, summary || {}, { rev: rev }), author: clientId, updated_at: now() })
      .then(check).then(function () { return true; }).catch(function (e) {
        if (waiting[kind] && waiting[kind].rev === rev) delete waiting[kind];
        console.warn('Не удалось сохранить план:', e && e.message);
        if (Store.onError) Store.onError(e);
        return null;
      });
  }
  // true — чужой план надо пропустить: он записан раньше нашего, а наш ещё в пути.
  function olderThanMine(row) {
    var w = waiting[row.id];
    if (row.author === clientId) {            // наше же эхо: дальше принимаем чужие планы
      if (w && row.summary && row.summary.rev === w.rev) delete waiting[row.id];
      return true;                            // своё эхо на экране не показываем (план и так наш)
    }
    if (w && Date.now() < w.until) return true;
    if (w) delete waiting[row.id];
    return false;
  }
  function addEvent(e) {
    return run(function () { return sb.from('driver_events').insert({ vehicle_id: e.vehicleId, order_id: e.orderId || null, kind: e.kind, note: e.note || null }).select(); })
      .then(function (rows) { return rows && rows[0] ? eventFromRow(rows[0]) : null; });
  }
  // Сброс пробуем, даже если связь пропадала (online = false): так «Сбросить демо» после возвращения сети
  // снова работает с базой. Ждём не дольше 15 секунд; ошибка — null, экран тогда сбрасывает только себя.
  function reset() {
    if (!sb) return Promise.resolve(null);
    return withTimeout(sb.rpc('reset_demo'), 15000).then(check).then(function () { return true; })
      .catch(function (e) { console.warn('Сброс в базе не прошёл:', e && e.message); return null; });
  }

  // ---------- подписка на изменения с других экранов ----------
  // handlers: { order(row|null, oldId), vehicle(row|null, oldId), settings(data), plan(kind, plan|null), event(ev|null), status(text) }
  var subscribed = false;
  function subscribe(handlers) {
    if (!online || subscribed) return;      // повторный вызов (после сброса, когда связь вернулась) ничего не дублирует
    subscribed = true;
    function on(table, fn) {
      return function (p) { try { fn(p); } catch (e) { console.error(e); } };
    }
    sb.channel('milk-' + clientId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, on('orders', function (p) {
        handlers.order(p.eventType === 'DELETE' ? null : orderFromRow(p.new), p.old && p.old.id);
      }))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'vehicles' }, on('vehicles', function (p) {
        handlers.vehicle(p.eventType === 'DELETE' ? null : vehicleFromRow(p.new), p.old && p.old.id);
      }))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'app_settings' }, on('app_settings', function (p) {
        handlers.settings(p.eventType === 'DELETE' ? {} : p.new.data);
      }))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'plans' }, on('plans', function (p) {
        if (p.eventType === 'DELETE') handlers.plan(p.old && p.old.id, null);
        else if (!olderThanMine(p.new)) handlers.plan(p.new.id, planFromRow(p.new));
      }))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'driver_events' }, on('driver_events', function (p) {
        handlers.event(p.eventType === 'DELETE' ? null : eventFromRow(p.new));
      }))
      .subscribe(function (status) { if (handlers.status) handlers.status(status); });
  }

  var Store = {
    load: load, subscribe: subscribe, saveOrder: saveOrder, saveOrders: saveOrders, saveVehicle: saveVehicle, saveSettings: saveSettings,
    saveDraft: function (a, s) { return savePlan('draft', a, s); },
    approve: function (a, s) { return savePlan('approved', a, s); },
    addEvent: addEvent, reset: reset, onError: null,
    isOnline: function () { return online; }, hasServer: function () { return !!sb; }, clientId: clientId
  };
  window.MilkStore = Store;
})();
