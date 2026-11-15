// ЧАТ С ИИ в правой колонке экрана диспетчера (15 ноября, вечер, по просьбе автора).
// Заменяет три прежних блока: поле «Что изменилось?», кнопки «А если…» и кнопку «Форс-мажор».
// Путь один: логист пишет что угодно → ИИ отвечает сообщением с карточкой «Я понял так» → «Посчитать» →
// сообщение «было → станет». Решает логист: «Применить» (до утверждения) или «Утвердить» (когда день идёт).
//
// Подсказки под полем работают без ИИ: до утверждения это бывшие «А если…», когда день идёт — виды происшествий.
// Подсказка сразу даёт ту же карточку, заполненную нашим кодом. Если ИИ недоступен — карточка пустая, строки
// добавляются вручную (как раньше).
//
// Сам чат ничего не считает и в базу не пишет:
//   понимание фразы и карточка — js/assistant.js (и серверная функция supabase/functions/assistant);
//   предложение «было → станет» — js/proposal.js; перестроение идущего дня — js/replan.js;
//   всё это вызывается через экран (js/app.js, объект api в mount).
// Старый экран без чата — index.html?old=1.
//
// Сообщение в чате — объект { who: 'me' | 'ai', kind, … }:
//   text     — просто текст (html);
//   card     — карточка «Я понял так» (a — состояние карточки, как в assistant.js; open — можно править);
//   proposal — предложение «было → станет» (open — пока не применено и не отменено);
//   live     — варианты перестроения идущего дня (state: new → used → approved | closed);
//   queue    — «дальше по очереди», если в одной фразе несколько происшествий.
(function () {
  'use strict';
  var A = window.MilkAssistant, C = window.MilkChanges, P = window.MilkProposal;
  var MAX_TEXT = A.MAX_TEXT;
  var PLAN_HINTS = ['normal', 'unload25', 'small200', 'minus1', 'priority'];
  var LIVE_HINTS = [['breakdown', 'Машина сломалась'], ['delay', 'Задержка в пути'], ['stop_refuses', 'Точка не принимает'], ['later', 'Магазин просит другое время']];
  var INCIDENT = { breakdown: 'breakdown', delay: 'delay', stop: 'stop_refuses', later: 'later' };   // вид из окна → вид строки

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function clock(min) { min = Math.round(min); var h = Math.floor(min / 60) % 24, m = min % 60; return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m; }
  function hours(min) { min = Math.round(min); return min < 60 ? min + ' мин' : Math.floor(min / 60) + ' ч ' + (min % 60 < 10 ? '0' : '') + (min % 60) + ' мин'; }
  function num(x) { return Math.round(x).toLocaleString('ru-RU'); }
  function nowText() { var d = new Date(); return clock(d.getHours() * 60 + d.getMinutes()); }

  function mount(rootId, api) {
    var root = document.getElementById(rootId);
    var log = [];          // все сообщения по порядку
    var card = null;       // открытая карточка «Я понял так» (одна на весь чат)
    var queue = [];        // происшествия, которые ждут своей очереди
    var lastMode = null, sending = false, drawn = '', freshMsg = false;
    root.innerHTML = '<div class="chat">' +
      '<div class="chat-head"><b>Что изменилось?</b><span>чат с ИИ · решаете вы</span></div>' +
      '<div class="chat-log" id="ch-log" aria-live="polite"></div>' +
      '<div class="chat-line"><textarea id="ch-text" rows="2" maxlength="' + MAX_TEXT + '" aria-label="Сообщение"></textarea>' +
      '<button type="button" class="btn primary" id="ch-send">Отправить</button></div>' +
      '<div class="chat-hints" id="ch-hints"></div></div>';
    function $(id) { return document.getElementById(id); }
    function mode() { return api.live() ? 'live' : 'plan'; }
    function push(m) { log.push(m); freshMsg = true; return m; }
    function remove(m) { var i = log.indexOf(m); if (i >= 0) log.splice(i, 1); }
    function say(html, who) { return push({ who: who || 'ai', kind: 'text', html: html, label: 'Программа' }); }
    function later(fn) { setTimeout(fn, 30); }   // дать экрану показать «Считаю…» перед расчётом на 2–4 секунды

    // ---------- строки карточки словами (для сообщений, где карточка уже закрыта) ----------
    function vehicleName(id, d) {
      var v = (d.vehicles || []).filter(function (x) { return x.id === id; })[0];
      return v ? String(v.name).split(' · ')[0] : 'Машина ' + id;
    }
    function rowText(r, d) {
      var g = A.picked(r), store = g ? g.title : '«' + (r.query || '?') + '»', at = r.at ? ' в ' + r.at : '';
      switch (r.kind) {
        case 'breakdown': return vehicleName(r.vehicleId, d) + ' сломалась' + at;
        case 'delay': return vehicleName(r.vehicleId, d) + ' задерживается на ' + r.minutes + ' мин' + at;
        case 'stop_refuses': return store + ' не принимает' + at + (r.action === 'drop' ? ': не везти сегодня' : ': вернуться позже');
        case 'later': return store + ': привезти не раньше ' + r.time + (r.at ? ' (сообщили' + at + ')' : '');
      }
      var chk;
      try { chk = C.check(A.toChanges([r]), d); } catch (e) { chk = { ok: false, errors: [e.message] }; }
      return chk.ok ? chk.list.map(function (c) { return C.describe(c, d); }).join('; ') : (A.KIND_NAMES[r.kind] || r.kind) + ': ' + chk.errors.join('; ');
    }

    // ---------- сообщения ----------
    function variantPills(s) {             // те же отметки, что в окне «Форс-мажор»
      var pills = s.dropped ? '<span class="pill bad">не доставим ' + s.dropped + ' точ., ' + num(s.droppedKg) + ' кг</span>' : '<span class="pill good">довезём всё</span>';
      var more = s.overtime - s.overtimeWas;
      if (s.overtime <= 0.5) pills += '<span class="pill good">без переработки</span>';
      else if (s.overtimeWas > 0.5) pills += more > 0.5 ? '<span class="pill warn">переработка +' + hours(more) + '</span>' : '<span class="pill good">переработка не растёт</span>';
      else pills += '<span class="pill warn">переработка ' + hours(s.overtime) + ' на ' + s.overtimeVehicles + ' вод.</span>';
      if (s.late.length) pills += '<span class="pill warn">опоздают ' + s.late.length + ' точ.</span>';
      return pills;
    }
    function liveHtml(m, i) {
      var r = m.res, v = r.variants[m.sel], act = m.state === 'new' || m.state === 'used', many = r.variants.length > 1;
      var html = '<b>' + esc(r.title) + '</b><p class="msg-note">' + esc(r.status) + '</p>';
      if (many) {
        html += '<p class="msg-note">Довезти всё без переработки не получается, поэтому вариантов несколько. Выбор за вами.</p><div class="variants col">';
        r.variants.forEach(function (x, n) {
          html += '<button type="button" class="variant' + (n === m.sel ? ' on' : '') + '" data-act="sel" data-msg="' + i + '" data-n="' + n + '"' + (act ? '' : ' disabled') +
            ' aria-pressed="' + (n === m.sel) + '"><b>' + esc(x.name) + '</b><span>' + (n === m.used ? 'на карте' : 'посмотреть') + '</span></button>';
        });
        html += '</div>';
      } else html += '<p class="msg-note">Вариант «' + esc(v.name) + '».</p>';
      html += '<div class="route-flags">' + variantPills(v.stats) + '</div><ul class="msg-lines">' +
        v.lines.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>' + P.goalsTable(r.before, v.after);
      if (act) {
        html += '<div class="proposal-actions">';
        if (m.used !== m.sel) html += '<button type="button" class="btn primary" data-act="show" data-msg="' + i + '">Показать на карте</button>';
        if (m.used >= 0) html += '<button type="button" class="btn' + (m.used === m.sel ? ' primary' : '') + '" data-act="approve" data-msg="' + i + '">Утвердить' +
          (many ? ' «' + esc(r.variants[m.used].name) + '»' : '') + '</button>' +
          '<button type="button" class="btn" data-act="cancel" data-msg="' + i + '">Отменить</button>';
        else html += '<button type="button" class="btn" data-act="close" data-msg="' + i + '">Закрыть</button>';
        html += '</div><p class="msg-note">' + (m.used >= 0 ? 'Вариант «' + esc(r.variants[m.used].name) + '» на карте как черновик. Водители увидят его после «Утвердить».' :
          'Пока это только расчёт: на карте и у водителей ничего не поменялось.') + '</p>';
      } else if (m.note) html += '<p class="msg-done">' + esc(m.note) + '</p>';
      return html;
    }
    function cardHtml(m) {
      var intro = '';
      if (m.hint) intro = '<p class="msg-note">Подсказка без ИИ. Проверьте строку и нажмите «Посчитать».</p>';
      else if (m.follow) intro = '<p class="msg-note">Учёл и прошлую фразу.</p>';
      if (!m.a.manual && !m.a.rows.length && !(m.a.questions || []).length) intro += '<p class="msg-note">Не нашёл в фразе, что поменять. Уточните или добавьте строку вручную.</p>';
      return intro + A.card(m.a, api.data(), { liveTime: m.a.mode === 'live', goLabel: 'Посчитать' });
    }
    // Закрытое предложение остаётся в чате как было, только без кнопок.
    function freezeProposal(html) {
      return String(html || '').replace(/<div class="proposal-actions">[\s\S]*?<\/div>/g, '')
        .replace(/<button type="button" class="variant/g, '<button type="button" disabled class="variant')
        .replace(/<p class="proposal-note">На карте и в маршрутах[\s\S]*?<\/p>/, '')
        .replace('Предложение: ещё не в общем плане', 'Предложение');
    }
    function msgHtml(m, i) {
      var body = '', label = m.label || '';
      if (m.kind === 'text') body = m.html;
      else if (m.kind === 'card') { label = m.hint || m.a.manual ? 'Без ИИ' : 'ИИ'; body = m.open ? cardHtml(m) : m.html; }
      else if (m.kind === 'proposal') {
        label = 'Расчёт';
        if (m.open) { var p = api.proposal(); if (p) m.last = P.card(p); body = m.last || ''; }
        else body = freezeProposal(m.last) + (m.note ? '<p class="msg-done">' + esc(m.note) + '</p>' : '');
      } else if (m.kind === 'live') { label = 'Расчёт'; body = liveHtml(m, i); }
      else if (m.kind === 'queue') {
        label = 'Программа';
        body = '<b>Дальше по очереди</b><ul class="msg-lines">' + m.items.map(function (p) { return '<li>' + esc(p.label) + '</li>'; }).join('') + '</ul>' +
          (m.open ? '<div class="proposal-actions"><button type="button" class="btn primary" data-act="next" data-msg="' + i + '">Посчитать следующее</button>' +
            '<button type="button" class="btn" data-act="drop-queue" data-msg="' + i + '">Не надо</button></div>' : '<p class="msg-done">' + esc(m.note || '') + '</p>');
      }
      var bare = (m.kind === 'card' && m.open) || (m.kind === 'proposal');
      return '<div class="msg ' + m.who + (bare ? ' bare' : '') + '">' + (m.who === 'ai' && label ? '<span class="msg-who">' + label + '</span>' : '') + body + '</div>';
    }
    function draw() {
      var html = log.map(msgHtml).join(''), el = $('ch-log');
      if (html !== drawn) { el.innerHTML = html; drawn = html; }
      // Новое сообщение показываем с начала: длинное «было → станет» читается сверху, а не с кнопок внизу.
      if (freshMsg) { freshMsg = false; var last = el.lastElementChild; el.scrollTop = last && last.offsetTop != null ? Math.max(0, last.offsetTop - 8) : (el.scrollHeight || 0); }
    }
    // Подписи подсказок до утверждения — те же, что были у кнопок «А если…».
    function planHintNames() {
      var st = api.data().settings;
      return { normal: 'Обычный день: вес на 30% меньше', unload25: 'Разгрузка 25 мин вместо ' + st.serviceMin,
        small200: 'Мелкая точка — до 200 кг вместо ' + st.smallStopKg, minus1: 'Минус одна машина',
        priority: st.fleetPriority === 'overtime' ? 'Меньше машин, загрузка не ниже 90%' : 'Без переработки, машин сколько нужно' };
    }
    function hintsHtml(m) {
      var html = '<span>Подсказки без ИИ:</span>';
      if (m === 'plan') {
        var names = planHintNames();
        PLAN_HINTS.forEach(function (k) { html += '<button type="button" class="btn" data-hint="' + k + '">' + esc(names[k]) + '</button>'; });
      } else LIVE_HINTS.forEach(function (h) { html += '<button type="button" class="btn" data-hint="' + h[0] + '">' + esc(h[1]) + '</button>'; });
      return html;
    }
    function greet(m) {
      say(m === 'plan' ?
        'Напишите, что изменилось на завтра, — например: «у машин 3 и 9 водители заболели, магазин на Щорса просит после 10». ' +
        'ИИ только переводит слова в список изменений: я покажу, как понял, маршруты посчитает наш алгоритм, решите вы.' :
        'План утверждён, день идёт. Напишите, что случилось в пути: «машина 4 сломалась», «магазин №8 на Щорса не принимает товар». ' +
        'Уже сделанное не меняется, перестраивается остаток дня.');
    }

    // ---------- карточка «Я понял так» ----------
    // Время происшествия по плану (как в окне «Форс-мажор»): по отметкам водителя, иначе середина маршрута.
    // Подставляем само и пересчитываем, когда меняют машину или магазин, пока логист не поправил время руками.
    function autoAt(r) {
      if (A.LIVE_KINDS.indexOf(r.kind) < 0 || (r.at && !r.atAuto)) return;
      var g = A.picked(r), vid = r.vehicleId != null ? r.vehicleId : (g ? api.vehicleOfOrder(g.ids[0]) : null);
      r.at = vid ? api.suggestAt(vid) : ''; r.atAuto = true;
    }
    function closeCard(note) {
      if (!card) return;
      var m = card, d = api.data();
      m.open = false; card = null;
      m.html = '<b>' + (m.a.manual ? 'Заполнено вручную' : 'Я понял так') + '</b>' +
        (m.a.rows.length ? '<ol class="msg-lines">' + m.a.rows.map(function (r) { return '<li>' + esc(rowText(r, d)) + '</li>'; }).join('') + '</ol>' : '') +
        '<p class="msg-done">' + esc(note) + '</p>';
    }
    function openCard(a, extra) {
      closeCard('Заменена новой.');
      a.rows.forEach(autoAt);
      card = push(Object.assign({ who: 'ai', kind: 'card', open: true, a: a }, extra || {}));
      draw();
    }

    // ---------- фраза → ИИ ----------
    function send(text) {
      text = String(text || '').trim();
      if (sending) return;
      if (!text) { api.toast('Напишите, что изменилось, или нажмите подсказку под полем.', 'warn'); return; }
      push({ who: 'me', kind: 'text', html: esc(text.length > 300 ? text.slice(0, 300) + '…' : text) });
      $('ch-text').value = '';
      if (text.length > MAX_TEXT) { say('Фраза длиннее ' + MAX_TEXT + ' знаков. Напишите короче, по одному-два изменения.'); draw(); return; }
      var m = mode(), d = api.data(), follow = null;
      // Ответ на вопрос ИИ: функция не помнит прошлых фраз, поэтому отправляем обе вместе (если влезают в лимит).
      if (card && card.open && card.text && (card.a.questions || []).length && card.a.mode === m && (card.text + '. ' + text).length <= MAX_TEXT) follow = card.text + '. ' + text;
      var wait = say('<p class="msg-note">Разбираю фразу…</p>');
      sending = true; $('ch-send').disabled = true; draw();
      A.ask(follow || text, m, d.vehicles).then(function (res) {
        sending = false; $('ch-send').disabled = false; remove(wait);
        if (mode() !== m) { say('Пока ИИ думал, план утвердили или сбросили. Отправьте фразу ещё раз.'); draw(); return; }
        if (!res.ok) { openCard({ mode: m, rows: [], questions: [], manual: true, message: res.message }); return; }
        var r = A.resolve(res, api.data());
        openCard({ mode: m, rows: r.rows, questions: r.questions, message: '' }, { text: follow || text, follow: !!follow });
      });
    }
    // Подсказка без ИИ: строки собирает наш код, дальше та же карточка.
    function hint(key) {
      var d = api.data(), m = mode(), rows, label;
      if (m === 'plan') {
        if (PLAN_HINTS.indexOf(key) < 0) return;
        rows = P.scenario(key, d, api.leastLoaded()).map(function (c) { return JSON.parse(JSON.stringify(c)); });
        label = planHintNames()[key];
      } else {
        var h = LIVE_HINTS.filter(function (x) { return x[0] === key; })[0];
        if (!h) return;
        var r = A.emptyRow(key, d);
        if (r.vehicleId != null) r.vehicleId = api.firstInRoute() || r.vehicleId;
        rows = [r]; label = h[1];
      }
      push({ who: 'me', kind: 'text', html: esc(label) });
      openCard({ mode: m, rows: rows, questions: [], message: '' }, { hint: true });
    }

    // ---------- «Посчитать» ----------
    function go() {
      var m = card;
      if (!m) return;
      var b = A.blockers(m.a.rows);
      if (b.length) { api.toast(b[0], 'warn'); return; }
      if (m.a.mode !== mode()) { closeCard('План утвердили или сбросили, пока карточка была открыта. Напишите заново.'); draw(); return; }
      if (api.busy()) return;
      if (m.a.mode === 'plan') {
        var list = A.toChanges(m.a.rows);
        closeCard('Считаю ↓');
        var wait = say('<p class="msg-note">Считаю предложение: наш алгоритм, 2–4 секунды…</p>');
        draw();
        later(function () {
          remove(wait);
          if (m.html) m.html = m.html.replace('Считаю ↓', 'Посчитано ↓');
          api.openProposal(list);
          var p = api.proposal();
          if (p && !p.ok) {                // ошибка в строках: показываем причину, предложение сразу закрываем
            var html = P.card(p);
            api.dropProposal();
            push({ who: 'ai', kind: 'proposal', open: false, last: html, note: 'Поправьте строки и посчитайте снова.' });
          } else if (p) push({ who: 'ai', kind: 'proposal', open: true });
          draw();
        });
        return;
      }
      // Идущий день: каждое происшествие считается от утверждённого плана, поэтому по очереди (решение 5).
      var d = api.data();
      queue = [];
      m.a.rows.forEach(function (r) {
        var pres = A.toIncidents([r], api.vehicleOfOrder), text = rowText(r, d);
        pres.forEach(function (p, n) { p.label = text + (pres.length > 1 ? ' (заказ ' + (n + 1) + ' из ' + pres.length + ')' : ''); queue.push(p); });
      });
      closeCard('Считаю ↓');
      if (m.html) m.html = m.html.replace('Считаю ↓', 'Посчитано ↓');
      nextIncident();
    }
    function nextIncident() {
      var pre = queue.shift();
      if (!pre) { draw(); return; }
      var wait = say('<p class="msg-note">Перестраиваю остаток дня: ' + esc(pre.label) + '…</p>');
      draw();
      later(function () {
        remove(wait);
        var res = api.replan(pre);
        if (!res.ok) {
          say('<b>' + esc(pre.label) + '</b><p class="msg-error">' + esc(res.message) + '</p>');
          if (queue.length) pushQueue();
        } else push({ who: 'ai', kind: 'live', res: res, sel: 0, used: -1, state: 'new', label: pre.label });
        draw();
      });
    }
    function pushQueue() {
      log.forEach(function (x) { if (x.kind === 'queue' && x.open) { x.open = false; x.note = 'Список обновлён ниже.'; } });
      push({ who: 'ai', kind: 'queue', open: true, items: queue.slice() });
    }
    function liveDone(m, state, note) {
      m.state = state; m.note = m.note || note;
      if (queue.length) pushQueue();
    }
    function act(i, what, n) {
      var m = log[i];
      if (!m) return;
      if (m.kind === 'queue' && m.open) {
        m.open = false;
        if (what === 'next') { m.note = 'Считаю ↓'; nextIncident(); }
        else { m.note = 'Отложено: напишите снова, когда понадобится.'; queue = []; draw(); }
        return;
      }
      if (m.kind !== 'live' || (m.state !== 'new' && m.state !== 'used')) return;
      if (what === 'sel') { m.sel = +n; draw(); return; }
      if (what === 'show') {
        if (api.proposal()) { api.busy(); return; }
        m.state = 'busy';                 // пока вариант ставится черновиком, refresh() это сообщение не закрывает
        log.forEach(function (x) { if (x !== m && x.kind === 'live' && x.state === 'new') { x.state = 'closed'; x.note = 'Вместо этого — следующее сообщение.'; } });
        api.useVariant(m.res.variants[m.sel]);
        m.used = m.sel; m.key = api.draftKey(); m.state = 'used';
        draw(); return;
      }
      if (what === 'approve') { m.sel = m.used; api.approve(); return; }
      if (what === 'cancel') { m.note = 'Отменено: показан утверждённый план, водители едут по нему.'; api.cancelDraft(); return; }
      if (what === 'close') { liveDone(m, 'closed', 'Закрыто: ничего не меняли.'); draw(); }
    }

    // ---------- связь с экраном ----------
    // Экран зовёт refresh() после каждой отрисовки: здесь чат замечает, что план утвердили, сбросили или поменяли.
    function refresh() {
      var m = mode();
      if (lastMode === null) greet(m);
      else if (m !== lastMode) {
        if (m === 'live') say('План утверждён: водители видят маршруты. Теперь пишите, что случилось в пути — поломка, задержка, магазин не принимает или просит другое время.');
        else say('План снова не утверждён. Пишите изменения на завтра.');
      }
      lastMode = m;
      $('ch-hints').innerHTML = hintsHtml(m);
      $('ch-text').placeholder = m === 'plan' ? 'Например: у машин 3 и 9 водители заболели' : 'Например: машина 4 сломалась';
      if (card && card.a.mode !== m) closeCard('План утвердили или сбросили, пока карточка была открыта. Напишите заново.');
      log.forEach(function (x) {
        if (x.kind === 'proposal' && x.open && !api.proposal()) { x.open = false; x.note = x.note || 'Предложение закрыто.'; }
        if (x.kind === 'live' && x.state === 'used') {
          if (api.draftKey() !== x.key) liveDone(x, 'closed', 'Черновик поменялся: этот вариант больше не на карте.');
          else if (api.approval() === 'same') liveDone(x, 'approved', 'Утверждено в ' + nowText() + ': водители видят новые маршруты.');
        }
        if (x.kind === 'live' && x.state === 'new' && m !== 'live') { x.state = 'closed'; x.note = 'План сброшен.'; }
        if (x.kind === 'queue' && x.open && m !== 'live') { x.open = false; x.note = 'План сброшен.'; queue = []; }
      });
      draw();
    }
    function closeProposal(note) {
      for (var i = log.length - 1; i >= 0; i--) {
        var x = log[i];
        if (x.kind === 'proposal' && x.open) {
          var p = api.proposal(); if (p) x.last = P.card(p);
          x.open = false; x.note = note; draw(); return;
        }
      }
    }
    // Сообщение водителя о проблеме («Перестроить» в ленте) → карточка с заполненной строкой.
    function fromEvent(pre, text) {
      var d = api.data(), r = A.emptyRow(INCIDENT[pre.type] || 'delay', d);
      if (pre.vehicleId != null) r.vehicleId = pre.vehicleId;
      if (pre.orderId && A.needsStore(r)) {
        var o = d.orders.filter(function (x) { return x.id === pre.orderId; })[0];
        r.query = o ? o.name : ''; r.groups = o ? [{ ids: [o.id], title: '«' + o.name + '», ' + o.address }] : []; r.pick = o ? 0 : null;
      }
      say('Сообщение водителя: ' + esc(text));
      openCard({ mode: mode(), rows: [r], questions: [], message: '' }, { hint: true });
    }
    function reset() { log = []; card = null; queue = []; lastMode = null; drawn = ''; sending = false; $('ch-send').disabled = false; }

    root.addEventListener('click', function (e) {
      var t = e.target && e.target.closest ? e.target.closest('button') : e.target;
      if (!t || t.disabled) return;
      if (t.id === 'ch-send') return send($('ch-text').value);
      if (t.hasAttribute('data-hint')) return hint(t.getAttribute('data-hint'));
      if (t.id === 'prop-apply' || t.id === 'prop-cancel' || t.hasAttribute('data-variant')) return api.proposalClick(e);
      if (t.hasAttribute('data-act')) return act(+t.getAttribute('data-msg'), t.getAttribute('data-act'), t.getAttribute('data-n'));
      if (!card) return;
      if (t.id === 'as-go') return go();
      if (t.id === 'as-cancel') { closeCard('Отменено.'); return draw(); }
      if (t.id === 'as-add') { var r = A.emptyRow($('as-add-kind').value, api.data()); if (card.a.mode === 'live' && r.vehicleId != null) r.vehicleId = api.firstInRoute() || r.vehicleId; autoAt(r); card.a.rows.push(r); return draw(); }
      if (t.hasAttribute('data-del')) { card.a.rows.splice(+t.getAttribute('data-del'), 1); return draw(); }
    });
    root.addEventListener('keydown', function (e) {
      if (e.target && e.target.id === 'ch-text' && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(e.target.value); }
    });
    root.addEventListener('change', function (e) {
      var t = e.target, i = t.getAttribute('data-row'), f = t.getAttribute('data-field');
      if (i == null || !card || !card.a.rows[+i]) return;
      var r = card.a.rows[+i];
      A.edit(r, f, t.value, api.data());
      if (f === 'at') r.atAuto = false;
      if (f === 'vehicleId' || f === 'pick' || f === 'query') autoAt(r);
      draw();
    });
    return { refresh: refresh, closeProposal: closeProposal, fromEvent: fromEvent, reset: reset,
      send: send, hint: hint };
  }

  window.MilkChat = { mount: mount };
})();
