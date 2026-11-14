// Обычный день (часть машин в гараже), поломка в нём и отметки водителей.
// Обычный день — те же точки, что в файле заказчика, но вес каждого заказа ×0,7 (округление до 10 кг, не меньше 10 кг):
// в файле написано, что тоннаж меняется ежедневно. Раньше здесь пропадал каждый третий заказ — это приукрашивало
// картину: меньше точек — меньше разгрузок и времени. План считается так же, как на сайте: машины по весу (js/fleet.js).
const dir = process.argv[2] || require('path').join(__dirname, '..');
global.window = {};
require(dir + '/js/settings.js'); require(dir + '/js/data.js'); require(dir + '/js/roads.js');
const S = require(dir + '/js/solver.js'), F = require(dir + '/js/fleet.js'), R = require(dir + '/js/replan.js');
const D = window.MILK_DATA, st = Object.assign({}, window.MILK_SETTINGS);
const clone = x => JSON.parse(JSON.stringify(x));
const input = { depot: D.depot, orders: clone(D.orders), vehicles: clone(D.vehicles), settings: st, roads: S.roadsFrom(window.MILK_ROADS) };  // считаем по дорогам, как сайт
input.orders.forEach(o => { o.kg = Math.max(10, Math.round(o.kg * 0.7 / 10) * 10); });
const plan = F.solve(input);
console.log('Обычный день: ' + Math.round(plan.km) + ' км, машин ' + plan.used + ' из 16, проблем ' + plan.problems.length);
console.log(F.explain(plan, input).text);
const base = S.fromAssignment(input, S.toAssignment(plan));
const busy = base.routes.filter(r => r.seq.length).map(r => r.vehicle.id);
for (const id of busy.slice(0, 3)) {
  const r = base.routes.find(x => x.vehicle.id === id), T = Math.round((r.depart + r.back) / 2);
  const res = R.propose(input, base, { type: 'breakdown', vehicleId: id, at: T }, null);
  console.log('\n' + R.status(base, id, T, null).text);
  res.variants.forEach(v => { console.log('  [' + v.name + '] ' + v.title); v.lines.forEach(l => console.log('    · ' + l)); });
}
// отметки водителя: водитель машины busy[0] отметил первые две точки, хотя по плану ещё рано
const id = busy[0], r = base.routes.find(x => x.vehicle.id === id), marks = {};
marks[id + ':' + base.stops[r.seq[0]].orders[0].id] = 'done';
marks[id + ':' + base.stops[r.seq[1]].orders[0].id] = 'arrived';
const T = R.suggestTime(base, id, marks, 15 * 60 + 40);
console.log('\nВремя по отметкам водителя: ' + T + ' мин; без отметок в 15:40: ' + R.suggestTime(base, id, null, 940) + '; в 08:00: ' + R.suggestTime(base, id, null, 480));
console.log(R.status(base, id, T, marks).text);
const res = R.propose(input, base, { type: 'breakdown', vehicleId: id, at: T }, marks);
console.log(res.ok ? res.variants[0].lines[0] : res.message);
