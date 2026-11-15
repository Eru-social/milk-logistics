// Проверка этапа 3 «Не везём сегодня» (решение 6). Запуск: node tests/check-notoday.js  (около 2 минут)
// Что проверяем:
//   1) на исходных данных план не изменился ни на километр: тот же эталон, второго варианта нет, «не везём» пусто;
//   2) «минус 4 машины» в день максимальной загрузки даёт два варианта — «везём всё» и «без нарушений»;
//      в каждом вес в маршрутах + вес «не везём» = 63 630 кг, каждая остановка ровно в одном месте;
//      в «без нарушений» нарушений ноль; то же для других четвёрок машин (в том числе без малой машины);
//   3) список «не везём» записывается вместе с планом (строка машины 0) и читается обратно теми же числами;
//      страница водителя эти точки не видит;
//   4) точку из «не везём» можно вручную вернуть машине — и в предложении, и в общем плане;
//   5) после утверждения «не везём» переходит в идущий день: при поломке эти точки остаются «не сегодня»;
//   6) в обычный день (машины в гараже есть) варианта «не везём» нет: второй вариант там — «больше машин»;
//   7) странные случаи: одна машина на линии, все машины сняты.
const dir = process.argv[2] || require('path').join(__dirname, '..');
global.window = {};
require(dir + '/js/settings.js'); require(dir + '/js/data.js'); require(dir + '/js/roads.js'); require(dir + '/js/base-plan.js');
const S = require(dir + '/js/solver.js'), F = require(dir + '/js/fleet.js'), P = require(dir + '/js/proposal.js'), R = require(dir + '/js/replan.js');
const D = window.MILK_DATA, BASE = window.MILK_BASE_PLAN, TOTAL = 63630;
const clone = x => JSON.parse(JSON.stringify(x));
const roads = S.roadsFrom(window.MILK_ROADS);
const make = () => ({ depot: D.depot, orders: clone(D.orders), vehicles: clone(D.vehicles), settings: Object.assign({}, window.MILK_SETTINGS), roads });
let fails = 0;
function ok(cond, text) { if (!cond) { fails++; console.log('  ОШИБКА: ' + text); } }

// Каждая остановка ровно в одном месте (в маршруте или в «не везём»), вес маршрутов + «не везём» = вес заказов.
function weigh(plan, data, label) {
  const seen = new Array(plan.stops.length).fill(0); let inRoutes = 0, out = 0;
  plan.routes.forEach(r => r.seq.forEach(i => { seen[i]++; inRoutes += plan.stops[i].kg; }));
  (plan.dropped || []).forEach(i => { seen[i]++; out += plan.stops[i].kg; });
  ok(seen.every(x => x === 1), label + ': остановка не ровно в одном месте');
  const want = data.orders.reduce((a, o) => a + (o.kg > 0 ? o.kg : 0), 0);
  ok(Math.abs(inRoutes + out - want) < 0.5, label + ': в маршрутах ' + inRoutes + ' + не везём ' + out + ' ≠ ' + want);
  ok(Math.abs((plan.droppedKg || 0) - out) < 0.5, label + ': droppedKg ' + plan.droppedKg + ', а по списку ' + out);
  plan.routes.forEach(r => { if (r.vehicle.active === false) ok(!r.seq.length, label + ': снятая машина везёт груз'); });
  return { inRoutes, out };
}
// Запись → чтение: те же числа, тот же список «не везём».
function sameAfterSave(plan, data, label) {
  const a = S.toAssignment(plan), back = S.fromAssignment(data, clone(a));
  ok(Math.abs(back.km - plan.km) < 0.01 && back.problems.length === plan.problems.length, label + ': после записи другие числа');
  ok(JSON.stringify(back.dropped) === JSON.stringify(plan.dropped), label + ': после записи другой список «не везём»');
  ok(!back.leftover, label + ': после записи точки «потерялись» и вставлены заново');
  return a;
}
const short = p => Math.round(p.km) + ' км, машин ' + p.used + ', нарушений ' + p.problems.length +
  (p.dropped.length ? ', не везём ' + p.dropped.length + ' точ. ' + Math.round(p.droppedKg) + ' кг' : '');

(async () => {
  // ---------- 1. Исходные данные: план не изменился ----------
  console.log('=== 1. Исходные данные ===');
  {
    const input = make();
    const base = S.fromAssignment(input, BASE.assignment);
    ok(!base.dropped.length && Math.abs(base.km - BASE.summary.kmExact) < 0.06, 'эталон из записи: ' + short(base));
    ok(S.toAssignment(base).every(a => a.v !== S.NOT_TODAY), 'в записи эталона появилась строка «не везём»');
    // Тот же расчёт, что у эталона (seed и число встряхиваний), но с разрешённым вариантом «не везём».
    const p = F.solve(input, { seed: BASE.summary.seed, rounds: BASE.summary.rounds, timeMs: 120000, allowDrop: true });
    ok(JSON.stringify(S.toAssignment(p)) === JSON.stringify(BASE.assignment), 'с allowDrop план не совпал с эталоном');
    ok(Math.abs(p.km - BASE.summary.kmExact) < 0.06, 'пробег ' + p.km.toFixed(2) + ', у эталона ' + BASE.summary.kmExact);
    ok(!p.calm && !p.dropped.length, 'на исходных данных появился вариант «не везём»');
    console.log('  ' + short(p) + ' — как у эталона (' + BASE.summary.kmExact.toFixed(1) + ' км), второго варианта нет, ' + (p.ms / 1000).toFixed(1) + ' с');
  }

  // ---------- 2–4. «Минус 4 машины» в день максимальной загрузки ----------
  console.log('\n=== 2. Минус 4 машины, день максимальной загрузки ===');
  const input = make(), cur = { input, plan: S.fromAssignment(input, BASE.assignment), naive: S.naive(input) };
  const FOURS = [[3, 5, 7, 9], [13, 14, 8, 1], [16, 15, 6, 7]];
  let keep = null;
  for (const four of FOURS) {
    const list = four.map(id => ({ kind: 'vehicle_off', vehicleId: id }));
    const pr = P.make(cur, list);
    const label = 'машины ' + four.join(', ') + ' не выходят';
    ok(pr.ok, label + ': предложение не построено: ' + pr.errors.join('; '));
    if (!pr.ok) continue;
    ok(pr.variants && pr.variants.length === 2, label + ': вариантов ' + (pr.variants ? pr.variants.length : 0) + ', ждали 2');
    if (!pr.variants) continue;
    const [all, calm] = pr.variants;
    ok(all.key === 'all' && calm.key === 'calm', label + ': варианты не в том порядке');
    const wa = weigh(all.plan, pr.data, label + ' / везём всё'), wc = weigh(calm.plan, pr.data, label + ' / без нарушений');
    ok(wa.inRoutes + wa.out === TOTAL && wc.inRoutes + wc.out === TOTAL, label + ': сумма не 63 630 кг');
    ok(!all.plan.dropped.length && all.plan.problems.length > 0, label + ': «везём всё» что-то не везёт или без нарушений');
    ok(calm.plan.problems.length === 0, label + ': в «без нарушений» нарушения: ' + calm.plan.problems.join('; '));
    ok(calm.plan.dropped.length > 0, label + ': в «без нарушений» нечего не везти?');
    ok(calm.after.problems === 0 && calm.after.dropped === calm.plan.dropped.length, label + ': карточка «было → станет» не по варианту');
    // Ровно то, что показано, — то и применяется: выбор варианта меняет план предложения.
    P.choose(pr, 1);
    ok(pr.plan === calm.plan && pr.after === calm.after, label + ': выбор варианта не сработал');
    const card = P.card(pr);
    ok(/data-variant="0"/.test(card) && /data-variant="1"/.test(card) && /Не везём сегодня: /.test(card), label + ': в карточке нет двух вариантов или списка «не везём»');
    const imp = calm.plan.dropped.filter(i => calm.plan.stops[i].important).length;
    console.log('  ' + label + ' (' + (pr.ms / 1000).toFixed(1) + ' с):\n    везём всё:     ' + short(all.plan) + ' — ' + all.plan.problems[0] +
      '\n    без нарушений: ' + short(calm.plan) + (imp ? ', из них важных ' + imp : '') + '; ' + wc.inRoutes + ' + ' + wc.out + ' = ' + (wc.inRoutes + wc.out) + ' кг');
    sameAfterSave(calm.plan, pr.data, label);
    if (!keep) keep = pr;
  }

  console.log('\n=== 3. Запись плана, страница водителя ===');
  if (keep) {
    const pr = keep, calm = pr.variants[1].plan, a = S.toAssignment(calm);
    const row = a.filter(x => x.v === S.NOT_TODAY);
    ok(row.length === 1 && row[0].s.length === calm.dropped.length, 'в записи нет строки «не везём» или в ней не все точки');
    // Страница водителя (js/driver.js) читает утверждённый план тем же fromAssignment: «не везём» ни в одной машине.
    const forDriver = S.fromAssignment(pr.data, clone(a));
    const dropOid = {}; calm.dropped.forEach(i => calm.stops[i].orders.forEach(o => { dropOid[o.id] = true; }));
    let leaked = 0;
    forDriver.routes.forEach(r => r.seq.forEach(i => forDriver.stops[i].orders.forEach(o => { if (dropOid[o.id]) leaked++; })));
    ok(!leaked, 'водителю попали точки из «не везём»: ' + leaked);
    console.log('  строка «не везём» в записи: ' + row[0].s.length + ' точ.; водителям из неё не попало ничего');
    // Старый план (без строки) читается как раньше.
    const plain = S.fromAssignment(pr.data, a.filter(x => x.v !== S.NOT_TODAY));
    ok(plain.dropped.length === 0, 'план без строки «не везём» что-то не везёт');

    console.log('\n=== 4. Точку вернуть машине ===');
    // В предложении: самая лёгкая точка из «не везём» → машине 1.
    const lightest = calm.dropped.slice().sort((x, y) => calm.stops[x].kg - calm.stops[y].kg)[0];
    const oid = calm.stops[lightest].orders[0].id, before = calm.dropped.length;
    P.move(pr, oid, 1);
    const moved = pr.plan, r1 = moved.routes.filter(r => r.vehicle.id === 1)[0];
    ok(pr.variants[1].plan === moved, 'перенос в предложении не попал в показанный вариант');
    ok(moved.dropped.length === before - 1, 'в предложении точка не ушла из «не везём»');
    ok(r1.seq.some(i => moved.stops[i].orders[0].id === oid), 'в предложении точка не попала в машину 1');
    weigh(moved, pr.data, 'после «вернуть машине» в предложении');
    console.log('  в предложении: «' + calm.stops[lightest].orders[0].name + '» (' + calm.stops[lightest].kg + ' кг) → машина 1: ' + short(moved) +
      (moved.problems.length ? ' — ' + moved.problems.join('; ') : ''));
    // В общем плане (как app.js moveStop): запись плана + перенос.
    const general = S.fromAssignment(pr.data, S.toAssignment(calm), { orderId: oid, vehicleId: 2 });
    ok(general.dropped.length === before - 1 && general.routes.filter(r => r.vehicle.id === 2)[0].seq.some(i => general.stops[i].orders[0].id === oid),
      'в общем плане точка не вернулась машине 2');
    weigh(general, pr.data, 'после «вернуть машине» в общем плане');
    sameAfterSave(general, pr.data, 'после «вернуть машине»');

    console.log('\n=== 5. Утвердили «без нарушений», потом поломка ===');
    const approved = S.fromAssignment(pr.data, clone(a));
    const broken = approved.routes.filter(r => r.seq.length > 4)[0];
    const res = R.propose(pr.data, approved, { type: 'breakdown', vehicleId: broken.vehicle.id, at: Math.round((broken.depart + broken.back) / 2) }, null);
    ok(res.ok, 'поломка после «не везём»: ' + res.message);
    if (res.ok) res.variants.forEach(v => {
      weigh(v.plan, pr.data, 'поломка / ' + v.name);
      calm.dropped.forEach(i => ok(v.plan.dropped.indexOf(i) >= 0, 'поломка / ' + v.name + ': утренняя «не везём» вернулась в маршрут'));
      const again = S.fromAssignment(pr.data, clone(v.assignment), null, clone(v.live));
      ok(Math.abs(again.km - v.plan.km) < 0.01 && again.dropped.length === v.plan.dropped.length, 'поломка / ' + v.name + ': после записи другие числа');
      console.log('  ' + broken.vehicle.name + ' сломалась → ' + v.name + ': не доставим ' + v.plan.dropped.length + ' точ. (с утра ' + calm.dropped.length + ')');
    });
  }

  // ---------- 6. Обычный день: машины в гараже есть — «не везём» не нужен ----------
  console.log('\n=== 6. Обычный день (вес ×0,7) ===');
  {
    const cur2 = { input, plan: cur.plan, naive: cur.naive };
    const pr = P.make(cur2, [{ kind: 'scale_kg', factor: 0.7 }]);
    ok(pr.ok && !pr.variants && !pr.plan.dropped.length, 'в обычный день появился вариант «не везём»');
    console.log('  ' + short(pr.plan) + ' — вариант один' + (pr.plan.problems.length ? ' (переработка: второй вариант — «больше машин», кнопка «а если»)' : ''));
  }

  // ---------- 7. Странные случаи ----------
  console.log('\n=== 7. Странные случаи ===');
  {
    const offAll = D.vehicles.filter(v => v.id !== 16).map(v => ({ kind: 'vehicle_off', vehicleId: v.id }));
    const pr = P.make(cur, offAll);
    ok(pr.ok && pr.variants && pr.variants[1].plan.problems.length === 0, 'одна малая машина: нет варианта без нарушений');
    if (pr.ok && pr.variants) {
      const w = weigh(pr.variants[1].plan, pr.data, 'одна машина / без нарушений');
      weigh(pr.variants[0].plan, pr.data, 'одна машина / везём всё');
      console.log('  на линии только машина 16 (1,5 т): ' + short(pr.variants[1].plan) + '; ' + w.inRoutes + ' + ' + w.out + ' кг');
    }
    const none = P.make(cur, D.vehicles.map(v => ({ kind: 'vehicle_off', vehicleId: v.id })));
    ok(none.ok, 'все машины сняты: предложение упало: ' + none.errors.join('; '));
    if (none.ok) console.log('  все машины сняты: ' + short(none.plan) + (none.variants ? ', вариантов ' + none.variants.length : ', вариант один') + ' — ' + none.plan.problems[0]);
    // Запись с чужой строкой «не везём» (точки, которых нет) читается без ошибок.
    const odd = S.fromAssignment(input, BASE.assignment.concat([{ v: S.NOT_TODAY, s: [999999, -1] }]));
    ok(!odd.dropped.length && !odd.leftover, 'строка «не везём» с несуществующими заказами сломала план');
  }

  console.log(fails ? '\nОШИБОК: ' + fails : '\nВсе проверки пройдены');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('УПАЛО: ' + e.stack); process.exit(1); });
