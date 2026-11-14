// ЭТАЛОННЫЙ ПЛАН. Считает план на исходных данных заказчика по таблице дорог — не спеша, около минуты.
// Запуск из корня проекта:  node tools/make-base-plan.js
//
// Зачем: на экране решатель считает 2,5 секунды, и на медленном ноутбуке успевает меньше, чем на быстром.
// Тогда числа на экране расходятся с числами на слайде. В жизни план на завтра считают вечером,
// спешить некуда. Поэтому один раз считаем «эталон» с большим запасом времени и показываем его:
//   — кнопка «Сбросить демо» возвращает его из базы как черновик (функция reset_demo());
//   — без базы экран берёт его копию из файла js/base-plan.js;
//   — «Пересчитать» на тех же данных не даёт план хуже эталона (экран сравнивает и берёт лучший).
//
// Как считается: несколько расчётов с разными начальными числами (seed) и большим числом «встряхиваний».
// Каждый расчёт ограничен числом встряхиваний, а не секундами, поэтому результат не зависит от скорости
// компьютера: на любом компьютере получится тот же план. Из планов без нарушений берём план с наименьшим пробегом.
// Если без нарушений не нашлось ни одного — берём план с наименьшим числом нарушений и честно пишем их.
//
// Что пишет:
//   js/base-plan.js   — копия эталона для работы без базы и для проверок;
//   tools/base-plan.sql — запрос, который кладёт эталон в базу (таблица base_plan). Его применяют миграцией.
const fs = require('fs'), path = require('path');
const dir = path.join(__dirname, '..');
global.window = {};
require(dir + '/js/settings.js'); require(dir + '/js/data.js'); require(dir + '/js/roads.js');
const S = require(dir + '/js/solver.js');
// Считаем так же, как экран: сначала машины по весу (js/fleet.js), потом маршруты. На исходных данных
// по весу нужны все 16 машин, поэтому это ровно прежний расчёт решателя (проверка tests/check-fleet.js, часть 1).
const F = require(dir + '/js/fleet.js');
const D = window.MILK_DATA, st = Object.assign({}, window.MILK_SETTINGS);
const roads = S.roadsFrom(window.MILK_ROADS);
const input = { depot: D.depot, orders: D.orders, vehicles: D.vehicles, settings: st, roads: roads };

const SEEDS = [1, 2, 3, 4, 5];       // пять расчётов
const ROUNDS = 600;                  // встряхиваний в каждом (на экране — 60)
const SAFETY_MS = 120000;            // страховка на очень медленный компьютер: дольше 2 минут один расчёт не идёт

function longest(p) {
  let m = 0;
  p.routes.forEach(r => { if (r.seq.length) m = Math.max(m, st.loadMin + r.back - r.depart); });
  return m;
}
// «Нарушения» — как на экране: то, что попало в список проблем плана.
function better(a, b) {
  if (!b) return true;
  if (a.problems.length !== b.problems.length) return a.problems.length < b.problems.length;
  return a.km < b.km - 1e-6;
}

let best = null, bestSeed = 0, started = Date.now();
SEEDS.forEach(seed => {
  const p = F.solve(input, { timeMs: SAFETY_MS, rounds: ROUNDS, seed: seed });
  console.log('seed ' + seed + ': ' + p.km.toFixed(1) + ' км, нарушений ' + p.problems.length +
    ', самая длинная смена ' + longest(p).toFixed(1) + ' мин, ' + (p.ms / 1000).toFixed(1) + ' с' + (p.ms >= SAFETY_MS ? ' (упёрся в страховку!)' : ''));
  if (better(p, best)) { best = p; bestSeed = seed; }
});

// Запись плана и проверка: план из короткой записи должен давать те же числа.
const assignment = S.toAssignment(best);
const again = S.fromAssignment(input, assignment);
if (Math.abs(again.km - best.km) > 0.01 || again.problems.length !== best.problems.length) {
  console.log('ОШИБКА: план из записи не совпал с расчётом'); process.exit(1);
}
const naive = S.naive(input);
const summary = {
  km: Math.round(best.km), kmExact: Math.round(best.km * 10) / 10, used: best.used, stops: best.stopsTotal,
  problems: best.problems.length, problemList: best.problems, byRoad: !!best.byRoad,
  longestMin: Math.round(longest(best)), naiveKm: Math.round(naive.km), live: null, base: true,
  made: new Date().toISOString().slice(0, 10), seed: bestSeed, rounds: ROUNDS, dataVersion: D.version
};
console.log('\nЭталон: seed ' + bestSeed + ', ' + summary.kmExact + ' км, машин ' + summary.used + ', остановок ' + summary.stops +
  ', нарушений ' + summary.problems + (summary.problems ? ' (' + summary.problemList.join('; ') + ')' : '') +
  ', по дорогам: ' + summary.byRoad + ', «по списку» ' + summary.naiveKm + ' км. Всего ' + Math.round((Date.now() - started) / 1000) + ' с.');
if (!summary.byRoad) console.log('ВНИМАНИЕ: не все адреса есть в таблице дорог, часть расстояний по прямой.');

const js = '// ЭТАЛОННЫЙ ПЛАН на исходных данных. Файл создан скриптом tools/make-base-plan.js, руками не править.\n' +
  '// assignment — для каждой машины (v) номера первых заказов её остановок по порядку (s), как в базе.\n' +
  '// summary — главные числа плана на момент расчёта. Та же запись лежит в базе, в таблице base_plan.\n' +
  'window.MILK_BASE_PLAN = ' + JSON.stringify({ assignment: assignment, summary: summary }) + ';\n';
fs.writeFileSync(dir + '/js/base-plan.js', js);

const q = s => "'" + JSON.stringify(s).replace(/'/g, "''") + "'::jsonb";
const sql = '-- Эталонный план (создан tools/make-base-plan.js ' + summary.made + ').\n' +
  'insert into public.base_plan (id, assignment, summary, updated_at) values (1, ' + q(assignment) + ', ' + q(summary) + ', now())\n' +
  'on conflict (id) do update set assignment = excluded.assignment, summary = excluded.summary, updated_at = now();\n';
fs.writeFileSync(dir + '/tools/base-plan.sql', sql);
console.log('Записано: js/base-plan.js и tools/base-plan.sql');
