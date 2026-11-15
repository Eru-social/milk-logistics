// ПОДДЕЛКА СТРАНИЦЫ И БАЗЫ для проверок этапа 6 (check-odd-input.js, check-two-screens.js). Сама не проверка.
// Как в check-dispatcher.js, экран диспетчера запускается в Node без браузера: элементы страницы — простые объекты,
// вёрстку проверки не видят. Отличия от check-dispatcher.js:
//   — часы поддельные: таймеры срабатывают, только когда проверка «двигает время» (advance), и в своём порядке;
//     так 8-секундное ожидание чужого плана и 15-секундное ожидание эха ведут себя как в жизни;
//   — можно подключить поддельную базу (makeServer): она хранит таблицы, выполняет запросы js/store.js и рассылает
//     изменения всем подписанным экранам строго в порядке записи, как Supabase Realtime. Задержка сети у каждого экрана своя.
const fs = require('fs'), vm = require('vm'), path = require('path');
const DIR = path.join(__dirname, '..');
const SCRIPTS = ['js/config.js', 'js/store.js', 'js/settings.js', 'js/data.js', 'js/roads.js', 'js/base-plan.js', 'js/solver.js',
  'js/fleet.js', 'js/replan.js', 'js/changes.js', 'js/proposal.js', 'js/assistant.js', 'js/map.js', 'js/app.js'];

// ---------- общие часы ----------
// Время = настоящее время с запуска + сдвиг, который добавляет advance. Решатель видит, как идут настоящие
// секунды (его запас времени 2,5 с работает как обычно), а таймеры страницы ждут, пока проверка двинет часы.
function makeClock() {
  const start = Date.parse('2026-11-16T07:00:00Z'), real0 = Date.now();
  const clock = { shift: 0, timers: [], seq: 0 };
  clock.now = () => start + (Date.now() - real0) + clock.shift;
  const RealDate = Date;
  clock.Date = class extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(clock.now()); }
    static now() { return clock.now(); }
  };
  clock.setTimeout = (fn, ms) => { const t = { id: ++clock.seq, due: clock.now() + (+ms || 0), fn }; clock.timers.push(t); return t.id; };
  clock.clearTimeout = id => { clock.timers = clock.timers.filter(t => t.id !== id); };
  const tick = () => new Promise(r => setImmediate(r));
  // Двигаем часы на ms, по пути выполняя таймеры и всё, что они запускают, в порядке их срока.
  clock.advance = async ms => {
    const end = clock.now() + ms;
    for (let guard = 0; guard < 100000; guard++) {
      for (let i = 0; i < 5; i++) await tick();
      clock.timers.sort((a, b) => a.due - b.due || a.id - b.id);
      const next = clock.timers[0];
      if (!next || next.due > end) break;
      if (next.due > clock.now()) clock.shift += next.due - clock.now();
      clock.timers.shift();
      try { next.fn(); } catch (e) { console.log('ОШИБКА в таймере: ' + e.stack); throw e; }
    }
    if (end > clock.now()) clock.shift += end - clock.now();
    for (let i = 0; i < 5; i++) await tick();
  };
  return clock;
}

// ---------- поддельная база ----------
function makeServer(clock) {
  const ctx = { window: {} };
  vm.createContext(ctx);
  ['js/data.js', 'js/base-plan.js'].forEach(f => vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), ctx));
  const D = ctx.window.MILK_DATA, BASE = ctx.window.MILK_BASE_PLAN;
  const copy = x => JSON.parse(JSON.stringify(x));
  const seedOrders = D.orders.map(o => ({ id: o.id, name: o.name, address: o.address, kg: o.kg, from_min: o.from, time_explicit: !!o.timeExplicit, lat: o.lat, lon: o.lon, approx: !!o.approx }));
  const seedVehicles = D.vehicles.map(v => ({ id: v.id, name: v.name, cap: v.cap, active: v.active !== false }));
  const server = { tables: null, channels: [], writes: 0, nextEvent: 1 };
  const iso = () => new clock.Date().toISOString();
  function emit(table, eventType, row, old) {
    server.channels.forEach(ch => ch.deliver(table, { eventType, new: row ? copy(row) : {}, old: old ? copy(old) : {} }));
  }
  function reset() {
    const t = server.tables;
    if (t) {
      t.orders.forEach(r => emit('orders', 'DELETE', null, { id: r.id }));
      t.vehicles.forEach(r => emit('vehicles', 'DELETE', null, { id: r.id }));
      t.app_settings.forEach(r => emit('app_settings', 'DELETE', null, { id: r.id }));
      t.plans.forEach(r => emit('plans', 'DELETE', null, { id: r.id }));
      t.driver_events.forEach(r => emit('driver_events', 'DELETE', null, { id: r.id }));
    }
    server.tables = { orders: copy(seedOrders), vehicles: copy(seedVehicles), app_settings: [], plans: [], driver_events: [] };
    if (t) { server.tables.orders.forEach(r => emit('orders', 'INSERT', r)); server.tables.vehicles.forEach(r => emit('vehicles', 'INSERT', r)); }
    const draft = { id: 'draft', assignment: copy(BASE.assignment), summary: copy(BASE.summary), author: 'base', updated_at: iso() };
    server.tables.plans.push(draft);
    if (t) emit('plans', 'INSERT', draft);
  }
  reset();
  server.reset = reset;

  // Выполнение одного запроса (как PostgREST): возвращает { data, error }.
  function run(q) {
    const t = server.tables[q.table];
    if (!t) return { data: null, error: { message: 'нет таблицы ' + q.table } };
    const match = r => q.filters.every(f => f.op === 'eq' ? r[f.col] === f.val : f.val.indexOf(r[f.col]) >= 0);
    if (q.kind === 'select') {
      let rows = t.filter(match).map(copy);
      if (q.orderBy) rows.sort((a, b) => (a[q.orderBy] > b[q.orderBy] ? 1 : a[q.orderBy] < b[q.orderBy] ? -1 : 0));
      if (q.limit) rows = rows.slice(0, q.limit);
      return { data: q.single ? rows[0] || null : rows, error: null };
    }
    server.writes++;
    if (q.kind === 'update') {
      t.filter(match).forEach(r => { Object.assign(r, copy(q.values)); emit(q.table, 'UPDATE', r); });
      return { data: null, error: null };
    }
    if (q.kind === 'upsert' || q.kind === 'insert') {
      const row = copy(q.values);
      if (q.table === 'driver_events') { row.id = server.nextEvent++; row.created_at = iso(); }
      const old = t.find(r => r.id === row.id);
      if (old && q.kind === 'upsert') { Object.assign(old, row); emit(q.table, 'UPDATE', old); return { data: q.returning ? [copy(old)] : null, error: null }; }
      if (old) return { data: null, error: { message: 'строка уже есть' } };
      if (q.table === 'orders') return { data: null, error: { message: 'вставка запрещена правилами доступа' } };
      t.push(row); emit(q.table, 'INSERT', row);
      return { data: q.returning ? [copy(row)] : null, error: null };
    }
    return { data: null, error: { message: 'не умею ' + q.kind } };
  }
  function rpc(name, args) {
    server.writes++;
    if (name === 'reset_demo') { reset(); return { data: null, error: null }; }
    if (name === 'patch_settings') {
      const t = server.tables.app_settings, row = t.find(r => r.id === 1);
      if (row) { row.data = Object.assign({}, row.data || {}, copy(args.patch || {})); row.updated_at = iso(); emit('app_settings', 'UPDATE', row); }
      else { const r = { id: 1, data: copy(args.patch || {}), updated_at: iso() }; t.push(r); emit('app_settings', 'INSERT', r); }
      return { data: null, error: null };
    }
    return { data: null, error: { message: 'нет функции ' + name } };
  }

  // Клиент для одного экрана: net — задержка сети этого экрана в миллисекундах (туда и обратно отдельно).
  server.client = (net) => {
    net = net || { up: 50, down: 50 };
    let lastUp = 0, lastDown = 0;
    // Запросы одного экрана доходят до базы в том порядке, в каком отправлены (одно соединение).
    const send = (fn) => new Promise(resolve => {
      const due = Math.max(clock.now() + (server.offline ? 0 : net.up), lastUp); lastUp = due;
      clock.setTimeout(() => {
        if (server.offline || net.offline) return resolve({ data: null, error: { message: 'Failed to fetch' } });
        const res = fn();
        clock.setTimeout(() => resolve(res), net.down);
      }, due - clock.now());
    });
    function Query(table) {
      const q = { table, kind: 'select', filters: [], values: null, single: false, returning: false, orderBy: null, limit: 0 };
      const api = {
        select() { if (q.kind !== 'select') q.returning = true; return api; },
        order(col) { q.orderBy = col; return api; },
        limit(n) { q.limit = n; return api; },
        eq(col, val) { q.filters.push({ op: 'eq', col, val }); return api; },
        in(col, val) { q.filters.push({ op: 'in', col, val }); return api; },
        maybeSingle() { q.single = true; return api; },
        update(v) { q.kind = 'update'; q.values = v; return api; },
        upsert(v) { q.kind = 'upsert'; q.values = v; return api; },
        insert(v) { q.kind = 'insert'; q.values = v; return api; },
        then(ok, bad) { return send(() => run(q)).then(ok, bad); }
      };
      return api;
    }
    return {
      from: table => Query(table),
      rpc: (name, args) => ({ then(ok, bad) { return send(() => rpc(name, args)).then(ok, bad); } }),
      channel() {
        const subs = [];
        const ch = {
          on(type, filter, cb) { subs.push({ table: filter.table, cb }); return ch; },
          subscribe(status) {
            server.channels.push({
              // Событие доходит до экрана через его задержку сети; порядок событий сохраняется.
              deliver(table, payload) {
                if (net.offline) return;
                const due = Math.max(clock.now() + net.down, lastDown); lastDown = due;
                clock.setTimeout(() => subs.forEach(s => { if (s.table === table) s.cb(payload); }), due - clock.now());
              }
            });
            clock.setTimeout(() => status && status('SUBSCRIBED'), net.down);
            return ch;
          }
        };
        return ch;
      }
    };
  };
  return server;
}

// ---------- поддельная страница ----------
// opts: { clock, server, net, storage, extra: [файлы до наших], settings: {…поправки к MILK_SETTINGS до запуска} }
function makePage(opts) {
  opts = opts || {};
  const clock = opts.clock || makeClock(), storage = opts.storage || {};
  const els = {};
  function el(id) {
    if (els[id]) return els[id];
    const handlers = {};
    let html = '';
    const e = { id, textContent: '', className: '', value: '', hidden: false, disabled: false, style: {}, attrs: {}, handlers, history: [],
      classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
      addEventListener(t, f) { (handlers[t] = handlers[t] || []).push(f); },
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }, hasAttribute(k) { return k in this.attrs; },
      closest() { return this; }, querySelectorAll() { return []; }, focus() {}, remove() {},
      tBodies: [{ innerHTML: '', rows: [] }] };
    // История содержимого: по ней проверка видит, сколько раз менялись числа на экране («мигание»).
    Object.defineProperty(e, 'innerHTML', { get() { return html; }, set(v) { if (v !== html) e.history.push(v); html = v; } });
    return els[id] = e;
  }
  const document = { getElementById: el, querySelectorAll: () => [], addEventListener() {}, createElement: () => el('tmp' + Math.random()), activeElement: null };
  const localStorage = { getItem: k => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v); }, removeItem: k => { delete storage[k]; } };
  const win = { document, localStorage, location: { href: 'http://x/index.html', protocol: 'http:' }, navigator: { onLine: true }, console,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, Promise, Date: clock.Date, Math, JSON, URL, AbortController,
    fetch: () => Promise.reject(new Error('нет сети')), scrollTo() {} };
  win.window = win; win.globalThis = win;
  if (opts.server) win.supabase = { createClient: () => opts.server.client(opts.net) };
  const ctx = vm.createContext(win);
  const load = f => vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), ctx, { filename: f });
  // opts.extra — файлы, которые на настоящей странице грузятся до наших (vendor/…/qrcode.js, js/base-roads.js).
  (opts.extra || []).concat(SCRIPTS).forEach(f => { load(f); if (f === 'js/settings.js' && opts.settings) Object.assign(win.MILK_SETTINGS, opts.settings); });
  const fire = (id, type, target) => {
    const hs = (els[id] && els[id].handlers[type]) || [];
    if (!hs.length) throw new Error('нет обработчика ' + id + ':' + type);
    hs.forEach(h => h({ target: target || els[id], preventDefault() {} }));
  };
  // Элемент-«кнопка» или «поле» с атрибутами: { id, attrs, value, cls }
  const btn = a => {
    const b = el('b' + Math.random());
    Object.assign(b.attrs, a.attrs || {}); b.id = a.id || ''; b.value = a.value == null ? '' : String(a.value); b.type = a.type || '';
    b.closest = sel => (sel === 'tr' && a.tr ? a.tr : b);
    if (a.cls) b.classList = Object.assign({}, b.classList, { contains: c => c === a.cls });
    return b;
  };
  const text = id => el(id).innerHTML || el(id).textContent;
  return { win, el, els, fire, btn, text, clock, storage };
}

module.exports = { makeClock, makeServer, makePage };
