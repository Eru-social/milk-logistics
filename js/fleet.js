// ВЫБОР МАШИН ПО ВЕСУ. Шаг перед построением маршрутов (этап 1А, 14 ноября).
//
// Зачем. Правило логистов заказчика: загрузка машины не ниже 90%, а если заказов мало — машина
// остаётся в гараже; одна из целей заказчика — «уменьшить количество транспорта».
// Сам решатель (solver.js) так не умеет: недогруз в его «цене» дешёвый, переработка дорогая,
// поэтому в лёгкий день он выводит лишние машины, лишь бы никто не переработал.
// Здесь порядок обратный: сначала число машин задаёт вес, потом решатель строит маршруты
// только для выбранных машин. Сам поиск маршрутов в решателе не меняется.
//
// Правило выбора:
//   1. Берутся только машины, которые стоят «на линии» (вкладка «Машины»).
//   2. Нужно наименьшее число машин, суммарная вместимость которых не меньше общего веса заказов.
//   3. Если есть заказы на улицах центра, малая машина (до 1,5 т) входит в набор обязательно.
//   4. Из наборов одинакового размера берётся тот, у которого вместимость ближе всего к весу
//      (то есть загрузка выше).
//   5. Если после расчёта маршрутов остался перегруз сверх допуска (груз не всегда раскладывается
//      ровно), добавляется ещё одна машина, и расчёт повторяется, пока перегруз не уйдёт или машины не кончатся.
//
// Невыбранные машины попадают в план с пустым маршрутом. Поэтому экран пишет их «в гараже»,
// а перестроение в течение дня (replan.js) видит их как резерв и может вывести при поломке.
//
// Настройка fleetPriority во вкладке «Правила» — что важнее, если всё сразу не сходится:
//   'fewer'    — меньше машин, загрузка не ниже 90% (по умолчанию, так работают логисты заказчика);
//   'overtime' — без переработки, машин сколько нужно (прежнее поведение: решатель сам решает, сколько машин).
(function () {
  'use strict';
  var S = (typeof module !== 'undefined' && module.exports) ? require('./solver.js') : window.MilkSolver;

  // Если машин очень много и вместимости у всех разные, наборов слишком много для перебора.
  // Тогда (и только тогда) набор берётся «жадно»: самые большие машины, пока хватает места.
  // 16 машин заказчика перебираются полностью: у них 7 разных вместимостей, это 4 320 вариантов.
  var MAX_COMBOS = 200000;
  // Запас времени на расчёт (2,5 с, как раньше) делится между попытками: каждой, пока можно добавить машину,
  // достаётся 3/4 оставшегося, остальное — на случай повтора. Если повтор не понадобился, расчёт просто
  // кончается раньше. MARGIN_MS — запас на то, что решатель заканчивает начатый круг улучшений чуть позже
  // своего срока, и на перенос плана на весь парк. Меньше MIN_TRY_MS одной попытке не даём: за меньшее время
  // решатель не успевает улучшить даже стартовый план (в редком случае многих повторов это может
  // добавить к расчёту десятую долю секунды).
  var FIRST_SHARE = 0.75, MIN_TRY_MS = 100, MARGIN_MS = 150;

  function tons(kg) { return (Math.round(kg / 100) / 10).toLocaleString('ru-RU') + ' т'; }
  function plural(n, one, few, many) {
    var a = n % 10, b = n % 100;
    return n + ' ' + (a === 1 && b !== 11 ? one : (a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many));
  }
  function onLine(input) { return (input.vehicles || []).filter(function (v) { return v.active !== false && v.cap > 0; }); }

  // ---------- выбор набора машин ----------
  // Возвращает: vehicles — выбранные машины (в том же порядке, что в списке машин), kg — общий вес,
  // cap — их вместимость, active — машины на линии, stops — сколько остановок, all — нужны все машины на линии,
  // tooHeavy — груз не влезает даже во все, noSmall — есть заказы в центре, а малой машины на линии нет.
  function choose(input) {
    var st = input.settings, active = onLine(input);
    // Остановки собираем тем же правилом, что и решатель: так вес и «центр» считаются одинаково.
    var P = S.core.prepare(Object.assign({}, input, { vehicles: active }));
    var kg = 0, needSmall = false, totalCap = 0;
    P.stops.forEach(function (s) { kg += s.kg; if (s.center) needSmall = true; });
    active.forEach(function (v) { totalCap += v.cap; });
    function isSmall(v) { return v.cap <= st.centerMaxCap; }
    var hasSmall = active.some(isSmall);
    var out = { vehicles: active, kg: kg, cap: totalCap, active: active, stops: P.stops.length, all: true,
      tooHeavy: kg > totalCap, noSmall: needSmall && !hasSmall };
    if (!active.length) return out;                       // машин нет — решатель сам скажет, что не помещается
    if (!P.stops.length) { out.vehicles = []; out.cap = 0; out.all = false; return out; }   // заказов нет — все в гараже
    if (out.tooHeavy) return out;                         // не влезает даже во все — выводим все
    var mustSmall = needSmall && hasSmall;

    // Машины одной вместимости взаимозаменяемы, поэтому перебираем не машины, а «сколько машин каждой
    // вместимости взять». Это тот же полный перебор всех наборов, только без одинаковых повторов.
    var groups = [], byCap = {};
    active.forEach(function (v) {
      if (!byCap[v.cap]) { byCap[v.cap] = { cap: v.cap, list: [], small: isSmall(v) }; groups.push(byCap[v.cap]); }
      byCap[v.cap].list.push(v);
    });
    var combos = 1;
    groups.forEach(function (g) { combos *= g.list.length + 1; });
    var take = combos <= MAX_COMBOS ? searchAll(groups, kg, mustSmall) : greedy(groups, kg, mustSmall);
    // Внутри группы берём первые по списку машины: так выбор не скачет от расчёта к расчёту.
    var picked = {};
    groups.forEach(function (g, i) { g.list.slice(0, take[i]).forEach(function (v) { picked[v.id] = true; }); });
    out.vehicles = active.filter(function (v) { return picked[v.id]; });
    out.cap = 0;
    out.vehicles.forEach(function (v) { out.cap += v.cap; });
    out.all = out.vehicles.length === active.length;
    return out;
  }

  // Полный перебор: лучший набор — меньше машин, а при равном числе — вместимость ближе к весу.
  // Набор, где машин больше, чем в уже найденном, дальше не рассматриваем.
  function searchAll(groups, kg, mustSmall) {
    var best = null, bestN = Infinity, bestCap = Infinity, take = groups.map(function () { return 0; });
    function walk(i, n, cap, small) {
      if (n > bestN) return;
      if (i === groups.length) {
        if (cap < kg || (mustSmall && !small)) return;
        if (n < bestN || cap < bestCap) { best = take.slice(); bestN = n; bestCap = cap; }
        return;
      }
      for (var c = 0; c <= groups[i].list.length; c++) {
        take[i] = c;
        walk(i + 1, n + c, cap + c * groups[i].cap, small || (c > 0 && groups[i].small));
      }
      take[i] = 0;
    }
    walk(0, 0, 0, false);
    return best;
  }

  // Запасной способ для очень большого парка: малая машина (если нужна), потом самые большие, пока не хватит места.
  function greedy(groups, kg, mustSmall) {
    var take = groups.map(function () { return 0; }), cap = 0, order = groups.map(function (g, i) { return i; });
    order.sort(function (a, b) { return groups[b].cap - groups[a].cap; });
    if (mustSmall) {
      for (var j = order.length - 1; j >= 0; j--) if (groups[order[j]].small) { take[order[j]] = 1; cap += groups[order[j]].cap; break; }
    }
    order.forEach(function (i) {
      while (cap < kg && take[i] < groups[i].list.length) { take[i]++; cap += groups[i].cap; }
    });
    return take;
  }

  // Какую машину добавить, если груз не разложился без перегруза: самую малую из оставшихся,
  // которой хватит на весь перегруз (так средняя загрузка падает меньше всего), а если такой нет — самую большую.
  function nextVehicle(active, chosen, overload) {
    var inSet = {}, fit = null, biggest = null;
    chosen.forEach(function (v) { inSet[v.id] = true; });
    active.forEach(function (v) {
      if (inSet[v.id]) return;
      if (v.cap >= overload && (!fit || v.cap < fit.cap)) fit = v;
      if (!biggest || v.cap > biggest.cap) biggest = v;
    });
    return fit || biggest;
  }
  // Перегруз сверх допуска: тот, что решатель показывает как нарушение.
  function overloadOf(plan) {
    var kg = 0;
    plan.routes.forEach(function (r) { if (r.overloadBad) kg += r.overload; });
    return kg;
  }

  // ---------- главная функция: выбор машин, потом маршруты ----------
  // Принимает то же, что MilkSolver.solve (input и необязательные opts), и возвращает такой же план.
  // В плане есть все машины на линии; у невыбранных маршрут пустой («в гараже»).
  // plan.fleet — как выбирали: mode ('fewer' или 'overtime'), need — сколько машин нужно по весу,
  // added — сколько машин добавлено из-за перегруза, tries — сколько раз строили маршруты.
  function solve(input, opts) {
    opts = opts || {};
    var started = Date.now(), budget = opts.timeMs > 0 ? opts.timeMs : 2500, plan;
    if (input.settings.fleetPriority === 'overtime') {    // прежнее поведение: решатель сам решает, сколько машин
      plan = S.solve(input, opts);
      plan.fleet = { mode: 'overtime', need: 0, added: 0, tries: 1 };
      return plan;
    }
    var pick = choose(input);
    if (pick.all) {
      // Нужны все машины (как в день максимальной загрузки), груз не влезает или машин нет —
      // решатель считает ровно как раньше, с тем же запасом времени. Поэтому эталонный план не меняется.
      plan = S.solve(input, opts);
      plan.fleet = { mode: 'fewer', need: pick.vehicles.length, added: 0, tries: 1 };
      return plan;
    }
    var chosen = pick.vehicles, added = 0, tries = 0;
    for (;;) {
      var left = started + budget - MARGIN_MS - Date.now(), canAdd = chosen.length < pick.active.length;
      // Пока можно добавить машину, оставляем четверть времени про запас на повтор.
      // Если повтор понадобился, а время почти вышло, он всё равно получает MIN_TRY_MS: перегруз хуже лишней десятой секунды.
      var share = Math.max(MIN_TRY_MS, canAdd ? left * FIRST_SHARE : left);
      var part = S.solve(Object.assign({}, input, { vehicles: chosen }), Object.assign({}, opts, { timeMs: share }));
      tries++;
      // Переносим план на весь парк: невыбранные машины получают пустой маршрут. Числа не меняются:
      // время и вес каждой машины считаются отдельно от других.
      plan = S.fromAssignment(input, S.toAssignment(part));
      var over = overloadOf(plan);
      if (!over || !canAdd) break;
      var extra = nextVehicle(pick.active, chosen, over), ids = {};
      chosen.concat([extra]).forEach(function (v) { ids[v.id] = true; });
      chosen = pick.active.filter(function (v) { return ids[v.id]; });   // порядок как в списке машин
      added++;
    }
    plan.ms = Date.now() - started;
    plan.fleet = { mode: 'fewer', need: pick.vehicles.length, added: added, tries: tries };
    return plan;
  }

  // ---------- объяснение словами ----------
  // Одна строка над маршрутами: почему машин столько. Считается по самому плану и по данным,
  // поэтому одинакова на всех экранах, в том числе для плана, который пришёл из базы.
  // Возвращает { text, overtimeHint }: overtimeHint — показать ли подсказку «без переработки нужно больше машин».
  function explain(plan, input) {
    var st = input.settings, pick = choose(input), active = pick.active.length, used = plan.used, loadSum = 0, garage = [];
    var mode = st.fleetPriority === 'overtime' ? 'overtime' : 'fewer', need = pick.vehicles.length;
    plan.routes.forEach(function (r) {
      if (r.seq.length) loadSum += r.loadPct;
      else garage.push(r.vehicle.name + (r.broken ? ' (сломана)' : ''));
    });
    var avg = used ? Math.round(loadSum / used) : 0, text;
    var garageText = garage.length ? ' В гараже: ' + garage.join(', ') + '.' : '';
    if (!active) return { text: 'Нет машин на линии: отметьте машины во вкладке «Машины».', overtimeHint: false };
    if (!pick.stops) return { text: 'Заказов нет: все машины в гараже.', overtimeHint: false };
    if (plan.live) {
      // День идёт: машины уже выехали, состав меняет только перестроение.
      text = 'День идёт: на линии ' + used + ' из ' + active + '.' + garageText;
    } else if (pick.tooHeavy) {
      text = 'Груз больше, чем вмещают все машины на линии: ' + tons(pick.kg) + ' при вместимости ' + tons(pick.cap) +
        '. На линии ' + used + ' из ' + active + '.';
    } else if (mode === 'overtime') {
      text = 'Выбрано «без переработки, машин сколько нужно»: на линии ' + used + ' из ' + active + ', средняя загрузка ' + avg + '%.' +
        (need < used ? ' По весу хватило бы ' + need + '.' : '') + garageText;
    } else if (pick.all && used === active) {
      text = 'Машины выбраны по весу: нужны все ' + active + ', груз занимает ' + Math.round(pick.kg / pick.cap * 100) + '% вместимости.';
    } else {
      text = 'Машины выбраны по весу: ' + used + ' из ' + active + ', средняя загрузка ' + avg + '%.';
      if (used > need) text += ' По весу хватило бы ' + plural(need, 'машины', 'машин', 'машин') + ', но тогда груз не раскладывается без перегруза.';
      else if (used < need) text += ' По весу нужно ' + need + ', поэтому где-то перегруз.';   // бывает после ручного переноса точек
      text += garageText;
    }
    if (pick.noSmall) text += ' Есть заказы в центре, а малой машины (до ' + tons(st.centerMaxCap) + ') на линии нет: туда поедет большая, это нарушение.';
    // Подсказка про второй вариант нужна, только если машины не укладываются в смену, а в гараже есть кем помочь.
    var overtime = plan.routes.some(function (r) { return r.overtimeBad; });
    return { text: text, overtimeHint: mode === 'fewer' && !plan.live && overtime && used < active };
  }

  var api = { choose: choose, solve: solve, explain: explain };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.MilkFleet = api;
})();
