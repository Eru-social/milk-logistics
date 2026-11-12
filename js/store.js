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
      sb.from('driver_events').select('*').order('created_at', { ascending: true }).limit(1000)
    ]), 8000).then(function (res) {
      var orders = check(res[0]), vehicles = check(res[1]), settings = check(res[2]), plans = check(res[3]), events = check(res[4]);
      online = true;
      var byId = {};
      plans.forEach(function (p) { byId[p.id] = p; });
      return {
        orders: orders.map(orderFromRow), vehicles: vehicles.map(vehicleFromRow),
        settings: settings ? settings.data : {}, draft: planFromRow(byId.draft), approved: planFromRow(byId.approved),
        events: events.map(eventFromRow)
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
  function saveVehicle(v) {
    return run(function () { return sb.from('vehicles').upsert({ id: v.id, name: v.name, cap: v.cap, active: v.active !== false, updated_at: now() }); });
  }
  function saveSettings(data) { return run(function () { return sb.from('app_settings').upsert({ id: 1, data: data, updated_at: now() }); }); }
  function savePlan(kind, assignment, summary) {
    return run(function () { return sb.from('plans').upsert({ id: kind, assignment: assignment, summary: summary || {}, author: clientId, updated_at: now() }); });
  }
  function addEvent(e) {
    return run(function () { return sb.from('driver_events').insert({ vehicle_id: e.vehicleId, order_id: e.orderId || null, kind: e.kind, note: e.note || null }).select(); })
      .then(function (rows) { return rows && rows[0] ? eventFromRow(rows[0]) : null; });
  }
  function reset() { return run(function () { return sb.rpc('reset_demo'); }); }

  // ---------- подписка на изменения с других экранов ----------
  // handlers: { order(row|null, oldId), vehicle(row|null, oldId), settings(data), plan(kind, plan|null), event(ev|null), status(text) }
  function subscribe(handlers) {
    if (!online) return;
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
        else if (p.new.author !== clientId) handlers.plan(p.new.id, planFromRow(p.new));
      }))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'driver_events' }, on('driver_events', function (p) {
        handlers.event(p.eventType === 'DELETE' ? null : eventFromRow(p.new));
      }))
      .subscribe(function (status) { if (handlers.status) handlers.status(status); });
  }

  var Store = {
    load: load, subscribe: subscribe, saveOrder: saveOrder, saveVehicle: saveVehicle, saveSettings: saveSettings,
    saveDraft: function (a, s) { return savePlan('draft', a, s); },
    approve: function (a, s) { return savePlan('approved', a, s); },
    addEvent: addEvent, reset: reset, onError: null,
    isOnline: function () { return online; }, clientId: clientId
  };
  window.MilkStore = Store;
})();
