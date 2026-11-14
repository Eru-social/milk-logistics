// ИЗМЕНЕНИЯ: единый формат «что поменялось» (этап 1Б).
// Любое изменение — простая запись { kind: 'вид', ...параметры }. Список таких записей выдают
// кнопки «а если», ручная форма, а на этапе 2 — языковая модель (она переводит слова логиста в такой список).
// Здесь три вещи: проверка списка (check), наложение на копию данных (apply) и описание словами (describe).
// В базу этот файл ничего не пишет и план не считает: это делает js/proposal.js.
//
// ВИДЫ, ПОКА ПЛАН НЕ УТВЕРЖДЁН (после них план строится заново, с начала дня):
//   { kind: 'vehicle_off', vehicleId: 7 }                    — машина 7 сегодня не выходит (водитель заболел — то же самое)
//   { kind: 'vehicle_on',  vehicleId: 7 }                    — машина 7 снова на линии
//   { kind: 'order_time', orderId: 12, time: '09:00' }       — разгрузка у заказа 12 не раньше 9:00 (он становится важным)
//   { kind: 'order_time', orderId: 12, time: '09:00', important: false } — время записать, но точку не считать важной
//   { kind: 'order_time', orderId: 12, important: false }    — убрать требование ко времени
//   { kind: 'order_kg', orderId: 12, kg: 450 }               — у заказа 12 другой вес; kg: 0 — заказ отменён
//   { kind: 'scale_kg', factor: 0.7 }                        — вес всех заказов ×0,7 (округление до 10 кг, не меньше 10 кг)
//   { kind: 'setting', key: 'serviceMin', value: 25 }        — другое значение правила из вкладки «Правила»
//
// ВИДЫ В ИДУЩЕМ ДНЕ (план утверждён; перестраивается только остаток дня, js/replan.js):
//   { kind: 'breakdown', vehicleId: 7, at: '10:40' }                       — машина сломалась
//   { kind: 'delay', vehicleId: 3, at: '11:10', minutes: 40 }              — задержка в пути
//   { kind: 'stop_refuses', orderId: 12, at: '11:30', action: 'retry' }    — точка не принимает: 'retry' вернуться позже, 'drop' не везти сегодня
//   { kind: 'later', orderId: 12, at: '11:30', time: '14:00' }             — магазин просит привезти не раньше 14:00
//   У видов с orderId машину можно не указывать: её найдём по плану.
//
// Время везде можно писать строкой '09:30' или числом минут от полуночи (570).
// Номера машин и заказов — те же id, что в базе и в таблицах на экране.
(function () {
  'use strict';

  var PLAN_KINDS = ['vehicle_off', 'vehicle_on', 'order_time', 'order_kg', 'scale_kg', 'setting'];
  var LIVE_KINDS = ['breakdown', 'delay', 'stop_refuses', 'later'];
  // Правила, которые хранятся как время (минуты от полуночи): для них принимаем и '05:00'.
  var TIME_SETTINGS = { earliestDepart: true, dayEnd: true };
  // Значения переключателей: только из этого списка.
  var CHOICES = { fleetPriority: { fewer: 'меньше машин, загрузка не ниже 90%', overtime: 'без переработки, машин сколько нужно' } };
  // Названия правил, как во вкладке «Правила» (для описания словами).
  var LABELS = {
    fleetPriority: 'Что важнее, если всё сразу не сходится', serviceMin: 'Разгрузка в обычной точке, мин',
    smallServiceMin: 'Разгрузка в мелкой точке, мин', smallStopKg: 'Мелкая точка — до, кг', shiftMin: 'Смена водителя, мин',
    loadMin: 'Загрузка на заводе, мин', earliestDepart: 'Первый выезд', dayEnd: 'Последняя разгрузка не позже',
    importantWindowMin: 'Окно для важных точек, мин', minLoadPct: 'Минимальная загрузка, %', overtimeToleranceMin: 'Допуск по смене, мин',
    overloadTolerancePct: 'Допуск по загрузке, %', delayWeight: 'Важность приезда ко времени', trafficFactor: 'Запас на пробки, ×',
    refKmPerRoute: 'Пробег маршрута сейчас, км', transferMin: 'Перегрузка из сломанной машины, мин',
    retryMin: 'Вернуться к закрытой точке через, мин', replanOvertimeMin: 'Умеренная переработка — до, мин',
    fillDownTimes: 'Запасное толкование времени (из строки выше)'
  };
  var KIND_NAMES = {
    vehicle_off: 'машина не выходит', vehicle_on: 'машина на линии', order_time: 'время выгрузки', order_kg: 'вес заказа',
    scale_kg: 'вес всех заказов', setting: 'правило', breakdown: 'поломка', delay: 'задержка',
    stop_refuses: 'точка не принимает', later: 'привезти в другое время'
  };

  function copy(x) { return JSON.parse(JSON.stringify(x)); }
  function clock(min) { min = Math.round(min); var h = Math.floor(min / 60), m = min % 60; return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m; }
  function num(x) { return (Math.round(x * 100) / 100).toLocaleString('ru-RU'); }
  function shortName(v) { return String(v.name || ('Машина ' + v.id)).split(' · ')[0]; }
  function find(list, id) { for (var i = 0; i < (list || []).length; i++) if (list[i].id === id) return list[i]; return null; }
  function orderName(o) { return '«' + o.name + '» (' + o.address + ')'; }
  function isLive(c) { return !!c && LIVE_KINDS.indexOf(c.kind) >= 0; }
  // Вес «обычного дня»: то же правило, что в проверках (tests/check-fleet.js): до 10 кг, не меньше 10 кг.
  function scaledKg(kg, factor) { return kg > 0 ? Math.max(10, Math.round(kg * factor / 10) * 10) : 0; }

  // Время: '09:30', '9:30' или число минут. Возвращает минуты или null, если так не бывает (например, 25:00).
  function parseTime(t) {
    if (typeof t === 'number') return isFinite(t) && t >= 0 && t < 24 * 60 ? Math.round(t) : null;
    var m = /^\s*(\d{1,2})[:.](\d{2})\s*$/.exec(String(t == null ? '' : t));
    if (!m || +m[1] > 23 || +m[2] > 59) return null;
    return +m[1] * 60 + +m[2];
  }
  // Число из записи: 450 или '450'. Пустое и не число — null.
  function number(x) {
    if (typeof x === 'string' && x.trim() !== '') x = +x.replace(',', '.');
    return typeof x === 'number' && isFinite(x) ? x : null;
  }

  // ---------- проверка ----------
  // Проверяет список и приводит записи к одному виду (время — в минутах, числа — числами).
  // data — { orders, vehicles, settings }. Возвращает { ok, errors: ['понятная строка', …], list }.
  // Ошибочная запись не роняет расчёт: она попадает в errors, и предложение не строится.
  function check(list, data) {
    var errors = [], out = [], live = 0;
    if (!Array.isArray(list)) return { ok: false, errors: ['Список изменений пуст или записан не списком.'], list: [] };
    if (!list.length) return { ok: false, errors: ['Список изменений пуст.'], list: [] };
    list.forEach(function (c, i) {
      var where = 'Изменение ' + (i + 1) + (c && KIND_NAMES[c.kind] ? ' («' + KIND_NAMES[c.kind] + '»)' : '') + ': ';
      var res = checkOne(c, data);
      if (typeof res === 'string') errors.push(where + res);
      else { out.push(res); if (isLive(res)) live++; }
    });
    if (live && live < list.length) errors.push('Нельзя смешивать изменения до утверждения плана и происшествия в идущем дне: это разные расчёты.');
    if (live > 1) errors.push('Происшествия в идущем дне разбираются по одному.');
    return { ok: !errors.length, errors: errors, list: out };
  }
  function checkOne(c, data) {
    if (!c || typeof c !== 'object') return 'запись пустая.';
    if (PLAN_KINDS.indexOf(c.kind) < 0 && LIVE_KINDS.indexOf(c.kind) < 0) return 'неизвестный вид «' + c.kind + '».';
    var r = { kind: c.kind }, v, o, t;
    if ('vehicleId' in c || ['vehicle_off', 'vehicle_on', 'breakdown', 'delay'].indexOf(c.kind) >= 0) {
      if (c.vehicleId == null && (c.kind === 'stop_refuses' || c.kind === 'later')) { /* машину найдём по плану */ }
      else {
        v = find(data.vehicles, number(c.vehicleId));
        if (!v) return 'машины № ' + c.vehicleId + ' нет.';
        r.vehicleId = v.id;
      }
    }
    if ('orderId' in c || ['order_time', 'order_kg', 'stop_refuses', 'later'].indexOf(c.kind) >= 0) {
      o = find(data.orders, number(c.orderId));
      if (!o) return 'заказа № ' + c.orderId + ' нет.';
      r.orderId = o.id;
    }
    if (isLive(c)) {
      t = parseTime(c.at);
      if (t === null) return 'не понятно, когда это случилось: «' + c.at + '».';
      r.at = t;
    }
    switch (c.kind) {
      case 'order_time':
        if (c.time == null || c.time === '') {
          if (c.important !== false) return 'не указано время выгрузки.';
          r.important = false;
        } else {
          t = parseTime(c.time);
          if (t === null) return 'такого времени не бывает: «' + c.time + '».';
          r.time = t; r.important = c.important !== false;
        }
        break;
      case 'order_kg':
        r.kg = number(c.kg);
        if (r.kg === null) return 'вес не число: «' + c.kg + '».';
        if (r.kg < 0) return 'вес не может быть отрицательным.';
        if (r.kg > 100000) return 'вес слишком большой: ' + r.kg + ' кг.';
        r.kg = Math.round(r.kg);
        break;
      case 'scale_kg':
        r.factor = number(c.factor);
        if (r.factor === null || r.factor <= 0 || r.factor > 5) return 'множитель веса должен быть больше 0 и не больше 5.';
        break;
      case 'setting':
        if (!data.settings || !(c.key in data.settings) || !(c.key in LABELS)) return 'такого правила нет: «' + c.key + '».';
        r.key = c.key;
        var was = data.settings[c.key];
        if (CHOICES[c.key]) {
          if (!CHOICES[c.key][c.value]) return 'у правила «' + LABELS[c.key] + '» нет значения «' + c.value + '».';
          r.value = c.value;
        } else if (typeof was === 'boolean') {
          if (typeof c.value !== 'boolean') return 'правило «' + LABELS[c.key] + '» можно только включить или выключить.';
          r.value = c.value;
        } else if (TIME_SETTINGS[c.key]) {
          r.value = parseTime(c.value);
          if (r.value === null) return 'такого времени не бывает: «' + c.value + '».';
        } else {
          r.value = number(c.value);
          if (r.value === null || r.value < 0 || r.value > 100000) return 'для правила «' + LABELS[c.key] + '» нужно число не меньше 0.';
        }
        break;
      case 'delay':
        r.minutes = number(c.minutes);
        if (r.minutes === null || r.minutes <= 0 || r.minutes > 600) return 'задержка должна быть от 1 до 600 минут.';
        r.minutes = Math.round(r.minutes);
        break;
      case 'stop_refuses':
        r.action = c.action === 'drop' ? 'drop' : 'retry';
        break;
      case 'later':
        t = parseTime(c.time);
        if (t === null) return 'такого времени не бывает: «' + c.time + '».';
        r.time = t;
        break;
    }
    return r;
  }

  // ---------- наложение на копию ----------
  // Возвращает новые данные { orders, vehicles, settings, … }; исходные не трогает.
  // Происшествия идущего дня данные не меняют (их разбирает js/replan.js), здесь они пропускаются.
  // Список должен быть уже проверен функцией check.
  function apply(data, list) {
    var d = copy({ orders: data.orders, vehicles: data.vehicles, settings: data.settings });
    Object.keys(data).forEach(function (k) { if (!(k in d)) d[k] = data[k]; });   // depot, roads — без копии, они не меняются
    list.forEach(function (c) {
      var v = c.vehicleId != null ? find(d.vehicles, c.vehicleId) : null, o = c.orderId != null ? find(d.orders, c.orderId) : null;
      if (c.kind === 'vehicle_off' && v) v.active = false;
      else if (c.kind === 'vehicle_on' && v) v.active = true;
      else if (c.kind === 'order_time' && o) {
        if (c.time != null) o.from = c.time;
        o.timeExplicit = !!c.important;
      } else if (c.kind === 'order_kg' && o) o.kg = c.kg;
      else if (c.kind === 'scale_kg') d.orders.forEach(function (x) { x.kg = scaledKg(x.kg, c.factor); });
      else if (c.kind === 'setting') d.settings[c.key] = c.value;
    });
    return d;
  }

  // Происшествие идущего дня → запись для MilkReplan.propose. plan — утверждённый план (как его вернул решатель):
  // по нему находим машину, если в записи её нет.
  function toIncident(c, plan) {
    var vid = c.vehicleId;
    if (vid == null && c.orderId != null && plan) plan.routes.forEach(function (r) {
      r.seq.forEach(function (i) { plan.stops[i].orders.forEach(function (o) { if (o.id === c.orderId) vid = r.vehicle.id; }); });
    });
    if (c.kind === 'breakdown') return { type: 'breakdown', vehicleId: vid, at: c.at };
    if (c.kind === 'delay') return { type: 'delay', vehicleId: vid, at: c.at, delayMin: c.minutes };
    if (c.kind === 'stop_refuses') return { type: 'stop', vehicleId: vid, at: c.at, orderId: c.orderId, action: c.action };
    if (c.kind === 'later') return { type: 'later', vehicleId: vid, at: c.at, orderId: c.orderId, retryAt: c.time };
    return null;
  }

  // ---------- описание словами ----------
  // Одна русская строка на изменение. data — данные ДО изменения (чтобы написать «было → станет»).
  function describe(c, data) {
    var v = c.vehicleId != null ? find(data.vehicles, c.vehicleId) : null, o = c.orderId != null ? find(data.orders, c.orderId) : null;
    var vn = v ? shortName(v) : 'Машина ' + c.vehicleId, on = o ? orderName(o) : 'Заказ № ' + c.orderId;
    switch (c.kind) {
      case 'vehicle_off': return vn + ' сегодня не выходит';
      case 'vehicle_on': return vn + ' выходит на линию';
      case 'order_time':
        if (c.time == null) return on + ': время выгрузки не важно, обычная точка';
        return on + ': разгрузка не раньше ' + clock(c.time) + (c.important ? ', важная точка' : ', не важная точка');
      case 'order_kg':
        if (c.kg === 0) return on + ': заказ отменён';
        return on + ': вес ' + (o ? num(o.kg) + ' → ' : '') + num(c.kg) + ' кг';
      case 'scale_kg':
        var d = Math.round((1 - c.factor) * 100);
        return 'Вес всех заказов ×' + num(c.factor) + (d > 0 ? ' (на ' + d + '% меньше)' : (d < 0 ? ' (на ' + (-d) + '% больше)' : ''));
      case 'setting':
        var was = data.settings ? data.settings[c.key] : undefined;
        return 'Правило «' + LABELS[c.key] + '»: ' + (was !== undefined ? settingText(c.key, was) + ' → ' : '') + settingText(c.key, c.value);
      case 'breakdown': return vn + ' сломалась в ' + clock(c.at);
      case 'delay': return (v ? vn : 'Машина') + ' задерживается на ' + c.minutes + ' мин (с ' + clock(c.at) + ')';
      case 'stop_refuses': return on + ' не принимает товар в ' + clock(c.at) + (c.action === 'drop' ? ': сегодня не доставляем' : ': вернуться позже');
      case 'later': return on + ' просит привезти не раньше ' + clock(c.time) + ' (сообщили в ' + clock(c.at) + ')';
    }
    return 'Неизвестное изменение';
  }
  function settingText(key, value) {
    if (CHOICES[key]) return '«' + (CHOICES[key][value] || value) + '»';
    if (typeof value === 'boolean') return value ? 'включено' : 'выключено';
    if (TIME_SETTINGS[key]) return clock(value);
    return num(value);
  }

  var api = { check: check, apply: apply, describe: describe, isLive: isLive, toIncident: toIncident, parseTime: parseTime,
    scaledKg: scaledKg, PLAN_KINDS: PLAN_KINDS, LIVE_KINDS: LIVE_KINDS, LABELS: LABELS };
  if (typeof window !== 'undefined') window.MilkChanges = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
