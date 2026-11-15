// СТРАННЫЙ ВВОД НЕ РОНЯЕТ ЭКРАН (этап 6). Запуск: node tests/check-odd-input.js (около двух минут).
// Жюри будет вводить что угодно. Проверяем, что расчёт и экран диспетчера переживают:
//   1) границы правил, веса, вместимости и времени (MilkLimits в js/settings.js);
//   2) решатель и выбор машин: каждое числовое правило = −5, 1e9, бесконечность, «abc», пусто; вес 0 у всех,
//      отрицательный и огромный вес, время 25:00, все машины сняты, вместимость 0, ни одной машины, ни одного заказа.
//      Признаки «пережил»: нет ошибки, каждая остановка ровно в одном месте (в машине или в «не везём»), пробег — число;
//   3) список изменений (кнопки «а если», команда словами): −5 кг, 1e12 кг, «25:00», правило = бесконечность,
//      все 16 машин не выходят — предложение считается, вес сходится;
//   4) экран диспетчера (поддельная страница): то же самое руками в таблицах, «Правилах» и окне «Форс-мажор»,
//      пустая фраза и фраза на 2 000 знаков в «Что изменилось?», фраза без интернета. После каждого шага на экране
//      нет «NaN», «Infinity», «undefined», а странное значение поправлено и об этом сказано.
const path = require('path'), dir = path.join(__dirname, '..');
global.window = {};
['settings', 'data', 'roads', 'base-plan'].forEach(f => require(dir + '/js/' + f + '.js'));
const S = require(dir + '/js/solver.js'); window.MilkSolver = S;
const F = require(dir + '/js/fleet.js'); window.MilkFleet = F;
const R = require(dir + '/js/replan.js'); window.MilkReplan = R;
const C = require(dir + '/js/changes.js'); window.MilkChanges = C;
const P = require(dir + '/js/proposal.js');
const { makePage } = require('./fake-page.js');
const D = window.MILK_DATA, L = window.MilkLimits, clone = x => JSON.parse(JSON.stringify(x));
const roads = S.roadsFrom(window.MILK_ROADS), TOTAL = D.orders.reduce((s, o) => s + o.kg, 0);
let fails = 0, checks = 0;
function ok(cond, text) { checks++; if (!cond) { fails++; console.log('  ОШИБКА: ' + text); } }
const fresh = () => ({ depot: D.depot, orders: clone(D.orders), vehicles: clone(D.vehicles), settings: Object.assign({}, window.MILK_SETTINGS), roads });

// ---------- 1. Границы ----------
console.log('1. Границы');
ok(L.num('1e999', 0, 100, 7) === 7 && L.num('abc', 0, 100, 7) === 7 && L.num(null, 0, 100, 7) === 0 && L.num(undefined, 0, 100, 7) === 7, 'не число → запасное значение');
ok(L.num(-5, 0, 100, 7) === 0 && L.num(1e9, 0, 100, 7) === 100 && L.num('2,5', 0, 100, 7) === 2.5, 'за границей → граница, «2,5» → 2,5');
const st0 = window.MILK_SETTINGS;
ok(L.settings(st0) === st0, 'обычные правила не трогаются (тот же объект — эталон не меняется)');
const odd = L.settings(Object.assign({}, st0, { serviceMin: Infinity, minLoadPct: 500, fleetPriority: 'чепуха', fillDownTimes: 'да', shiftMin: -1 }));
ok(odd.serviceMin === st0.serviceMin && odd.minLoadPct === 100 && odd.fleetPriority === 'fewer' && odd.fillDownTimes === false && odd.shiftMin === 0, 'странные правила поправлены');
const inp0 = fresh();
ok(L.input(inp0) === inp0, 'обычные данные расчёта не трогаются');
const fixedOrders = L.orders([{ id: 1, kg: -5, from: 1500 }, { id: 2, kg: 1e12, from: NaN }]);
ok(fixedOrders[0].kg === 0 && fixedOrders[0].from === 1439 && fixedOrders[1].kg === 100000 && fixedOrders[1].from === 0, 'заказы: −5 кг → 0, 1e12 кг → 100 000, 25:00 → 23:59');

// ---------- 2. Решатель и выбор машин ----------
console.log('2. Решатель и выбор машин на странных данных');
function survive(label, mod, expectAll) {
  const inp = fresh(); mod(inp);
  let p;
  try { p = F.solve(inp, { timeMs: 250 }); } catch (e) { ok(false, label + ': упало: ' + e.message); return null; }
  const seen = new Array(p.stops.length).fill(0);
  p.routes.forEach(r => r.seq.forEach(i => seen[i]++)); (p.dropped || []).forEach(i => seen[i]++);
  const nowhere = seen.filter(x => x === 0).length, twice = seen.filter(x => x > 1).length;
  ok(isFinite(p.km) && !twice, label + ': пробег ' + p.km + ', остановок дважды ' + twice);
  if (expectAll !== false) ok(!nowhere, label + ': остановок без машины ' + nowhere);
  else ok(p.problems.length > 0, label + ': машин нет — это видно в «Что не сходится»');
  return p;
}
const numeric = Object.keys(window.MILK_LIMITS).filter(k => k in st0);
for (const k of numeric) for (const v of [-5, 1e9, Infinity, 'abc', '']) survive(k + ' = ' + v, i => { i.settings[k] = v; });
survive('вес 0 у всех', i => i.orders.forEach(o => { o.kg = 0; }));
survive('вес −5', i => { i.orders[0].kg = -5; });
survive('вес 1e9', i => { i.orders[0].kg = 1e9; });
survive('вес бесконечность', i => { i.orders[0].kg = Infinity; });
survive('время 25:00 у всех', i => i.orders.forEach(o => { o.from = 25 * 60; }));
survive('важная точка на 25:00', i => { i.orders[0].from = 1500; i.orders[0].timeExplicit = true; });
survive('важная точка на −1:00', i => { i.orders[0].from = -60; i.orders[0].timeExplicit = true; });
survive('вместимость бесконечность', i => { i.vehicles[0].cap = Infinity; });
survive('вместимость 1e9', i => { i.vehicles[0].cap = 1e9; });
survive('все машины сняты', i => i.vehicles.forEach(v => { v.active = false; }), false);
survive('все машины сняты, «без переработки»', i => { i.settings.fleetPriority = 'overtime'; i.vehicles.forEach(v => { v.active = false; }); }, false);
survive('вместимость 0 у всех', i => i.vehicles.forEach(v => { v.cap = 0; }), false);
survive('ни одной машины', i => { i.vehicles = []; }, false);
survive('ни одного заказа', i => { i.orders = []; });
const one = survive('одна машина', i => i.vehicles.forEach(v => { v.active = v.id === 1; }));
if (one) ok(one.problems.length > 0, 'одна машина на весь груз: перегруз виден в «Что не сходится»');
// Короткая запись плана с мусором (из базы или с другого экрана) не роняет пересчёт.
try {
  const p = S.fromAssignment(fresh(), [{ v: 1, s: [1, 99999, 'x', null] }, { v: 777, s: [2] }, null, { v: 0, s: [3] }]);
  ok(isFinite(p.km), 'мусор в записи плана: пересчёт не упал');
} catch (e) { ok(false, 'мусор в записи плана: упало: ' + e.message); }

// ---------- 3. Список изменений ----------
console.log('3. Список изменений и предложение');
const cur = { input: fresh() }; cur.plan = S.fromAssignment(cur.input, window.MILK_BASE_PLAN.assignment); cur.naive = S.naive(cur.input);
const refuse = (list, why) => { const r = C.check(list, cur.input); ok(!r.ok && r.errors.length, why + ': отказ «' + (r.errors[0] || '') + '»'); };
refuse([{ kind: 'order_kg', orderId: 12, kg: -5 }], '−5 кг');
refuse([{ kind: 'order_kg', orderId: 12, kg: 1e12 }], '1e12 кг');
refuse([{ kind: 'order_kg', orderId: 12, kg: 'много' }], 'вес словами');
refuse([{ kind: 'order_time', orderId: 12, time: '25:00' }], 'время 25:00');
refuse([{ kind: 'setting', key: 'serviceMin', value: Infinity }], 'разгрузка бесконечность');
refuse([{ kind: 'setting', key: 'serviceMin', value: -1 }], 'разгрузка −1');
refuse([{ kind: 'setting', key: 'earliestDepart', value: '25:00' }], 'первый выезд 25:00');
refuse([{ kind: 'scale_kg', factor: 0 }], 'вес ×0');
refuse([{ kind: 'vehicle_off', vehicleId: 99 }], 'машина 99');
refuse([], 'пустой список');
refuse('чепуха', 'не список');
refuse([{ kind: 'breakdown', vehicleId: 3, at: '25:00' }], 'поломка в 25:00');
const allOff = D.vehicles.map(v => ({ kind: 'vehicle_off', vehicleId: v.id }));
let pr;
try { pr = P.make(cur, allOff); } catch (e) { ok(false, 'все 16 машин не выходят: упало: ' + e.message); }
if (pr) {
  ok(pr.ok, 'все 16 машин не выходят: предложение посчитано');
  const variants = pr.variants || [{ plan: pr.plan }];
  variants.forEach((v, n) => {
    let kg = 0; v.plan.routes.forEach(r => r.seq.forEach(i => { kg += v.plan.stops[i].kg; })); (v.plan.dropped || []).forEach(i => { kg += v.plan.stops[i].kg; });
    const lost = v.plan.stops.reduce((s, x) => s + x.kg, 0) - kg;
    ok(n > 0 || lost < 0.5 || v.plan.problems.length, 'вариант ' + (n + 1) + ': вес в машинах ' + Math.round(kg) + ' кг из ' + TOTAL + (lost > 0.5 ? ', остальное видно в «Что не сходится»' : ''));
  });
  const html = P.card(pr);
  ok(!/NaN|Infinity|undefined/.test(html), 'карточка «все машины не выходят» без NaN и бесконечностей');
}
const huge = P.make(cur, [{ kind: 'setting', key: 'serviceMin', value: 100000 }]);
ok(huge.ok && !/NaN|Infinity|undefined/.test(P.card(huge)), 'разгрузка 100 000 мин: предложение посчитано, карточка без NaN');

// ---------- 4. Экран диспетчера ----------
console.log('4. Экран диспетчера: руками в таблицах, «Правилах», «Форс-мажоре», «Что изменилось?»');
(async () => {
  const A = makePage({ storage: {} });
  const tick = () => A.clock.advance(5000);
  await tick();
  const BAD = /NaN|Infinity|undefined/;
  const screen = () => ['kpis', 'routes', 'problems', 'fleet-note', 'proposal', 'incident', 'meta', 'status', 'as-card'].map(id => A.text(id)).join('\n');
  const clean = label => { const s = screen(), m = BAD.exec(s); ok(!m, label + ': на экране нет NaN/Infinity/undefined' + (m ? ' — найдено «' + s.slice(Math.max(0, m.index - 80), m.index + 20) + '»' : '')); };
  const toast = () => A.el('toast').textContent;
  // «Правила»: каждое числовое поле — −5, 1e999, «abc», пусто; потом вернуть как было.
  const fields = (A.text('settings-form').match(/data-key="(\w+)"/g) || []).map(s => s.slice(10, -1)).filter(k => window.MILK_LIMITS[k]);
  ok(fields.length >= 15, 'во вкладке «Правила» числовых полей ' + fields.length);
  for (const key of fields) {
    const isTime = key === 'earliestDepart' || key === 'dayEnd';
    for (const v of isTime ? ['25:00', '', '99:99'] : ['-5', '1e999', 'abc', '']) {
      const t = A.btn({ attrs: { 'data-key': key }, type: isTime ? 'time' : 'number', value: v });
      try { A.fire('settings-form', 'change', t); await tick(); } catch (e) { ok(false, key + ' = «' + v + '»: упало ' + e.message); continue; }
      if (v === '-5') ok(/можно от/.test(toast()), key + ' = −5: поправлено и сказано («' + toast().slice(0, 50) + '»)');
      if (v === 'abc' || v === '' || v === '25:00') ok(/прежнее/.test(toast()), key + ' = «' + v + '»: оставлено прежнее');
    }
    clean('правило ' + key);
  }
  A.fire('btn-reset', 'click'); await tick();
  // Таблица заказов: вес −3, 1e999, пусто; время 25:00.
  const tr = A.btn({ attrs: { 'data-id': '12' } });
  for (const v of ['-3', '1e999', '', '900']) {
    const t = A.btn({ cls: 'kg', value: v, tr }); A.fire('orders-table', 'change', t); await tick();
    ok(['0', '100000', '0', '900'][['-3', '1e999', '', '900'].indexOf(v)] === String(t.value), 'вес заказа «' + v + '» → в поле ' + t.value);
  }
  const tm = A.btn({ cls: 'tm', value: '25:00', tr }); A.fire('orders-table', 'change', tm); await tick();
  ok(/Такого времени не бывает/.test(toast()) && /^\d\d:\d\d$/.test(tm.value), 'время 25:00 в заказе не принято, в поле ' + tm.value);
  clean('таблица заказов');
  // Машины: вместимость −1, 1e999; все машины сняты с линии.
  for (const v of ['-1', '1e999']) { const t = A.btn({ cls: 'veh-cap', attrs: { 'data-id': '1' }, value: v }); A.fire('vehicles-table', 'change', t); await tick(); ok(/можно от/.test(toast()), 'вместимость «' + v + '» → ' + t.value); }
  for (const v of D.vehicles) { const b = A.btn({ cls: 'veh-on', attrs: { 'data-id': String(v.id) } }); b.checked = false; A.fire('vehicles-table', 'change', b); }
  await tick();
  ok(/не помещается|Груз|машин/i.test(A.text('problems')), 'все машины сняты: в «Что не сходится» об этом сказано («' + A.text('problems').replace(/<[^>]+>/g, ' ').trim().slice(0, 60) + '…»)');
  clean('все машины сняты');
  // Кнопки «а если» при всех снятых машинах.
  for (const key of ['normal', 'minus1', 'priority']) {
    try { A.fire('whatif', 'click', A.btn({ attrs: { 'data-whatif': key } })); await tick(); } catch (e) { ok(false, '«а если» ' + key + ' при снятых машинах: упало ' + e.message); }
    clean('«а если» ' + key + ' при снятых машинах');
    A.fire('proposal', 'click', { id: 'prop-cancel' }); await tick();
  }
  A.fire('btn-reset', 'click'); await tick();
  // «Что изменилось?»: пустая фраза, 2 000 знаков, без интернета.
  const say = async text => { A.el('as-text').value = text; A.fire('assistant', 'click', A.btn({ id: 'as-send' })); await tick(); return A.text('as-card'); };
  ok(/Фраза пустая/.test(await say('')), 'пустая фраза: просим написать или добавить строку вручную');
  ok(/Фраза пустая/.test(await say('     ')), 'фраза из пробелов: то же');
  ok(/длиннее 500/.test(await say('машина 3 сломалась '.repeat(106).slice(0, 2000))), 'фраза на 2 000 знаков: просим короче (в поле больше 500 знаков не вводится)');
  A.win.navigator.onLine = false;
  const off = await say('машина 5 не выходит');
  ok(/Нет интернета: модель недоступна/.test(off) && /as-add/.test(off), 'без интернета: «модель недоступна», карточку можно заполнить вручную');
  A.win.navigator.onLine = true;
  clean('команда словами');
  // «Форс-мажор»: время 25:00 и задержка 1e9 минут после утверждения.
  A.fire('btn-approve', 'click'); await tick();
  A.fire('btn-incident', 'click');
  A.fire('fm-body', 'click', A.btn({ attrs: { 'data-type': 'delay' } }));
  A.el('fm-at').value = '25:00'; A.el('fm-delay').value = '1e9';
  A.fire('fm-body', 'click', A.btn({ id: 'fm-go' })); await tick();
  ok(/Такого времени не бывает/.test(toast()), 'форс-мажор в 25:00: время не принято');
  const fmHtml = A.el('fm-body').innerHTML;
  ok(!BAD.test(fmHtml), 'окно «Форс-мажор» без NaN/Infinity после задержки 1e9 минут');
  if (/data-pick/.test(fmHtml)) { A.fire('fm-body', 'click', A.btn({ attrs: { 'data-pick': '0' } })); await tick(); clean('задержка 1e9 минут'); }
  else A.fire('fm-body', 'click', A.btn({ id: 'fm-cancel' }));
  A.fire('btn-reset', 'click'); await tick();
  clean('после сброса');

  console.log(fails ? '\nПРОВАЛЕНО проверок: ' + fails + ' из ' + checks : '\nСтранный ввод: все ' + checks + ' проверок прошли');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('УПАЛО: ' + e.stack); process.exit(1); });
