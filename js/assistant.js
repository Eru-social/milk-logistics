// КОМАНДА СЛОВАМИ на экране диспетчера (этап 2).
// Логист пишет, что изменилось → серверная функция (supabase/functions/assistant) переводит фразу в список действий →
// здесь мы находим магазины по названию и адресу и показываем карточку «Я понял так». Логист правит строки,
// отвечает на вопросы и нажимает «Посчитать» — дальше работает уже готовое: предложение «было → станет» (js/proposal.js)
// до утверждения плана или окно «Форс-мажор» (js/replan.js) в идущем дне.
//
// Почему так (решения 1–3, 7, 8 в CLAUDE.md):
// - модель ничего не считает, она только понимает слова; числа и маршруты — наш проверенный алгоритм;
// - карточка всегда показывается перед расчётом: если модель поняла не так, это видно и исправляется;
// - магазин ищет наш код, а не модель: список из 214 заказов не помещается в бесплатный лимит, и модель путала бы точки;
// - если модель недоступна (нет сети, нет ключа, лимит, 8 секунд без ответа) — та же карточка пустая, строки добавляются вручную.
//
// Строка карточки (row) — одно действие: { kind, vehicleId, query, groups, pick, time, at, minutes, kg, factor, key, value, action, important }.
//   query  — как логист назвал магазин; groups — найденные магазины: [{ ids: [номера заказов], title }];
//   pick   — какой из найденных выбран (номер в groups) или null, если логист ещё не выбрал.
// Повтор одного магазина в списке заказчика (та же организация по тому же адресу) — одна группа с двумя заказами:
// просьба магазина относится к обоим.
(function () {
  'use strict';
  var C = typeof window !== 'undefined' && window.MilkChanges ? window.MilkChanges : (typeof require !== 'undefined' ? require('./changes.js') : null);
  var TIMEOUT_MS = 8000, MAX_TEXT = 500;
  var PLAN_KINDS = ['vehicle_off', 'vehicle_on', 'order_time', 'order_kg', 'scale_kg', 'setting'];
  var LIVE_KINDS = ['breakdown', 'delay', 'stop_refuses', 'later'];
  var KIND_NAMES = {
    vehicle_off: 'Машина не выходит', vehicle_on: 'Машина снова на линии', order_time: 'Магазин просит другое время',
    order_kg: 'Другой вес заказа', scale_kg: 'Вес всех заказов', setting: 'Правило расчёта',
    breakdown: 'Машина сломалась', delay: 'Задержка в пути', stop_refuses: 'Точка не принимает', later: 'Магазин просит позже'
  };
  var SETTING_NAMES = { serviceMin: 'Разгрузка в обычной точке, мин', smallServiceMin: 'Разгрузка в мелкой точке, мин',
    smallStopKg: 'Мелкая точка — до, кг', shiftMin: 'Смена водителя, мин', minLoadPct: 'Минимальная загрузка, %',
    fleetPriority: 'Что важнее', earliestDepart: 'Первый выезд', trafficFactor: 'Запас на пробки, ×' };
  var EXAMPLES = {
    plan: ['У машин 3 и 9 водители заболели, магазин на Щорса просит после 10', 'Обычный день: вес всех заказов на 30% меньше',
      'Разгрузка 20 минут вместо 30', 'Машина 7 в ремонте'],
    live: ['Машина 4 сломалась', 'Машина 2 задерживается на 40 минут', 'Евроопт на Суворова просит привезти после 14:00',
      'Магазин №8 на Щорса не принимает товар']
  };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function clock(min) { min = Math.round(min); var h = Math.floor(min / 60), m = min % 60; return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m; }
  function short(v) { return String(v.name || ('Машина ' + v.id)).split(' · ')[0]; }

  // ---------- поиск магазина по словам логиста ----------
  // Каждое слово из фразы должно найтись в названии или адресе. Окончания русских слов отрезаем
  // («на Суворова», «в Доброноме» → «суворо», «доброно»), номера сравниваем целиком («№20» не совпадёт с «№208»).
  var SKIP = ['магазин', 'магазина', 'магазине', 'маг', 'на', 'ул', 'улица', 'улице', 'пр', 'проспект', 'в', 'во', 'и', 'у', 'с', 'по',
    'точка', 'точку', 'ооо', 'оао', 'зао', 'чуп', 'уп', 'ип', 'гродно', 'г'];
  function norm(s) { return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[«»"'`()[\]\/\\.,;:!?№#*+-]/g, ' ').replace(/(\d)([а-я])/g, '$1 $2').replace(/\s+/g, ' ').trim(); }
  function words(s) { return norm(s).split(' ').filter(function (w) { return w && SKIP.indexOf(w) < 0; }); }
  function wordMatches(q, hay) {
    if (/^\d+$/.test(q)) return hay.indexOf(q) >= 0;
    var stem = q.length <= 4 ? q : q.slice(0, Math.max(4, q.length - 2));
    return hay.some(function (w) { return q.length <= 3 ? w === q : w.indexOf(stem) === 0; });
  }
  function findStores(query, orders) {
    var q = words(query);
    if (!q.length) return [];
    var groups = [], byKey = {};
    (orders || []).forEach(function (o) {
      var hay = words(o.name + ' ' + o.address);
      if (!q.every(function (w) { return wordMatches(w, hay); })) return;
      var key = norm(o.name) + '|' + norm(o.address);
      if (!byKey[key]) { byKey[key] = { ids: [], title: '«' + o.name + '», ' + o.address }; groups.push(byKey[key]); }
      byKey[key].ids.push(o.id);
    });
    return groups;
  }

  // ---------- ответ функции → строки карточки ----------
  // answer — { changes, questions } (уже проверено серверной функцией: understand.mjs). data — { orders, vehicles }.
  function resolve(answer, data) {
    var rows = [], questions = (answer && answer.questions || []).slice();
    (answer && answer.changes || []).forEach(function (c) {
      var r = { kind: c.kind };
      ['time', 'at', 'minutes', 'kg', 'factor', 'key', 'value', 'action', 'important'].forEach(function (f) { if (c[f] != null) r[f] = c[f]; });
      if (c.vehicle != null) r.vehicleId = c.vehicle;
      if (c.store != null) storeInto(r, c.store, data);
      rows.push(r);
    });
    return { rows: rows, questions: questions };
  }
  function storeInto(r, query, data) {
    r.query = query;
    r.groups = findStores(query, data.orders);
    r.pick = r.groups.length === 1 ? 0 : null;
  }
  function emptyRow(kind, data) {
    var r = { kind: kind }, on = (data.vehicles || []).filter(function (v) { return v.active !== false; });
    if (['vehicle_off', 'vehicle_on', 'breakdown', 'delay'].indexOf(kind) >= 0) r.vehicleId = (on[0] || data.vehicles[0] || {}).id;
    if (['order_time', 'order_kg', 'stop_refuses', 'later'].indexOf(kind) >= 0) { r.query = ''; r.groups = []; r.pick = null; }
    if (kind === 'order_time' || kind === 'later') r.time = '10:00';
    if (kind === 'order_kg') r.kg = 0;
    if (kind === 'delay') r.minutes = 30;
    if (kind === 'scale_kg') r.factor = 0.7;
    if (kind === 'setting') { r.key = 'serviceMin'; r.value = 20; }
    if (kind === 'stop_refuses') r.action = 'retry';
    return r;
  }
  function needsStore(r) { return ['order_time', 'order_kg', 'stop_refuses', 'later'].indexOf(r.kind) >= 0; }
  function picked(r) { return needsStore(r) && r.pick != null && r.groups[r.pick] ? r.groups[r.pick] : null; }

  // Что не так со строками, словами. Пустой список — можно считать.
  function blockers(rows) {
    var out = [];
    if (!rows.length) out.push('Нет ни одной строки: добавьте изменение вручную или напишите фразу.');
    rows.forEach(function (r, i) {
      if (needsStore(r) && !picked(r)) out.push('Строка ' + (i + 1) + ': ' + (r.groups && r.groups.length ? 'выберите магазин из списка.' : 'магазин не найден, уточните название или улицу.'));
    });
    return out;
  }

  // Строки → список изменений в формате js/changes.js (до утверждения плана).
  // Просьба магазина с повтором в списке относится к обоим его заказам.
  function toChanges(rows) {
    var list = [];
    rows.forEach(function (r) {
      var g = picked(r), base = {};
      ['time', 'kg', 'factor', 'key', 'value', 'important'].forEach(function (f) { if (r[f] != null) base[f] = r[f]; });
      if (r.vehicleId != null) base.vehicleId = r.vehicleId;
      if (g) g.ids.forEach(function (id) { var c = JSON.parse(JSON.stringify(base)); c.kind = r.kind; c.orderId = id; list.push(c); });
      else { base.kind = r.kind; list.push(base); }
    });
    return list;
  }
  // Строки → очередь происшествий для окна «Форс-мажор» (идущий день). Время без «at» подставит само окно (по плану).
  function toIncidents(rows, vehicleOfOrder) {
    var out = [];
    rows.forEach(function (r) {
      var at = r.at != null && C ? C.parseTime(r.at) : null, ids = picked(r) ? picked(r).ids : [null];
      ids.forEach(function (oid) {
        var pre = { type: { breakdown: 'breakdown', delay: 'delay', stop_refuses: 'stop', later: 'later' }[r.kind] };
        if (at != null) pre.at = at;
        if (r.vehicleId != null) pre.vehicleId = r.vehicleId;
        if (oid != null) { pre.orderId = oid; if (pre.vehicleId == null && vehicleOfOrder) pre.vehicleId = vehicleOfOrder(oid); }
        if (r.kind === 'delay') pre.delayMin = Math.max(1, Math.round(+r.minutes || 0));
        if (r.kind === 'stop_refuses') pre.action = r.action === 'drop' ? 'drop' : 'retry';
        if (r.kind === 'later' && C && C.parseTime(r.time) != null) pre.laterAt = C.parseTime(r.time);
        pre.title = line(r, null);
        out.push(pre);
      });
    });
    return out;
  }

  // Одна строка словами (для проверок и для очереди происшествий).
  function line(r) {
    var g = picked(r), s = r.kind;
    if (r.vehicleId != null) s += ' v' + r.vehicleId;
    if (needsStore(r)) s += g ? ' #' + g.ids.join(',') : ' [выбрать из ' + (r.groups ? r.groups.length : 0) + ': ' + r.query + ']';
    ['time', 'at', 'minutes', 'kg', 'factor', 'action'].forEach(function (f) { if (r[f] != null) s += ' ' + f + '=' + r[f]; });
    if (r.key != null) s += ' ' + r.key + '=' + r.value;
    if (r.important === false) s += ' important=false';
    return s;
  }

  // ---------- карточка ----------
  // a — состояние: { mode, rows, questions, message, queue, busy }. data — { orders, vehicles }.
  function vehicleSelect(i, r, data) {
    return '<select data-row="' + i + '" data-field="vehicleId" aria-label="Машина">' + (data.vehicles || []).map(function (v) {
      return '<option value="' + v.id + '"' + (v.id === r.vehicleId ? ' selected' : '') + '>' + esc(short(v)) + (v.active === false ? ' (в гараже)' : '') + '</option>';
    }).join('') + '</select>';
  }
  function storeControl(i, r) {
    if (r.groups && r.groups.length === 1) return '<b>' + esc(r.groups[0].title) + '</b>' + (r.groups[0].ids.length > 1 ? ' <span class="pill">' + r.groups[0].ids.length + ' заказа</span>' : '');
    if (r.groups && r.groups.length > 1) return '<select data-row="' + i + '" data-field="pick" aria-label="Какой магазин">' +
      '<option value="">«' + esc(r.query) + '» — найдено ' + r.groups.length + ', выберите…</option>' + r.groups.map(function (g, n) {
        return '<option value="' + n + '"' + (n === r.pick ? ' selected' : '') + '>' + esc(g.title) + '</option>';
      }).join('') + '</select>';
    return '<input type="search" data-row="' + i + '" data-field="query" value="' + esc(r.query || '') + '" placeholder="Название или улица" aria-label="Магазин">' +
      (r.query ? ' <span class="pill bad">не нашёл</span>' : '');
  }
  function field(i, name, value, type, label, extra) {
    return '<input type="' + type + '" data-row="' + i + '" data-field="' + name + '" value="' + esc(value == null ? '' : value) + '" aria-label="' + label + '"' + (extra || '') + '>';
  }
  function rowHtml(r, i, data) {
    var body;
    switch (r.kind) {
      case 'vehicle_off': body = vehicleSelect(i, r, data) + ' сегодня не выходит'; break;
      case 'vehicle_on': body = vehicleSelect(i, r, data) + ' выходит на линию'; break;
      case 'order_time': body = storeControl(i, r) + (r.important === false ? ': время не важно' : ': не раньше ' + field(i, 'time', r.time, 'time', 'Время')); break;
      case 'order_kg': body = storeControl(i, r) + ': вес ' + field(i, 'kg', r.kg, 'number', 'Вес, кг', ' min="0" step="10"') + ' кг' + (+r.kg === 0 ? ' — заказ отменён' : ''); break;
      case 'scale_kg': body = 'Вес всех заказов × ' + field(i, 'factor', r.factor, 'number', 'Множитель', ' min="0.1" max="5" step="0.05"'); break;
      case 'setting':
        body = '<select data-row="' + i + '" data-field="key" aria-label="Правило">' + Object.keys(SETTING_NAMES).map(function (k) {
          return '<option value="' + k + '"' + (k === r.key ? ' selected' : '') + '>' + esc(SETTING_NAMES[k]) + '</option>';
        }).join('') + '</select> → ' + (r.key === 'fleetPriority'
          ? '<select data-row="' + i + '" data-field="value"><option value="fewer"' + (r.value === 'fewer' ? ' selected' : '') + '>меньше машин</option>' +
            '<option value="overtime"' + (r.value === 'overtime' ? ' selected' : '') + '>без переработки</option></select>'
          : field(i, 'value', r.value, 'text', 'Значение', ' size="6"'));
        break;
      case 'breakdown': body = vehicleSelect(i, r, data) + ' сломалась' + (r.at ? ' в ' + esc(r.at) : ', время — по плану (поправите в окне)'); break;
      case 'delay': body = vehicleSelect(i, r, data) + ' задерживается на ' + field(i, 'minutes', r.minutes, 'number', 'Минут', ' min="5" step="5"') + ' мин'; break;
      case 'stop_refuses': body = storeControl(i, r) + ' не принимает: <select data-row="' + i + '" data-field="action"><option value="retry"' + (r.action !== 'drop' ? ' selected' : '') +
        '>вернуться позже</option><option value="drop"' + (r.action === 'drop' ? ' selected' : '') + '>не везти сегодня</option></select>'; break;
      case 'later': body = storeControl(i, r) + ': привезти не раньше ' + field(i, 'time', r.time, 'time', 'Время'); break;
      default: body = esc(r.kind);
    }
    return '<li><span class="as-kind">' + esc(KIND_NAMES[r.kind] || r.kind) + '</span><span class="as-body">' + body + '</span>' +
      '<button type="button" class="as-del" data-del="' + i + '" title="Убрать строку" aria-label="Убрать строку">×</button></li>';
  }
  function card(a, data) {
    if (!a || (!a.rows && !a.message && !(a.queue && a.queue.length))) return '';
    var html = '<div class="as-card">';
    if (a.queue && a.queue.length) {
      return html + '<b>Дальше по очереди</b><ul class="as-queue">' + a.queue.map(function (p) { return '<li>' + esc(p.label) + '</li>'; }).join('') + '</ul>' +
        '<p class="fm-hint">Перестроение считается от утверждённого плана: сначала выберите вариант для прежнего происшествия и нажмите «Утвердить».</p>' +
        '<div class="proposal-actions"><button type="button" class="btn" id="as-cancel">Закрыть</button><button type="button" class="btn primary" id="as-next">Разобрать следующее</button></div></div>';
    }
    if (a.message) html += '<p class="fm-error">' + esc(a.message) + '</p>';
    if (a.rows) {
      html += '<b>' + (a.manual ? 'Заполните вручную' : 'Я понял так') + '</b>';
      if (a.rows.length) html += '<ol class="as-rows">' + a.rows.map(function (r, i) { return rowHtml(r, i, data); }).join('') + '</ol>';
      if (a.questions && a.questions.length) html += '<ul class="as-questions">' + a.questions.map(function (q) { return '<li>' + esc(q) + '</li>'; }).join('') + '</ul>';
      var kinds = a.mode === 'live' ? LIVE_KINDS : PLAN_KINDS;
      html += '<div class="as-add"><select id="as-add-kind" aria-label="Вид изменения">' + kinds.map(function (k) { return '<option value="' + k + '">' + esc(KIND_NAMES[k]) + '</option>'; }).join('') +
        '</select><button type="button" class="btn" id="as-add">Добавить строку</button></div>' +
        '<div class="proposal-actions"><button type="button" class="btn" id="as-cancel">Отменить</button>' +
        '<button type="button" class="btn primary" id="as-go"' + (a.rows.length ? '' : ' disabled') + '>' + (a.mode === 'live' ? 'Разобрать в окне «Форс-мажор»' : 'Посчитать предложение') + '</button></div>';
    } else html += '<div class="proposal-actions"><button type="button" class="btn" id="as-cancel">Закрыть</button></div>';
    return html + '</div>';
  }

  // ---------- запрос к серверной функции ----------
  function functionUrl() {
    var cfg = typeof window !== 'undefined' ? window.MILK_CONFIG : null;
    return cfg && cfg.supabaseUrl ? cfg.supabaseUrl.replace(/\/$/, '') + '/functions/v1/assistant' : '';
  }
  // Возвращает Promise<{ ok, changes, questions, message }>; никогда не падает — ошибка превращается в понятную строку.
  function ask(text, mode, vehicles, opts) {
    opts = opts || {};
    var url = opts.url || functionUrl(), key = opts.key || (typeof window !== 'undefined' && window.MILK_CONFIG ? window.MILK_CONFIG.supabaseKey : '');
    var doFetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
    if (!url || !doFetch) return Promise.resolve({ ok: false, message: 'Модель недоступна: сайт работает без базы. Заполните строки вручную.' });
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve({ ok: false, message: 'Нет интернета: модель недоступна. Заполните строки вручную.' });
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null, timer = null;
    var timeout = new Promise(function (resolve) {
      timer = setTimeout(function () { if (ctrl) ctrl.abort(); resolve({ ok: false, message: 'Модель не ответила за 8 секунд. Заполните строки вручную.' }); }, opts.timeoutMs || TIMEOUT_MS);
    });
    var req = doFetch(url, {
      method: 'POST', signal: ctrl ? ctrl.signal : undefined,
      headers: { 'Content-Type': 'application/json', apikey: key, Authorization: 'Bearer ' + key },
      body: JSON.stringify({ text: text, mode: mode, vehicles: (vehicles || []).map(function (v) { return { id: v.id, active: v.active !== false }; }) })
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (body && body.ok) return { ok: true, changes: body.changes || [], questions: body.questions || [] };
        return { ok: false, message: (body && body.message) || ('Функция ответила ошибкой ' + res.status + '. Заполните строки вручную.') };
      });
    }).catch(function () { return { ok: false, message: 'Модель недоступна. Заполните строки вручную.' }; });
    return Promise.race([req, timeout]).then(function (r) { clearTimeout(timer); return r; });
  }

  // ---------- подключение к экрану ----------
  // api от js/app.js: data() → { orders, vehicles, settings }; live() → идёт ли день; busy() → открыто ли предложение;
  // openProposal(list); openIncident(pre); vehicleOfOrder(orderId); toast(text, kind).
  function mount(rootId, api) {
    var root = document.getElementById(rootId), a = null, queue = [];
    root.innerHTML = '<div class="assistant"><label for="as-text"><b>Что изменилось?</b></label>' +
      '<div class="as-line"><input type="text" id="as-text" maxlength="' + MAX_TEXT + '" placeholder="Например: у машин 3 и 9 водители заболели">' +
      '<button type="button" class="btn primary" id="as-send">Понять</button></div><div class="as-examples" id="as-examples"></div><div id="as-card"></div></div>';
    var $ = function (id) { return document.getElementById(id); };
    function mode() { return api.live() ? 'live' : 'plan'; }
    function draw() { $('as-card').innerHTML = card(a, api.data()); }
    function refresh() {
      var m = mode();
      $('as-examples').innerHTML = EXAMPLES[m].map(function (t) { return '<button type="button" class="btn" data-example="' + esc(t) + '">' + esc(t) + '</button>'; }).join('');
      if (a && a.rows && a.mode !== m) { a = { message: 'План утвердили или сбросили, пока карточка была открыта. Напишите фразу заново.' }; draw(); }
    }
    function send(text) {
      text = String(text || '').trim();
      if (!text) { a = { mode: mode(), rows: [], questions: [], manual: true, message: 'Фраза пустая. Напишите, что изменилось, или добавьте строку вручную.' }; draw(); return; }
      if (text.length > MAX_TEXT) { a = { message: 'Фраза длиннее ' + MAX_TEXT + ' знаков. Напишите короче.' }; draw(); return; }
      var m = mode(), d = api.data();
      a = { message: '' }; $('as-card').innerHTML = '<div class="as-card"><p class="fm-hint">Разбираю фразу…</p></div>';
      $('as-send').disabled = true;
      ask(text, m, d.vehicles).then(function (res) {
        $('as-send').disabled = false;
        if (mode() !== m) { a = { message: 'Режим поменялся, пока модель думала. Нажмите «Понять» ещё раз.' }; draw(); return; }
        if (!res.ok) { a = { mode: m, rows: [], questions: [], manual: true, message: res.message }; draw(); return; }
        var r = resolve(res, api.data());
        a = { mode: m, rows: r.rows, questions: r.questions, message: '' };
        draw();
      });
    }
    function go() {
      var b = blockers(a.rows);
      if (b.length) { api.toast(b[0], 'warn'); return; }
      if (api.busy()) return;
      if (a.mode === 'plan') { var list = toChanges(a.rows); a = null; draw(); api.openProposal(list); return; }
      queue = toIncidents(a.rows, api.vehicleOfOrder).map(function (p) { p.label = p.title; return p; });
      a = null; next();
    }
    function next() {
      var p = queue.shift();
      a = queue.length ? { queue: queue } : null; draw();
      if (p) api.openIncident(p);
    }
    root.addEventListener('click', function (e) {
      var t = e.target.closest('button'); if (!t) return;
      if (t.id === 'as-send') send($('as-text').value);
      else if (t.hasAttribute('data-example')) { $('as-text').value = t.getAttribute('data-example'); send($('as-text').value); }
      else if (t.id === 'as-cancel') { a = null; queue = []; draw(); }
      else if (t.id === 'as-go') go();
      else if (t.id === 'as-next') next();
      else if (t.id === 'as-add') { a.rows.push(emptyRow($('as-add-kind').value, api.data())); draw(); }
      else if (t.hasAttribute('data-del')) { a.rows.splice(+t.getAttribute('data-del'), 1); draw(); }
    });
    root.addEventListener('keydown', function (e) { if (e.target.id === 'as-text' && e.key === 'Enter') { e.preventDefault(); send(e.target.value); } });
    root.addEventListener('change', function (e) {
      var t = e.target, i = t.getAttribute('data-row'), f = t.getAttribute('data-field');
      if (i == null || !a || !a.rows || !a.rows[+i]) return;
      var r = a.rows[+i], v = t.value;
      if (f === 'vehicleId') r.vehicleId = +v;
      else if (f === 'pick') r.pick = v === '' ? null : +v;
      else if (f === 'query') storeInto(r, v, api.data());
      else if (f === 'kg' || f === 'minutes' || f === 'factor') r[f] = +v;
      else if (f === 'key') { r.key = v; r.value = v === 'fleetPriority' ? 'overtime' : api.data().settings[v]; if (typeof r.value === 'number' && (v === 'earliestDepart')) r.value = clock(r.value); }
      else if (f === 'value') r.value = r.key === 'fleetPriority' || r.key === 'earliestDepart' ? v : (isFinite(+String(v).replace(',', '.')) ? +String(v).replace(',', '.') : v);
      else r[f] = v;
      draw();
    });
    refresh();
    return { refresh: refresh };
  }

  var api = { findStores: findStores, resolve: resolve, toChanges: toChanges, toIncidents: toIncidents, blockers: blockers,
    line: line, card: card, ask: ask, mount: mount, emptyRow: emptyRow, EXAMPLES: EXAMPLES };
  if (typeof window !== 'undefined') window.MilkAssistant = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
