// Проверка исходных данных и эталонного плана. Запуск: node tests/check-base.js
// Что проверяем (всё на исходных данных заказчика и по таблице дорог, как на сайте):
//   — остановок 198: разные организации на одном адресе — одна остановка, повтор той же организации — отдельная;
//   — эталонный план (js/base-plan.js): каждая остановка ровно в одной машине, вес 63 630 кг,
//     все 10 важных точек получают товар вовремя, нарушений столько, сколько записано при расчёте эталона;
//   — план, пересчитанный по короткой записи эталона, даёт те же числа, что записаны в файле.
const dir = process.argv[2] || require('path').join(__dirname, '..');
global.window = {};
require(dir + '/js/settings.js'); require(dir + '/js/data.js'); require(dir + '/js/roads.js'); require(dir + '/js/base-plan.js');
const S = require(dir + '/js/solver.js');
const D = window.MILK_DATA, BASE = window.MILK_BASE_PLAN, st = Object.assign({}, window.MILK_SETTINGS);
const clone = x => JSON.parse(JSON.stringify(x));
const clock = m => { m = Math.round(m); return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
const input = { depot: D.depot, orders: clone(D.orders), vehicles: clone(D.vehicles), settings: st, roads: S.roadsFrom(window.MILK_ROADS) };
let fails = 0;
function ok(cond, text) { if (!cond) { fails++; console.log('  ОШИБКА: ' + text); } }

// ---------- 1. Остановки ----------
const P = S.core.prepare(input);
console.log('Остановок: ' + P.stops.length + ', важных: ' + P.stops.filter(s => s.important).length + ', повторов: ' + P.stops.filter(s => s.repeat).length);
ok(P.stops.length === 198, 'остановок ' + P.stops.length + ', ждали 198');
ok(P.stops.filter(s => s.important).length === 10, 'важных остановок не 10');
ok(st.fillDownTimes === false, 'по умолчанию время протягивается вниз, а должно действовать только у 10 важных строк');
// Шесть магазинов есть в обеих частях списка: у каждого две остановки, каждая со своим заказом.
const REPEATS = ['Доброном № 595 (Горького)', 'Магазин №2/Домбровского/', 'Магазин (РУП Белоруснефть) Глухова',
  'Маг №1 /Гродненские прысмаки/', 'Маг №3 "Гродненские прысмаки"', 'Маг"Евроопт"(Суворова) № 507'];
REPEATS.forEach(name => {
  const stops = P.stops.filter(s => s.orders.some(o => o.name === name));
  ok(stops.length === 2, name + ': остановок ' + stops.length + ', ждали 2');
  stops.forEach(s => ok(s.orders.filter(o => o.name === name).length === 1, name + ': два заказа в одной остановке'));
});
// Разные организации по одному адресу — одна остановка (на проспекте Космонавтов 100 их четыре, одна из них важная).
const kosm = P.stops.filter(s => s.address === 'проспект Космонавтов 100');
ok(kosm.length === 1 && kosm[0].orders.length === 4 && kosm[0].important, 'Космонавтов 100 не одна остановка из 4 заказов');
// Странные данные не роняют сборку остановок.
const odd = clone(input.orders.slice(0, 5));
odd[0].name = null; odd[1].address = '  ПРОСПЕКТ   Космонавтов 100 '; odd[2].from = 'abc'; odd[2].timeExplicit = true; odd[3].kg = -5;
const Podd = S.core.prepare(Object.assign({}, input, { orders: odd }));
ok(Podd.stops.length >= 1 && Podd.stops.every(s => isFinite(s.from) && isFinite(s.due)), 'странные данные испортили остановки');

// ---------- 2. Эталонный план ----------
ok(!!BASE && Array.isArray(BASE.assignment), 'нет файла js/base-plan.js');
const plan = S.fromAssignment(input, BASE.assignment), sum = BASE.summary;
let longest = 0;
plan.routes.forEach(r => { if (r.seq.length) longest = Math.max(longest, st.loadMin + r.back - r.depart); });
console.log('Эталон: ' + plan.km.toFixed(1) + ' км, машин ' + plan.used + ', нарушений ' + plan.problems.length +
  ', самая длинная смена ' + clock(longest) + ', по дорогам: ' + plan.byRoad + ', «по списку» ' + Math.round(S.naive(input).km) + ' км');
ok(plan.byRoad, 'эталон посчитан не по дорогам');
ok(plan.leftover === 0, 'в эталоне нет ' + plan.leftover + ' остановок');
const seen = new Array(plan.stops.length).fill(0); let kg = 0;
plan.routes.forEach(r => r.seq.forEach(i => { seen[i]++; kg += plan.stops[i].kg; }));
ok(seen.every(x => x === 1), 'остановка не ровно в одной машине');
ok(Math.abs(kg - 63630) < 0.5, 'вес ' + kg + ', ждали 63 630');
ok(plan.stopsTotal === 198, 'в эталоне остановок ' + plan.stopsTotal);
// Важные точки: разгрузка не раньше указанного времени и не позже, чем через час после него.
let onTime = 0;
plan.routes.forEach(r => r.stops.forEach(x => {
  const s = plan.stops[x.stop];
  if (!s.important) return;
  const good = x.start >= s.from - 0.01 && x.start <= s.due + 0.01;
  if (good) onTime++;
  console.log('  ' + (good ? 'вовремя ' : 'НЕ ВОВРЕМЯ ') + clock(x.start) + ' (окно ' + clock(s.from) + '–' + clock(s.due) + ') ' + s.orders.map(o => o.name).join(' + ') + ', ' + r.vehicle.name);
}));
ok(onTime === 10, 'вовремя только ' + onTime + ' важных точек из 10');
// Нарушений столько, сколько записано при расчёте эталона (в идеале ноль), и остальные числа совпадают.
ok(plan.problems.length === sum.problems, 'нарушений ' + plan.problems.length + ', в записи эталона ' + sum.problems + ': ' + plan.problems.join('; '));
ok(Math.abs(plan.km - sum.kmExact) < 0.06, 'км ' + plan.km.toFixed(1) + ', в записи ' + sum.kmExact);
ok(plan.used === sum.used, 'машин ' + plan.used + ', в записи ' + sum.used);
ok(plan.stopsTotal === sum.stops, 'остановок ' + plan.stopsTotal + ', в записи ' + sum.stops);
ok(Math.round(longest) === sum.longestMin, 'самая длинная смена ' + Math.round(longest) + ', в записи ' + sum.longestMin);
ok(Math.round(S.naive(input).km) === sum.naiveKm, '«по списку» ' + Math.round(S.naive(input).km) + ', в записи ' + sum.naiveKm);
// Запись → план → запись не меняется (так эталон увидят другие экраны и водители).
ok(JSON.stringify(S.toAssignment(plan)) === JSON.stringify(BASE.assignment), 'запись эталона изменилась после пересчёта');

console.log(fails ? '\nОшибок: ' + fails : '\nВсе проверки пройдены');
process.exit(fails ? 1 : 0);
