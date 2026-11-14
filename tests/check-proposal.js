// Проверка предложений «было → станет» и кнопок «а если» (этап 1Б). Запуск: node tests/check-proposal.js
// Что проверяем:
//   1) каждый из пяти сценариев даёт предложение: вес сходится, каждая остановка ровно в одном месте;
//   2) расчёт предложения не трогает текущие данные и план («Отменить» возвращает всё как было, базе нечего отменять);
//   3) «Применить» пишет в базу ровно список изменений (база здесь поддельная: считаем, что в неё ушло);
//   4) ошибочные изменения дают понятный отказ, а не падение;
//   5) происшествия идущего дня идут через тот же формат, включая новое «магазин просит другое время».
const dir = process.argv[2] || require('path').join(__dirname, '..');
global.window = {};
require(dir + '/js/settings.js'); require(dir + '/js/data.js'); require(dir + '/js/roads.js'); require(dir + '/js/base-plan.js');
const S = require(dir + '/js/solver.js'), C = require(dir + '/js/changes.js'), P = require(dir + '/js/proposal.js');
const D = window.MILK_DATA, BASE = window.MILK_BASE_PLAN;
const clone = x => JSON.parse(JSON.stringify(x));
const input = { depot: D.depot, orders: clone(D.orders), vehicles: clone(D.vehicles), settings: Object.assign({}, window.MILK_SETTINGS), roads: S.roadsFrom(window.MILK_ROADS) };
let fails = 0;
function ok(cond, text) { if (!cond) { fails++; console.log('  ОШИБКА: ' + text); } }
const dataKey = d => JSON.stringify({ o: d.orders, v: d.vehicles, s: d.settings });

// Каждая остановка ровно один раз (в маршруте или в «не довезём»), вес плана = вес заказов в данных.
function checkPlan(plan, data, label) {
  const seen = new Array(plan.stops.length).fill(0); let kg = 0;
  plan.routes.forEach(r => r.seq.forEach(i => { seen[i]++; kg += plan.stops[i].kg; }));
  (plan.dropped || []).forEach(i => { seen[i]++; kg += plan.stops[i].kg; });
  ok(seen.every(x => x === 1), label + ': остановка не ровно в одном месте');
  const want = data.orders.reduce((a, o) => a + (o.kg > 0 ? o.kg : 0), 0);
  ok(Math.abs(kg - want) < 0.5, label + ': вес плана ' + kg + ', а в заказах ' + want);
  plan.routes.forEach(r => { if (r.vehicle.active === false) ok(!r.seq.length, label + ': снятая машина везёт груз'); });
}

// Поддельная база для js/store.js: запоминает, какие запросы ушли.
function fakeStore() {
  const sent = [];
  function q(table) {
    const b = { table, op: 'select', rows: null, ids: null };
    const self = {
      select() { return self; }, order() { return self; }, eq() { return self; }, limit() { return self; }, maybeSingle() { b.single = true; return self; },
      update(row) { b.op = 'update'; b.row = row; return self; }, upsert(row) { b.op = 'upsert'; b.row = row; return self; },
      in(col, ids) { b.ids = ids; return self; },
      then(res, rej) {
        let data = [];
        if (b.op !== 'select') sent.push(b);
        else if (table === 'orders') data = D.orders.map(o => ({ id: o.id, name: o.name, address: o.address, kg: o.kg, from_min: o.from, time_explicit: !!o.timeExplicit, lat: o.lat, lon: o.lon }));
        else if (table === 'vehicles') data = clone(D.vehicles);
        else if (b.single) data = null;
        return Promise.resolve({ data, error: null }).then(res, rej);
      }
    };
    return self;
  }
  window.supabase = { createClient: () => ({ from: q, rpc: () => Promise.resolve({ data: null, error: null }), channel: () => ({ on() { return this; }, subscribe() {} }) }) };
  window.MILK_CONFIG = { supabaseUrl: 'https://x', supabaseKey: 'k' };
  delete require.cache[require.resolve(dir + '/js/store.js')];
  require(dir + '/js/store.js');
  return { store: window.MilkStore, sent };
}

(async () => {
  const plan = S.fromAssignment(input, BASE.assignment), naive = S.naive(input);
  const cur = { input, plan, naive };
  // Как экран (js/app.js, notWorseThanBase): расчёт на 2,5 с сравнивается с эталоном на тех же данных, берётся лучший.
  const F = require(dir + '/js/fleet.js');
  function solveLikeScreen(inp) {
    const p = F.solve(inp), b = S.fromAssignment(inp, BASE.assignment);
    if (b.leftover || (inp.settings.fleetPriority !== 'overtime' && b.used > p.used)) return p;
    return b.problems.length < p.problems.length || (b.problems.length === p.problems.length && b.km < p.km - 0.05) ? b : p;
  }
  const before = dataKey(input), planBefore = JSON.stringify(S.toAssignment(plan));
  console.log('Текущий план (эталон): ' + Math.round(plan.km) + ' км, машин ' + plan.used);
  const g0 = P.goals(plan, input, naive);
  console.log('  четыре цели: время доставки ' + Math.round(g0.delivery.pct) + '% к 12:00 · пробег ' + Math.round(g0.km.km) + ' км · машин ' + g0.fleet.used +
    ' из ' + g0.fleet.active + ' · вовремя ' + g0.window.onTime + ' из ' + g0.window.important);
  ok(g0.window.important === 10 && g0.window.onTime === 10, 'на исходных данных должно быть 10 из 10 важных вовремя');
  const tiles = P.tiles(g0, plan);
  ['Время доставки', 'Суммарный пробег', 'Количество транспорта', 'Окно доставки'].forEach(t => ok(tiles.indexOf(t) >= 0, 'в верхней строке нет цели «' + t + '»'));

  // ---------- 1–3. Пять сценариев ----------
  const least = P.leastLoaded(plan);
  console.log('  наименее загруженная машина: ' + least);
  const rows = [];
  for (const key of P.KEYS) {
    const list = P.scenario(key, input, least);
    const pr = P.make(cur, list, { solve: solveLikeScreen });
    ok(pr.ok, key + ': ' + (pr.errors || []).join('; '));
    if (!pr.ok) continue;
    checkPlan(pr.plan, pr.data, key);
    ok(dataKey(input) === before, key + ': расчёт предложения изменил текущие данные');
    ok(JSON.stringify(S.toAssignment(plan)) === planBefore, key + ': расчёт предложения изменил текущий план');
    ok(/Применить/.test(P.card(pr)) && /Отменить/.test(P.card(pr)), key + ': в карточке нет кнопок');
    // «Применить»: что уйдёт в базу
    const fs = fakeStore(); await fs.store.load();
    const res = await P.save(fs.store, input, pr.data);
    const orders = fs.sent.filter(b => b.table === 'orders'), veh = fs.sent.filter(b => b.table === 'vehicles'), set = fs.sent.filter(b => b.table === 'app_settings');
    const ids = [].concat(...orders.map(b => b.ids));
    if (key === 'normal') {
      ok(ids.length === input.orders.filter(o => o.kg > 0 && C.scaledKg(o.kg, 0.7) !== o.kg).length && new Set(ids).size === ids.length, 'обычный день: в базу ушли не все заказы или дважды');
      orders.forEach(b => b.ids.forEach(id => { const o = input.orders.find(x => x.id === id); ok(b.row.kg === C.scaledKg(o.kg, 0.7), 'обычный день: заказ ' + id + ' вес ' + b.row.kg); }));
      ok(!veh.length && !set.length, 'обычный день: лишняя запись машин или правил');
      ok(orders.length < 90, 'обычный день: слишком много запросов (' + orders.length + ')');
      console.log('  обычный день: ' + ids.length + ' заказов записаны за ' + orders.length + ' запросов');
    } else if (key === 'minus1') {
      ok(!orders.length && !set.length && veh.length === 1 && veh[0].row.id === least && veh[0].row.active === false, 'минус машина: в базу ушло не то');
    } else {
      const k = list[0].key;
      ok(!orders.length && !veh.length && set.length === 1, key + ': в базу ушло не только правило');
      if (set.length) {
        const diff = Object.keys(set[0].row.data).filter(x => JSON.stringify(set[0].row.data[x]) !== JSON.stringify(input.settings[x]));
        ok(diff.length === 1 && diff[0] === k && set[0].row.data[k] === list[0].value, key + ': изменилось не то правило: ' + diff.join(','));
      }
    }
    // после «Применить» данные = наложенный список: повтор с теми же данными ничего не пишет
    const fs2 = fakeStore(); await fs2.store.load(); await P.save(fs2.store, pr.data, clone(pr.data));
    ok(fs2.sent.length === 0, key + ': повторное применение что-то пишет');
    const a = pr.before, b = pr.after;
    const line = (g) => Math.round(g.delivery.pct) + '% к 12:00 · ' + Math.round(g.km.km) + ' км · ' + g.fleet.used + ' из ' + g.fleet.active + ' машин · ' +
      g.window.onTime + '/' + g.window.important + ' вовремя, смена до ' + Math.floor(g.window.longest / 60) + ':' + String(Math.round(g.window.longest % 60)).padStart(2, '0') +
      ', переработка ' + Math.round(g.window.overtime) + ' мин';
    console.log('\n  [' + key + '] ' + pr.lines.join('; ') + ' (' + pr.ms + ' мс)\n    было:   ' + line(a) + '\n    станет: ' + line(b) + (b.dropped ? ' · не везём ' + b.dropped : ''));
    rows.push([key, a, b]);
  }

  // ---------- 4. Ошибочные изменения ----------
  console.log('\n=== Ошибочные изменения ===');
  const bad = [
    ['не список', 'машина 7'], ['пустой список', []], ['null', null],
    ['нет машины', [{ kind: 'vehicle_off', vehicleId: 99 }]], ['нет заказа', [{ kind: 'order_kg', orderId: 99999, kg: 10 }]],
    ['отрицательный вес', [{ kind: 'order_kg', orderId: 1, kg: -50 }]], ['вес не число', [{ kind: 'order_kg', orderId: 1, kg: 'много' }]],
    ['время 25:00', [{ kind: 'order_time', orderId: 1, time: '25:00' }]], ['время 9:75', [{ kind: 'order_time', orderId: 1, time: '9:75' }]],
    ['неизвестный вид', [{ kind: 'meteor' }]], ['пустая запись', [null]], ['нет правила', [{ kind: 'setting', key: 'speedOfLight', value: 1 }]],
    ['правило не число', [{ kind: 'setting', key: 'serviceMin', value: 'долго' }]], ['правило < 0', [{ kind: 'setting', key: 'serviceMin', value: -5 }]],
    ['переключатель чепуха', [{ kind: 'setting', key: 'fleetPriority', value: 'чепуха' }]], ['множитель 0', [{ kind: 'scale_kg', factor: 0 }]],
    ['смешаны виды', [{ kind: 'vehicle_off', vehicleId: 7 }, { kind: 'breakdown', vehicleId: 3, at: '10:00' }]],
    ['день не идёт', [{ kind: 'breakdown', vehicleId: 3, at: '10:00' }]]
  ];
  bad.forEach(([name, list]) => {
    try {
      const pr = P.make(cur, list);
      ok(!pr.ok && pr.errors.length && pr.errors.every(t => typeof t === 'string' && t.length > 5), name + ': нет понятного отказа');
      ok(/не построено/.test(P.card(pr)), name + ': карточка отказа не собралась');
      console.log('  ' + name + ': ' + pr.errors.join(' | '));
    } catch (e) { fails++; console.log('  ' + name + ': УПАЛО ' + e.stack); }
  });
  ok(dataKey(input) === before, 'ошибочные изменения изменили данные');
  // правильные записи ручной формы и будущей команды словами: строки, числа строкой, запятая
  const okList = [{ kind: 'order_time', orderId: '1', time: '7:00' }, { kind: 'order_kg', orderId: 2, kg: '450' }, { kind: 'order_kg', orderId: 3, kg: 0 },
    { kind: 'setting', key: 'trafficFactor', value: '1,3' }, { kind: 'setting', key: 'earliestDepart', value: '05:30' }, { kind: 'vehicle_off', vehicleId: 7 }];
  const chk = C.check(okList, input);
  ok(chk.ok, 'правильный список отклонён: ' + chk.errors.join('; '));
  if (chk.ok) {
    const d = C.apply(input, chk.list);
    ok(d.orders[0].from === 420 && d.orders[0].timeExplicit && d.orders[1].kg === 450 && d.orders[2].kg === 0 && d.settings.trafficFactor === 1.3 &&
      d.settings.earliestDepart === 330 && d.vehicles.find(v => v.id === 7).active === false, 'список наложен не так');
    chk.list.forEach(c => console.log('  · ' + C.describe(c, input)));
    const pr = P.make(cur, okList); ok(pr.ok, 'смешанный список не посчитан'); if (pr.ok) checkPlan(pr.plan, pr.data, 'смешанный список');
  }

  // ---------- 5. Идущий день через тот же формат ----------
  console.log('\n=== Идущий день: тот же формат изменений ===');
  const live = { base: S.fromAssignment(input, BASE.assignment) };
  const r5 = live.base.routes.find(r => r.vehicle.id === 5), lastOid = live.base.stops[r5.seq[r5.seq.length - 1]].orders[0].id;
  for (const list of [[{ kind: 'breakdown', vehicleId: 7, at: '10:40' }], [{ kind: 'delay', vehicleId: 3, at: '11:10', minutes: 40 }],
    [{ kind: 'stop_refuses', orderId: lastOid, at: '09:00', action: 'drop' }], [{ kind: 'later', orderId: lastOid, at: '09:00', time: '14:00' }]]) {
    const pr = P.make(cur, list, { base: live.base });
    ok(pr.ok, list[0].kind + ': ' + (pr.errors || []).join('; '));
    if (pr.ok) {
      const seen = new Array(pr.plan.stops.length).fill(0);
      pr.plan.routes.forEach(r => r.seq.forEach(i => seen[i]++)); pr.plan.dropped.forEach(i => seen[i]++);
      ok(seen.every(x => x === 1), list[0].kind + ': остановка не ровно в одном месте');
      console.log('  ' + pr.lines[0] + ' → ' + (pr.live ? pr.live.title : ''));
    }
  }
  ok(dataKey(input) === before, 'происшествия изменили данные');

  console.log('\n' + (fails ? 'ОШИБОК: ' + fails : 'Все проверки пройдены'));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('УПАЛО: ' + e.stack); process.exit(1); });
