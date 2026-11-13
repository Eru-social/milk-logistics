// Проверка перестроения кодом. Запуск: node tests/check-replan.js
const dir = process.argv[2] || require('path').join(__dirname, '..');
global.window = {};
require(dir + '/js/settings.js'); require(dir + '/js/data.js'); require(dir + '/js/roads.js');
const S = require(dir + '/js/solver.js'), R = require(dir + '/js/replan.js');
const D = window.MILK_DATA, st = Object.assign({}, window.MILK_SETTINGS);
const clone = x => JSON.parse(JSON.stringify(x));
const clock = m => { m = Math.round(m); return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
const input = { depot: D.depot, orders: clone(D.orders), vehicles: clone(D.vehicles), settings: st, roads: S.roadsFrom(window.MILK_ROADS) };  // считаем по дорогам, как сайт
let fails = 0;
function ok(cond, text) { if (!cond) { fails++; console.log('  ОШИБКА: ' + text); } }

function check(plan, label) {
  // каждая остановка ровно один раз: в маршруте или в списке «не доставим»; вес сходится
  const seen = new Array(plan.stops.length).fill(0); let kg = 0;
  plan.routes.forEach(r => r.seq.forEach(i => { seen[i]++; kg += plan.stops[i].kg; }));
  plan.dropped.forEach(i => { seen[i]++; kg += plan.stops[i].kg; });
  ok(seen.every(x => x === 1), label + ': остановка не ровно в одном месте: ' + seen.map((x, i) => x !== 1 ? i + '×' + x : '').filter(Boolean).join(' '));
  ok(Math.abs(kg - 63630) < 0.5, label + ': вес ' + kg);
  plan.routes.forEach(r => {
    ok(r.stops.length === r.seq.length, label + ': расписание не совпало с маршрутом');
    let prev = -1;
    r.stops.forEach(x => { ok(x.start >= prev - 0.2, label + ': время идёт назад у ' + r.vehicle.name + ' ' + clock(prev) + '>' + clock(x.start)); prev = x.start; });
    if (r.broken) ok(r.seq.length === (r.cut || 0), label + ': у сломанной машины остались точки');
  });
}
function same(a, b, label) {
  ok(JSON.stringify(a.routes.map(r => r.seq)) === JSON.stringify(b.routes.map(r => r.seq)), label + ': маршруты разные');
  ok(Math.abs(a.km - b.km) < 0.01, label + ': км ' + a.km + ' / ' + b.km);
  a.routes.forEach((r, k) => {
    ok(Math.abs(r.back - b.routes[k].back) < 0.01, label + ': возврат ' + r.vehicle.name);
    r.stops.forEach((x, i) => ok(Math.abs(x.start - b.routes[k].stops[i].start) < 0.01, label + ': время точки ' + r.vehicle.name + ' #' + i));
  });
}
function show(res) {
  res.variants.forEach(v => {
    console.log('\n  [' + v.name + '] ' + v.title + '  (' + v.plan.ms + ' мс)');
    v.lines.forEach(l => console.log('    · ' + l));
  });
}

const t0 = Date.now();
const plan0 = S.solve(input);
console.log('План: ' + Math.round(plan0.km) + ' км, машин ' + plan0.used + ', проблем ' + plan0.problems.length + ', ' + (Date.now() - t0) + ' мс; по дорогам: ' + plan0.byRoad);
const approved = { assignment: S.toAssignment(plan0), live: null };
const base = S.fromAssignment(input, approved.assignment);
plan0.dropped = plan0.dropped || []; check(base, 'исходный');
same(plan0, base, 'исходный план после записи');

// ---------- 1. Поломка ----------
console.log('\n=== 1. Поломка машины 7 в 10:40 ===');
console.log('  ' + R.status(base, 7, 640, null).text);
let res = R.propose(input, base, { type: 'breakdown', vehicleId: 7, at: 640 }, null);
ok(res.ok, 'поломка: ' + res.message); show(res);
res.variants.forEach(v => {
  check(v.plan, 'поломка/' + v.key);
  // сделанное не изменилось
  v.plan.routes.forEach((r, k) => {
    for (let i = 0; i < r.cut; i++) {
      ok(r.seq[i] === base.routes[k].seq[i], 'поломка: изменилась сделанная точка');
      ok(Math.abs(r.stops[i].start - base.routes[k].stops[i].start) < 0.06, 'поломка: изменилось время сделанной точки');
    }
    // чужой груз не перекладываем: всё, что было у исправной машины, осталось у неё
    if (!r.broken) base.routes[k].seq.forEach(i => ok(r.seq.indexOf(i) >= 0, 'поломка: точка ушла от исправной машины ' + r.vehicle.name));
    // перегрузка стоит раньше всех забранных точек, и после снимка
    r.stops.forEach(x => { if (x.pickup) ok(x.pickup.arrive >= 640 - 0.01 && x.pickup.end <= x.arrive + 0.01, 'поломка: перегрузка не на месте'); });
  });
  // тот же план получается из короткой записи (так его увидят другие экраны и водитель), в том числе после базы
  const again = S.fromAssignment(input, clone(v.assignment), null, clone(v.live));
  check(again, 'поломка/' + v.key + '/повтор'); same(v.plan, again, 'поломка/' + v.key + ' после записи');
});
const A = res.variants[0];
ok(A.plan.dropped.length === 0, 'вариант «довезти всё» что-то не довёз');
if (res.variants.length > 1) ok(res.variants[res.variants.length - 1].stats.overtime <= A.stats.overtime, 'вариант без переработки хуже по переработке');

// ---------- 2. Второе происшествие поверх первого: задержка ----------
console.log('\n=== 2. Потом машина 3 задерживается на 40 мин в 11:10 ===');
const base2 = S.fromAssignment(input, clone(A.assignment), null, clone(A.live));
console.log('  ' + R.status(base2, 3, 670, null).text);
let res2 = R.propose(input, base2, { type: 'delay', vehicleId: 3, at: 670, delayMin: 40 }, null);
ok(res2.ok, 'задержка: ' + res2.message); show(res2);
res2.variants.forEach(v => { check(v.plan, 'задержка'); same(v.plan, S.fromAssignment(input, clone(v.assignment), null, clone(v.live)), 'задержка после записи'); });
const r3a = base2.routes.find(r => r.vehicle.id === 3), r3b = res2.variants[0].plan.routes.find(r => r.vehicle.id === 3);
if (r3a.cut < r3a.seq.length || !r3a.returned) ok(r3b.back >= r3a.back + 20, 'задержка: машина не вернулась позже (' + clock(r3a.back) + ' → ' + clock(r3b.back) + ')');

// ---------- 3. Третье: точка не принимает ----------
console.log('\n=== 3. Потом у машины 5 точка не принимает товар (11:30) ===');
const base3 = S.fromAssignment(input, clone(res2.variants[0].assignment), null, clone(res2.variants[0].live));
const s5 = R.status(base3, 5, 690, null);
console.log('  ' + s5.text + ' Впереди точек: ' + s5.remaining.length);
if (s5.remaining.length) {
  for (const action of ['retry', 'drop']) {
    const r5 = R.propose(input, base3, { type: 'stop', vehicleId: 5, at: 690, orderId: s5.remaining[0].orderId, action }, null);
    ok(r5.ok, 'точка/' + action + ': ' + r5.message); show(r5);
    r5.variants.forEach(v => { check(v.plan, 'точка/' + action); same(v.plan, S.fromAssignment(input, clone(v.assignment), null, clone(v.live)), 'точка после записи'); });
    if (action === 'drop') ok(r5.variants[0].plan.dropped.length === 1, 'точка: не снята');
  }
}

// ---------- 4. Поломки в разное время у каждой машины ----------
console.log('\n=== 4. Поломка каждой машины в разное время ===');
let worst = 0;
for (const v of D.vehicles) for (const T of [240, 330, 420, 540, 640, 720, 800, 900]) {
  const r = R.propose(input, base, { type: 'breakdown', vehicleId: v.id, at: T }, null);
  if (!r.ok) continue;
  r.variants.forEach(x => { check(x.plan, 'поломка ' + v.id + '@' + clock(T) + '/' + x.key); worst = Math.max(worst, x.plan.ms);
    same(x.plan, S.fromAssignment(input, clone(x.assignment), null, clone(x.live)), 'поломка ' + v.id + '@' + clock(T) + ' после записи'); });
}
console.log('  самый долгий расчёт: ' + worst + ' мс');

// ---------- 5. Странные данные ----------
console.log('\n=== 5. Странные данные ===');
const odd = [
  ['нет такой машины', { type: 'breakdown', vehicleId: 99, at: 640 }],
  ['время ночью', { type: 'breakdown', vehicleId: 7, at: 0 }],
  ['время после конца дня', { type: 'breakdown', vehicleId: 7, at: 1400 }],
  ['задержка 0', { type: 'delay', vehicleId: 2, at: 600, delayMin: 0 }],
  ['задержка 600', { type: 'delay', vehicleId: 2, at: 600, delayMin: 600 }],
  ['точки нет', { type: 'stop', vehicleId: 2, at: 600, orderId: 99999, action: 'retry' }],
  ['вид неизвестен', { type: 'meteor', vehicleId: 2, at: 600 }],
  ['пустое', { vehicleId: 2 }]
];
odd.forEach(([name, inc]) => { try { const r = R.propose(input, base, inc, null); console.log('  ' + name + ': ' + (r.ok ? 'посчитано (' + r.variants[0].title + ')' : r.message)); r.variants.forEach(x => check(x.plan, name)); } catch (e) { fails++; console.log('  ' + name + ': УПАЛО ' + e.stack); } });
// после поломки логист снимает машину с линии и меняет заказ: экран не должен падать
try {
  const inp2 = clone(Object.assign({}, input, { roads: null })); inp2.roads = input.roads; inp2.vehicles[2].active = false; inp2.orders[10].kg = 0; inp2.orders[50].kg = 5000;
  inp2.vehicles.push({ id: 17, name: 'Машина 17 · 4 т', cap: 4000, active: true });
  const p = S.fromAssignment(inp2, clone(A.assignment), null, clone(A.live));
  console.log('  правки данных после поломки: план показан, машин ' + p.routes.length + ', проблем ' + p.problems.length);
  const r = R.propose(inp2, p, { type: 'breakdown', vehicleId: 9, at: 700 }, null);
  console.log('  ещё одна поломка поверх: ' + (r.ok ? r.variants[0].title : r.message));
} catch (e) { fails++; console.log('  УПАЛО ' + e.stack); }

console.log('\n' + (fails ? 'ОШИБОК: ' + fails : 'Все проверки пройдены'));
