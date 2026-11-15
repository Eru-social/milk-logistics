// НАСТРОЙКИ. Все допущения задачи собраны здесь, в одном месте.
// Время везде хранится в минутах от полуночи: 6:00 = 360, 17:00 = 1020.
window.MILK_SETTINGS = {
  serviceMin: 30,          // минут на разгрузку в обычной точке (среднее, со слов логистов)
  smallStopKg: 100,        // точка считается мелкой, если груза не больше стольких кг...
  smallServiceMin: 10,     // ...и на неё хватает 10 минут (со слов логистов)
  shiftMin: 480,           // смена водителя 8 часов, загрузка на заводе входит, обед не входит
  loadMin: 60,             // час на загрузку машины на заводе (со слов логистов)
  earliestDepart: 300,     // первая машина выезжает в 5:00 (со слов логистов)
  dayEnd: 1020,            // разгрузку нужно начать не позже 17:00
  // Время выгрузки есть только у 10 важных строк: так написано в файле заказчика.
  // Включить — запасное толкование: время из строки выше действует на пустые ячейки ниже.
  fillDownTimes: false,
  importantWindowMin: 60,  // к «важным» точкам (время вписано явно) приехать в течение часа
  trafficFactor: 1.2,      // запас на пробки: время в пути по дорогам умножается на 1,2 (наше допущение)
  // Два числа ниже нужны только как запасной расчёт, если таблицы расстояний по дорогам нет:
  detour: 1.75,            // дорога длиннее прямой линии в 1,75 раза (сверено с реальными дорогами на 4 маршрутах)
  speedKmh: 25,            // средняя скорость по городу
  overtimeToleranceMin: 10, // допуск по смене: переработку до 10 минут не считаем нарушением (наше допущение)
  overloadTolerancePct: 1,  // допуск по загрузке: перегруз до 1% не считаем нарушением, тоннаж в заказах приблизительный
  minLoadPct: 90,          // жёсткое правило: загрузка не ниже 90%, иначе машина остаётся в гараже
  // Что важнее, если всё сразу не сходится (js/fleet.js):
  //   'fewer'    — меньше машин, загрузка не ниже 90%: сначала по весу выбирается минимум машин, потом маршруты;
  //   'overtime' — без переработки, машин сколько нужно: решатель сам решает, сколько машин вывести (как до 14 ноября).
  fleetPriority: 'fewer',
  refKmPerRoute: 45,       // «как сейчас»: средний пробег маршрута, со слов логистов
  centerStreets: ['Советская', 'Мостовая', 'Замковая'], // сюда только малой машиной
  centerMaxCap: 1500,      // «малая машина» — до 1,5 т
  delayWeight: 0.03,       // насколько важно разгружать ближе к указанному времени (0 — не важно)
  vehicleFixedMin: 60,     // «цена» выезда каждой машины, чтобы план старался обойтись меньшим числом
  improveRounds: 60,       // сколько раз пробуем улучшить план (больше — дольше и чуть лучше)
  // Три числа ниже нужны для перестроения в течение дня (наши допущения):
  transferMin: 20,         // минут на перегрузку из сломанной машины в другую
  reserveReadyMin: 15,     // через сколько минут готова выехать машина, которая стоит на заводе
  retryMin: 60,            // через сколько минут возвращаться к точке, которая не приняла товар
  replanOvertimeMin: 60    // «умеренный» вариант перестроения: переработка у водителя не больше стольких минут
};

// ГРАНИЦЫ (этап 6). Жюри может ввести что угодно: −5, 1e999, 25:00. Чтобы экран не падал и не показывал
// бессмыслицу, у каждого числового правила есть разумные пределы: [наименьшее, наибольшее].
// Экран (js/app.js) поправляет значение при вводе и говорит об этом; решатель (js/solver.js, js/fleet.js)
// на всякий случай поправляет ещё раз то, что пришло из базы или с другого экрана.
window.MILK_LIMITS = {
  serviceMin: [0, 240], smallStopKg: [0, 100000], smallServiceMin: [0, 240], shiftMin: [0, 1440], loadMin: [0, 600],
  earliestDepart: [0, 1439], dayEnd: [0, 1439], importantWindowMin: [0, 1440], trafficFactor: [0.1, 10],
  detour: [1, 10], speedKmh: [5, 150], overtimeToleranceMin: [0, 600], overloadTolerancePct: [0, 100], minLoadPct: [0, 100],
  refKmPerRoute: [0, 2000], centerMaxCap: [0, 100000], delayWeight: [0, 10], vehicleFixedMin: [0, 1000],
  improveRounds: [0, 2000], transferMin: [0, 600], reserveReadyMin: [0, 600], retryMin: [0, 1440], replanOvertimeMin: [0, 1440],
  orderKg: [0, 100000],      // вес одного заказа, кг
  vehicleCap: [0, 100000],   // вместимость машины, кг
  orderFrom: [0, 1439]       // время выгрузки «не раньше», минуты от полуночи (00:00–23:59)
};
window.MilkLimits = (function () {
  var L = window.MILK_LIMITS, D = window.MILK_SETTINGS;
  // Число в пределах [lo, hi]; не число (пусто, «abc», бесконечность) — значение fallback.
  function num(x, lo, hi, fallback) {
    x = typeof x === 'string' ? +x.replace(',', '.') : +x;
    if (typeof x !== 'number' || !isFinite(x)) return fallback;
    return Math.min(hi, Math.max(lo, x));
  }
  function range(key, x, fallback) { return num(x, L[key][0], L[key][1], fallback); }
  // Правила: возвращает тот же объект, если всё в порядке, иначе исправленную копию.
  function settings(s) {
    var out = null;
    s = s || {};
    Object.keys(D).forEach(function (k) {
      var v = s[k], fixed = v;
      if (L[k]) fixed = range(k, v, D[k]);
      else if (k === 'fleetPriority') fixed = v === 'fewer' || v === 'overtime' ? v : D[k];
      else if (typeof D[k] === 'boolean') fixed = typeof v === 'boolean' ? v : D[k];
      else if (v == null) fixed = D[k];
      if (fixed !== v) { out = out || Object.assign({}, s); out[k] = fixed; }
    });
    return out || s;
  }
  // Заказы и машины: тот же список, если всё в порядке, иначе копия с исправленными записями.
  function orders(list) {
    var changed = false, out = (list || []).map(function (o) {
      var kg = range('orderKg', o.kg, 0), from = range('orderFrom', o.from, 0);
      if (kg === o.kg && from === o.from) return o;
      changed = true; return Object.assign({}, o, { kg: kg, from: from });
    });
    return changed ? out : list || [];
  }
  function vehicles(list) {
    var changed = false, out = (list || []).map(function (v) {
      var cap = range('vehicleCap', v.cap, 0);
      if (cap === v.cap) return v;
      changed = true; return Object.assign({}, v, { cap: cap });
    });
    return changed ? out : list || [];
  }
  // Все входные данные расчёта разом: тот же объект, если ничего не пришлось исправлять.
  function input(inp) {
    var st = settings(inp.settings), o = orders(inp.orders), v = vehicles(inp.vehicles);
    if (st === inp.settings && o === inp.orders && v === inp.vehicles) return inp;
    return Object.assign({}, inp, { settings: st, orders: o, vehicles: v });
  }
  return { num: num, range: range, settings: settings, orders: orders, vehicles: vehicles, input: input };
})();
