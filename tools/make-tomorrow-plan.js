// ПЛАН «ЗАВТРА» ЗАРАНЕЕ (16 ноября). Обычный день: те же точки, вес каждого заказа ×0,7, мелкая точка до 250 кг,
// наши допуски выключены — ровно как кнопка «Завтра» на экране (tomorrowData в js/app.js).
// Запуск из корня проекта:  node tools/make-tomorrow-plan.js   (около двух минут)
//
// Зачем: расчёт на экране — перебор от случайного начала, и итог от начала зависит: на этих данных 381–412 км.
// Логист видел 407 км, а предложение «машина 9 не выходит» давало 369 км — меньше машин, а пробег короче.
// Так считается и эталон «Сегодня»: 8 расчётов по 600 встряхиваний (а не по секундам — на любом компьютере
// одинаково), из планов без нарушений берётся самый короткий. Экран берёт его, если данные совпадают.
// Пишет js/tomorrow-plan.js. После изменения исходных данных или правил по умолчанию — запустить снова.
const fs = require('fs'), path = require('path');
const dir = path.join(__dirname, '..');
global.window = {};
['settings', 'data', 'roads'].forEach(f => require(dir + '/js/' + f + '.js'));
const S = require(dir + '/js/solver.js'); window.MilkSolver = S;
const F = require(dir + '/js/fleet.js'), C = require(dir + '/js/changes.js');
const D = window.MILK_DATA, clone = x => JSON.parse(JSON.stringify(x));

const TOMORROW_SMALL_KG = 250;   // то же число, что в js/app.js
const seed = { depot: D.depot, orders: clone(D.orders), vehicles: clone(D.vehicles), settings: clone(window.MILK_SETTINGS), roads: S.roadsFrom(window.MILK_ROADS) };
const input = C.apply(seed, [{ kind: 'scale_kg', factor: 0.7 }]);
input.settings = Object.assign(clone(window.MILK_SETTINGS), { smallStopKg: Math.max(window.MILK_SETTINGS.smallStopKg, TOMORROW_SMALL_KG),
  overtimeToleranceMin: 0, overloadTolerancePct: 0, day: 'tomorrow' });

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8], ROUNDS = 600, SAFETY_MS = 120000;
let best = null, bestSeed = 0;
SEEDS.forEach(s => {
  const p = F.solve(input, { timeMs: SAFETY_MS, rounds: ROUNDS, seed: s });
  console.log('seed ' + s + ': ' + p.km.toFixed(1) + ' км, машин ' + p.used + ', нарушений ' + p.problems.length);
  if (!best || p.problems.length < best.problems.length || (p.problems.length === best.problems.length && p.km < best.km - 1e-6)) { best = p; bestSeed = s; }
});
const assignment = S.toAssignment(best), again = S.fromAssignment(input, assignment);
if (Math.abs(again.km - best.km) > 0.01 || again.problems.length !== best.problems.length || again.leftover) {
  console.log('ОШИБКА: план из записи не совпал с расчётом'); process.exit(1);
}
const summary = { km: Math.round(best.km), used: best.used, problems: best.problems.length, seed: bestSeed, rounds: ROUNDS,
  kg: input.orders.reduce((a, o) => a + o.kg, 0), made: new Date().toISOString().slice(0, 10), dataVersion: D.version };
fs.writeFileSync(dir + '/js/tomorrow-plan.js',
  '// ПЛАН «ЗАВТРА» (обычный день), посчитан заранее скриптом tools/make-tomorrow-plan.js, руками не править.\n' +
  '// assignment — для каждой машины (v) номера первых заказов её остановок по порядку (s). Экран берёт его, если данные совпадают.\n' +
  'window.MILK_TOMORROW_PLAN = ' + JSON.stringify({ assignment: assignment, summary: summary }) + ';\n');
console.log('Записано js/tomorrow-plan.js: seed ' + bestSeed + ', ' + summary.km + ' км, машин ' + summary.used + ', нарушений ' + summary.problems);
