// Проверка выбора машин по весу (js/fleet.js). Запуск: node tests/check-fleet.js
// Что проверяем (по таблице дорог, как на сайте):
//   1. День максимальной загрузки: нужны все 16 машин, план тот же, что эталонный.
//   2. Обычный день (вес каждого заказа ×0,7, округление до 10 кг, не меньше 10 кг): 11 машин, недогруженных нет,
//      вес сходится, каждая остановка ровно в одной машине, малая машина в наборе (есть заказы в центре).
//   3. Переключатель «Что важнее»: «без переработки» — это прежний решатель как есть.
//   4. Резервная машина из гаража выходит при поломке в идущем дне.
//   5. Странные случаи не роняют расчёт.
const dir = process.argv[2] || require('path').join(__dirname, '..');
global.window = {};
require(dir + '/js/settings.js'); require(dir + '/js/data.js'); require(dir + '/js/roads.js'); require(dir + '/js/base-plan.js');
const S = require(dir + '/js/solver.js'), F = require(dir + '/js/fleet.js'), R = require(dir + '/js/replan.js');
const D = window.MILK_DATA, BASE = window.MILK_BASE_PLAN, DEF = window.MILK_SETTINGS;
const clone = x => JSON.parse(JSON.stringify(x));
const roads = S.roadsFrom(window.MILK_ROADS);
function make(change) {
  const input = { depot: D.depot, orders: clone(D.orders), vehicles: clone(D.vehicles), settings: Object.assign({}, DEF), roads: roads };
  if (change) change(input);
  return input;
}
// Обычный день: те же точки, вес на 30% меньше (в файле заказчика: «тоннаж меняется ежедневно»).
function lighter(input) { input.orders.forEach(o => { o.kg = Math.max(10, Math.round(o.kg * 0.7 / 10) * 10); }); }
let fails = 0;
function ok(cond, text) { if (!cond) { fails++; console.log('  ОШИБКА: ' + text); } }
// Каждая остановка ровно в одной машине, вес плана равен весу заказов.
function whole(plan, input, label) {
  const seen = new Array(plan.stops.length).fill(0); let kg = 0, want = 0;
  plan.routes.forEach(r => r.seq.forEach(i => { seen[i]++; kg += plan.stops[i].kg; }));
  input.orders.forEach(o => { if (o.kg > 0) want += o.kg; });
  ok(seen.every(x => x === 1), label + ': остановка не ровно в одной машине');
  ok(Math.abs(kg - want) < 0.5, label + ': вес ' + kg + ', ждали ' + want);
}
function stats(p) {
  const busy = p.routes.filter(r => r.seq.length), n = busy.map(r => r.seq.length);
  let ot = 0, max = 0, load = 0;
  busy.forEach(r => { load += r.loadPct; if (r.overtimeBad) ot += r.overtime; max = Math.max(max, r.overtime); });
  return 'машин ' + p.used + ', средняя загрузка ' + (busy.length ? Math.round(load / busy.length) : 0) + '%, недогруженных ' + p.underloaded +
    ', переработка всего ' + Math.round(ot) + ' мин, у самого занятого ' + Math.round(max) + ' мин, точек ' +
    (n.length ? Math.min(...n) + '–' + Math.max(...n) : '0') + ', ' + p.km.toFixed(1) + ' км, расчёт ' + (p.ms / 1000).toFixed(1) + ' с';
}

// ---------- 1. День максимальной загрузки ----------
console.log('=== 1. День максимальной загрузки ===');
{
  const input = make(), pick = F.choose(input);
  console.log('  по весу: ' + pick.vehicles.length + ' машин, груз ' + pick.kg + ' из ' + pick.cap + ' кг');
  ok(pick.all && pick.vehicles.length === 16, 'в день максимальной загрузки выбраны не все 16 машин');
  // С теми же seed и числом встряхиваний, что у эталона, план должен совпасть с эталоном до точки.
  const p = F.solve(input, { seed: BASE.summary.seed, rounds: BASE.summary.rounds, timeMs: 120000 });
  ok(JSON.stringify(S.toAssignment(p)) === JSON.stringify(BASE.assignment), 'план не совпал с эталонным');
  ok(p.used === 16 && Math.abs(p.km - BASE.summary.kmExact) < 0.06, 'числа не как у эталона: ' + p.km.toFixed(1) + ' км, машин ' + p.used);
  console.log('  ' + stats(p) + '\n  ' + F.explain(p, input).text);
}

// ---------- 2. Обычный день ----------
console.log('\n=== 2. Обычный день (вес ×0,7) ===');
const normal = make(lighter);
const pick = F.choose(normal);
console.log('  по весу: машины ' + pick.vehicles.map(v => v.id).join(', ') + ' — ' + pick.kg + ' кг в ' + pick.cap + ' кг вместимости');
ok(pick.vehicles.length === 11, 'по весу выбрано ' + pick.vehicles.length + ' машин, ждали 11');
ok(pick.vehicles.some(v => v.cap <= DEF.centerMaxCap), 'есть заказы в центре, а малой машины в наборе нет');
const plan = F.solve(normal);
console.log('  меньше машин:    ' + stats(plan));
const note = F.explain(plan, normal);
console.log('  ' + note.text + (note.overtimeHint ? '\n  подсказка: без переработки нужно больше машин' : ''));
ok(plan.used === 11, 'на линии ' + plan.used + ' машин, ждали 11');
ok(plan.underloaded === 0, 'недогруженных машин: ' + plan.underloaded);
ok(plan.routes.every(r => !r.overloadBad), 'перегруз сверх допуска');
ok(plan.routes.length === 16 && plan.routes.filter(r => !r.seq.length).length === 5, 'невыбранные машины не попали в план «в гараже»');
ok(/11 из 16/.test(note.text) && /В гараже:/.test(note.text), 'в объяснении нет «11 из 16» или «В гараже»');
ok(plan.ms <= 2600, 'расчёт ' + plan.ms + ' мс, дольше прежнего запаса 2,5 с');
whole(plan, normal, 'обычный день');
// Переработка видна, а не спрятана: если она есть, она в списке «Что не сходится» и есть подсказка.
const over = plan.routes.filter(r => r.overtimeBad);
ok(over.every(r => plan.problems.some(t => t.indexOf(r.vehicle.name + ': переработка') === 0)), 'переработка не попала в список нарушений');
ok(note.overtimeHint === over.length > 0, 'подсказка про второй вариант показана невпопад');

// ---------- 3. Переключатель «Что важнее» ----------
console.log('\n=== 3. Переключатель «Что важнее, если всё сразу не сходится» ===');
{
  const input = make(lighter); input.settings.fleetPriority = 'overtime';
  const p = F.solve(input);
  console.log('  без переработки: ' + stats(p) + '\n  ' + F.explain(p, input).text);
  ok(p.fleet.mode === 'overtime', 'режим «без переработки» не включился');
  // Ограничиваем число встряхиваний, а не секунды: тогда результат не зависит от скорости компьютера и его можно сравнить.
  const a = F.solve(input, { rounds: 10, timeMs: 60000 }), b = S.solve(input, { rounds: 10, timeMs: 60000 });
  ok(JSON.stringify(S.toAssignment(a)) === JSON.stringify(S.toAssignment(b)), '«без переработки» считает не как прежний решатель');
  input.settings.fleetPriority = 'fewer';
  ok(F.solve(input).used === 11, 'обратно на «меньше машин» — не 11 машин');
  // Время разгрузки 20 минут вместо 30: машин столько же, смотрим, уложатся ли смены.
  const quick = make(lighter); quick.settings.serviceMin = 20;
  console.log('  разгрузка 20 мин, меньше машин: ' + stats(F.solve(quick)));
}


// ---------- 4. Резервная машина при поломке ----------
// План обычного дня утверждён, машины в рейсе; самая загруженная ломается посреди маршрута.
console.log('\n=== 4. Поломка в обычный день: резерв из гаража ===');
{
  const base = S.fromAssignment(normal, S.toAssignment(plan));
  const garage = base.routes.filter(r => !r.seq.length).map(r => r.vehicle.id);
  const busy = base.routes.filter(r => r.seq.length).sort((x, y) => y.seq.length - x.seq.length)[0];
  const T = Math.round((busy.depart + busy.back) / 2);
  const res = R.propose(normal, base, { type: 'breakdown', vehicleId: busy.vehicle.id, at: T }, null);
  ok(res.ok, 'поломка не посчиталась: ' + res.message);
  if (res.ok) {
    const v = res.variants[0];
    console.log('  [' + v.name + '] ' + v.title); v.lines.forEach(l => console.log('    · ' + l));
    const reserve = v.plan.routes.filter(r => garage.indexOf(r.vehicle.id) >= 0 && r.seq.length);
    ok(reserve.length > 0, 'ни одна машина из гаража не вышла на помощь');
    ok(v.lines.some(l => /резервная, стояла в гараже/.test(l)), 'в объяснении нет «резервная, стояла в гараже»');
    // Резерв стоит на заводе и выезжает не раньше поломки.
    reserve.forEach(r => ok(r.depart >= T, 'резервная машина ' + r.vehicle.id + ' выехала раньше поломки'));
    const seen = new Array(v.plan.stops.length).fill(0);
    v.plan.routes.forEach(r => r.seq.forEach(i => seen[i]++)); v.plan.dropped.forEach(i => seen[i]++);
    ok(seen.every(x => x === 1), 'после поломки остановка не ровно в одном месте');
  }
}

// ---------- 5. Странные случаи ----------
console.log('\n=== 5. Странные случаи ===');
const odd = [
  ['заказов нет', i => i.orders.forEach(o => { o.kg = 0; })],
  ['один заказ', i => i.orders.forEach((o, k) => { if (k) o.kg = 0; })],
  ['груза больше, чем вмещают все машины', i => i.orders.forEach(o => { o.kg *= 2; })],
  ['заказы в центре, малая машина снята', i => { lighter(i); i.vehicles.forEach(v => { if (v.cap <= 1500) v.active = false; }); }],
  ['все машины сняты', i => i.vehicles.forEach(v => { v.active = false; })],
  ['машины с нулевой и отрицательной вместимостью', i => { lighter(i); i.vehicles[0].cap = 0; i.vehicles[1].cap = -100; delete i.vehicles[2].active; }],
  ['все машины одной вместимости', i => { lighter(i); i.vehicles.forEach(v => { v.cap = 4000; }); }],
  ['неизвестное значение переключателя', i => { lighter(i); i.settings.fleetPriority = 'чепуха'; }]
];
odd.forEach(([name, change]) => {
  try {
    const input = make(change), p = F.solve(input), e = F.explain(p, input), pk = F.choose(input);
    console.log('  ' + name + ': машин ' + p.used + ' (по весу ' + pk.vehicles.length + '), нарушений ' + p.problems.length +
      ', ' + (p.ms / 1000).toFixed(1) + ' с\n    ' + e.text);
    ok(typeof e.text === 'string' && e.text.length > 0, name + ': нет объяснения');
    ok(p.ms <= 2600, name + ': расчёт ' + p.ms + ' мс, дольше запаса');
    if (input.vehicles.some(v => v.active !== false && v.cap > 0)) whole(p, input, name);
  } catch (err) { fails++; console.log('  ОШИБКА: ' + name + ' уронил расчёт: ' + err.stack); }
});
{
  const heavy = make(i => i.orders.forEach(o => { o.kg *= 2; })), p = F.solve(heavy);
  ok(p.used === 16 && p.problems.some(t => /не помещается/.test(t)), 'груз больше вместимости: не все машины или нет предупреждения');
  const noSmall = make(i => { lighter(i); i.vehicles.forEach(v => { if (v.cap <= 1500) v.active = false; }); });
  ok(/малой машины/.test(F.explain(F.solve(noSmall), noSmall).text), 'малая машина снята — в объяснении об этом ни слова');
  const empty = make(i => i.orders.forEach(o => { o.kg = 0; }));
  ok(F.solve(empty).used === 0, 'заказов нет, а машины выехали');
  const one = make(i => i.orders.forEach((o, k) => { if (k) o.kg = 0; }));
  ok(F.solve(one).used === 1, 'один заказ — не одна машина');
}

console.log(fails ? '\nОшибок: ' + fails : '\nВсе проверки пройдены');
process.exit(fails ? 1 : 0);

