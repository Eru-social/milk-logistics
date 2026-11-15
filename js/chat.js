// ЧАТ С ИИ в правой колонке экрана диспетчера (15 ноября, вечер, по просьбе автора).
// Заменяет три прежних блока: поле «Что изменилось?», кнопки «А если…» и кнопку «Форс-мажор».
//
// Суть: логист пишет, что изменилось → ИИ переводит слова в изменения → программа сразу считает →
// в чате «понял так» и «было → станет» → логист применяет, отменяет или поправляет. Лишних шагов нет:
//   — если ИИ понял всё, расчёт начинается сам (без кнопки «Посчитать»);
//   — если чего-то не хватает, чат спрашивает словами, как в переписке: ИИ — «на сколько минут?», наш код —
//     «на Щорса пять магазинов, какой?» (можно ответить словами или нажать). Ответ уходит в ИИ вместе с прошлой фразой;
//   — форма со строками осталась только на случай, когда ИИ недоступен (нет сети, лимит);
//   — до утверждения номер машины не нужен: «один водитель заболел» — какую машину убрать, выбирает программа;
//   — когда день идёт, первый вариант перестроения сразу на карте, остаётся «Утвердить» или «Отменить».
// Подсказки под полем работают без ИИ: до утверждения — бывшие «А если…», когда день идёт — виды происшествий.
//
// Сам чат ничего не считает и в базу не пишет: понимание фразы — js/assistant.js (и серверная функция),
// предложение — js/proposal.js, перестроение идущего дня — js/replan.js; всё через экран (js/app.js, api в mount).
// Старый экран без чата — index.html?old=1.
//
// Сообщение — объект { who: 'me' | 'ai', kind, … }:
//   text     — просто текст (html);
//   card     — карточка «Я понял так» (a — состояние карточки, как в assistant.js; open — можно править);
//   proposal — предложение «было → станет» (open — пока не применено и не отменено; rows — для «Поправить»);
//   live     — перестроение идущего дня (state: new → used → approved | closed; rows — для «Поправить»).
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
  function copy(x) { return JSON.parse(JSON.stringify(x)); }
  function nowText() { var d = new Date(); return clock(d.getHours() * 60 + d.getMinutes()); }

  function mount(rootId, api) {
    var root = document.getElementById(rootId);
    var log = [];          // все сообщения по порядку
    var card = null;       // открытая карточка «Я понял так» (одна на весь чат)
    var queue = [];        // происшествия из одной фразы, которые ждут своей очереди
    var lastMode = null, sending = false, drawn = '', freshMsg = false;
    // Чего чат ждёт от логиста после своего вопроса (уточнение — словами, как в переписке):
    //   { type: 'ai', text, mode, joiner }   — ИИ спросил или логист сказал «понял не так»: ответ уйдёт в ИИ вместе с прошлой фразой;
    //   { type: 'store', a, i, extra }       — какой магазин из нескольких (или не нашли): ответ разбирает наш код.
    var pending = null;
    root.innerHTML = '<div class="chat">' +
      '<div class="chat-log" id="ch-log" aria-live="polite"></div>' +
      '<div class="chat-line"><textarea id="ch-text" rows="2" maxlength="' + MAX_TEXT + '" aria-label="Сообщение"></textarea>' +
      '<button type="button" class="btn primary" id="ch-send">Отправить</button></div>' +
      '<div class="chat-hints" id="ch-hints"></div></div>';
    function $(id) { return document.getElementById(id); }
    function mode() { return api.live() ? 'live' : 'plan'; }
    function push(m) { log.push(m); freshMsg = true; return m; }
    function remove(m) { var i = log.indexOf(m); if (i >= 0) log.splice(i, 1); }
    function say(html) { return push({ who: 'ai', kind: 'text', html: html, label: 'Программа' }); }
    function later(fn) { setTimeout(fn, 30); }   // дать экрану показать «Считаю…» перед расчётом на 2–4 секунды

    // ---------- строки словами ----------
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
      var t = chk.ok ? chk.list.map(function (c) { return C.describe(c, d); }).join('; ') : (A.KIND_NAMES[r.kind] || r.kind) + ': ' + chk.errors.join('; ');
      return t + (r.auto ? ' (какую — выбрала программа: номер не важен)' : '');
    }
    // Что уже понято, словами — с точным магазином и машиной. Для «Понял не так — поправить»: ИИ получает это и поправку,
    // и не переспрашивает то, что логист уже уточнил («какой магазин на Щорса»).
    function summaryText(a) { var d = api.data(); return a.rows.map(function (r) { return rowText(r, d).replace(/ \(какую — выбрала.*\)$/, ''); }).join('. '); }
    function summaryHtml(a, note) {
      var d = api.data();
      return '<b>' + (a.manual ? 'Заполнено вручную' : 'Понял так') + '</b>' +
        (a.rows.length ? '<ol class="msg-lines">' + a.rows.map(function (r) { return '<li>' + esc(rowText(r, d)) + '</li>'; }).join('') + '</ol>' : '') +
        (note ? '<p class="msg-done">' + esc(note) + '</p>' : '');
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
    function fixButton(i) { return '<button type="button" class="link msg-fix" data-act="fix" data-msg="' + i + '">Понял не так — поправить</button>'; }
    function liveHtml(m, i) {
      var r = m.res, sel = m.used >= 0 ? m.used : 0, v = r.variants[sel], act = m.state === 'new' || m.state === 'used', many = r.variants.length > 1;
      var html = '<b>' + esc(r.title) + '</b><p class="msg-note">' + esc(r.status) + '</p>';
      if (many) {
        html += '<p class="msg-note">Без переработки всё не довезти — вариантов несколько, на карте выбранный:</p><div class="variants col">';
        r.variants.forEach(function (x, n) {
          html += '<button type="button" class="variant' + (n === sel ? ' on' : '') + '" data-act="show" data-msg="' + i + '" data-n="' + n + '"' + (act ? '' : ' disabled') +
            ' aria-pressed="' + (n === sel) + '"><b>' + esc(x.name) + '</b></button>';
        });
        html += '</div>';
      }
      html += '<div class="route-flags">' + variantPills(v.stats) + '</div><ul class="msg-lines">' +
        v.lines.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>' + P.goalsTable(r.before, v.after);
      if (act) {
        html += '<div class="proposal-actions">' + (m.used >= 0 ?
          '<button type="button" class="btn primary" data-act="approve" data-msg="' + i + '">Утвердить</button>' +
          '<button type="button" class="btn" data-act="cancel" data-msg="' + i + '">Отменить</button>' :
          '<button type="button" class="btn primary" data-act="show" data-msg="' + i + '" data-n="0">Показать на карте</button>') + '</div>' + fixButton(i);
      } else if (m.note) html += '<p class="msg-done">' + esc(m.note) + '</p>';
      return html;
    }
    function cardHtml(m) {
      var intro = '';
      if (m.follow) intro = '<p class="msg-note">Учёл и прошлую фразу.</p>';
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
      else if (m.kind === 'card') { label = m.noAi || m.a.manual ? 'Без ИИ' : 'ИИ'; body = m.open ? cardHtml(m) : m.html; }
      else if (m.kind === 'proposal') {
        label = 'Расчёт';
        if (m.open) { var p = api.proposal(); if (p) m.last = P.card(p); body = (m.last || '') + (m.rows ? fixButton(i) : ''); }
        else body = freezeProposal(m.last) + (m.note ? '<p class="msg-done">' + esc(m.note) + '</p>' : '');
      } else if (m.kind === 'live') { label = 'Расчёт'; body = liveHtml(m, i); }
      var bare = (m.kind === 'card' && m.open) || m.kind === 'proposal';
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
      var html = '<span>Без ИИ:</span>';
      if (m === 'plan') {
        var names = planHintNames();
        PLAN_HINTS.forEach(function (k) { html += '<button type="button" class="btn" data-hint="' + k + '">' + esc(names[k]) + '</button>'; });
      } else LIVE_HINTS.forEach(function (h) { html += '<button type="button" class="btn" data-hint="' + h[0] + '">' + esc(h[1]) + '</button>'; });
      return html;
    }

    // ---------- понимание → расчёт ----------
    // Время происшествия по плану (как в окне «Форс-мажор»): по отметкам водителя, иначе середина маршрута.
    function autoAt(r) {
      if (A.LIVE_KINDS.indexOf(r.kind) < 0 || (r.at && !r.atAuto)) return;
      var g = A.picked(r), vid = r.vehicleId != null ? r.vehicleId : (g ? api.vehicleOfOrder(g.ids[0]) : null);
      r.at = vid ? api.suggestAt(vid) : ''; r.atAuto = true;
    }
    function complete(a) { return a.rows.length && !(a.questions || []).length && !A.blockers(a.rows).length; }
    function closeCard(note) {
      if (!card) return;
      var m = card;
      m.open = false; card = null; m.html = summaryHtml(m.a, note);
    }
    function openCard(a, extra) {
      closeCard('Заменена новой.');
      a.rows.forEach(autoAt);
      card = push(Object.assign({ who: 'ai', kind: 'card', open: true, a: a }, extra || {}));
      draw();
    }
    // Всё понятно — считаем сразу. Не хватает чего-то — спрашиваем словами, как в переписке.
    function understood(a, extra) {
      extra = extra || {};
      a.text = a.text || extra.text || '';
      a.rows.forEach(autoAt);
      pending = null;
      closeCard('Заменена новой.');
      var d = api.data(), qs = (a.questions || []).filter(Boolean);
      if (!a.rows.length && !qs.length) qs = ['Не понял, что поменялось. Напишите по-другому или нажмите подсказку под полем.'];
      if (qs.length) {                      // спросил ИИ (или наша проверка его ответа): отвечают словами, ИИ получит обе фразы
        push({ who: 'ai', kind: 'text', label: extra.noAi ? 'Программа' : 'ИИ', html:
          (a.rows.length ? '<b>Понял так</b><ol class="msg-lines">' + a.rows.map(function (r) { return '<li>' + esc(rowText(r, d)) + '</li>'; }).join('') + '</ol>' : '') +
          qs.map(function (q) { return '<p>' + esc(q) + '</p>'; }).join('') });
        if (a.text) pending = { type: 'ai', text: a.text, mode: a.mode, joiner: '. ' };
        draw(); return;
      }
      for (var i = 0; i < a.rows.length; i++) {
        var r = a.rows[i];
        if (A.needsStore(r) && !A.picked(r)) { askStore(a, i, extra); return; }
      }
      push(Object.assign({ who: 'ai', kind: 'card', open: false, a: a, html: summaryHtml(a) }, extra));
      run(a);
    }
    // Какой магазин: несколько похожих — список с кнопками-ответами; не нашли — просим назвать иначе.
    function askStore(a, i, extra) {
      var r = a.rows[i], g = r.groups || [], html;
      if (g.length > 1) {
        html = '<p>' + (r.query ? 'По словам «' + esc(r.query) + '» нашёл ' + g.length + (g.length > 4 ? ' магазинов' : ' магазина') + '. Какой из них?' : 'Какой магазин?') + '</p>' +
          '<div class="msg-answers">' + g.map(function (x, n) { return '<button type="button" class="btn" data-answer="' + n + '">' + esc(x.title) + '</button>'; }).join('') + '</div>' +
          '<p class="msg-note">Можно нажать или написать: номер, улицу, название.</p>';
      } else html = '<p>' + (r.query ? 'Не нашёл магазин «' + esc(r.query) + '». ' : '') + 'Какой магазин? Напишите название или улицу.</p>';
      var m = push({ who: 'ai', kind: 'text', label: 'Программа', html: html, store: true });
      pending = { type: 'store', a: a, i: i, extra: extra, msg: m };
      draw();
    }
    // Ответ логиста на «какой магазин». Разбирает наш код; если ответ не про магазин — это новая фраза.
    var ORDINALS = ['перв', 'втор', 'трет', 'четв', 'пят', 'шест', 'седьм', 'восьм', 'девят', 'десят'];
    function answerStore(text, n) {
      var p = pending, r = p.a.rows[p.i], d = api.data(), g = r.groups || [];
      if (n == null && g.length > 1) {
        var low = String(text).toLowerCase().trim();
        // «восьмой» — скорее «магазин №8», чем восьмой по списку; если такого номера нет — по порядку в списке
        ORDINALS.forEach(function (o, k) {
          if (n != null || !new RegExp('^' + o).test(low)) return;
          var byNum = []; g.forEach(function (x, j) { if (new RegExp('(^|[^0-9])' + (k + 1) + '([^0-9]|$)').test(x.title)) byNum.push(j); });
          n = byNum.length === 1 ? byNum[0] : (k < g.length ? k : null);
        });
        if (n == null) {                    // номер, улица, название — среди уже найденных
          var sub = d.orders.filter(function (o) { return g.some(function (x) { return x.ids.indexOf(o.id) >= 0; }); });
          var hit = A.findStores(text, sub);
          if (hit.length === 1) g.forEach(function (x, k) { if (x.title === hit[0].title) n = k; });
        }
        if (n == null) return false;
      } else if (n == null) {               // не нашли раньше — ищем по новым словам среди всех заказов
        var all = A.findStores(text, d.orders);
        if (!all.length) return false;
        r.query = text; r.groups = all; r.pick = all.length === 1 ? 0 : null;
        if (r.pick == null) { askStore(p.a, p.i, p.extra); return true; }
      }
      if (n != null) r.pick = n;
      if (p.msg) p.msg.html = p.msg.html.replace(/<div class="msg-answers">[\s\S]*?<\/div>/, '').replace(/<p class="msg-note">Можно нажать[\s\S]*?<\/p>/, '');
      pending = null;
      autoAt(r);
      understood(p.a, p.extra);             // следующий неясный магазин — снова вопрос; всё ясно — расчёт
      return true;
    }
    function run(a) {
      if (a.mode !== mode()) { say('Пока я думал, план утвердили или сбросили. Напишите ещё раз.'); draw(); return; }
      if (api.busy()) { draw(); return; }
      if (a.mode === 'plan') {
        var list = A.toChanges(a.rows), rows = copy(a.rows);
        var wait = say('<p class="msg-note">Считаю: наш алгоритм, 2–4 секунды…</p>');
        draw();
        later(function () {
          remove(wait);
          api.openProposal(list);
          var p = api.proposal();
          if (p && !p.ok) {                // ошибка в строках: показываем причину, предложение сразу закрываем
            var html = P.card(p);
            api.dropProposal();
            push({ who: 'ai', kind: 'proposal', open: false, last: html, note: 'Поправьте и напишите снова.' });
          } else if (p) push({ who: 'ai', kind: 'proposal', open: true, rows: rows, text: summaryText(a) });
          draw();
        });
        return;
      }
      // Идущий день: каждое происшествие считается от утверждённого плана, поэтому по очереди (решение 5).
      var d = api.data(), said = summaryText(a);
      queue = a.rest || [];                 // после «поправить» остальные происшествия той же фразы ждут своей очереди
      var mine = [];
      a.rows.forEach(function (r) {
        var pres = A.toIncidents([r], api.vehicleOfOrder), text = rowText(r, d);
        pres.forEach(function (p, n) { p.label = text + (pres.length > 1 ? ' (заказ ' + (n + 1) + ' из ' + pres.length + ')' : ''); p.row = copy(r); p.said = said; mine.push(p); });
      });
      queue = mine.concat(queue);
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
          draw();
          if (queue.length) nextIncident();
          return;
        }
        var m = push({ who: 'ai', kind: 'live', res: res, used: -1, state: 'new', rows: [pre.row], text: pre.said });
        show(m, 0);                         // сразу на карте: логисту остаётся «Утвердить» или «Отменить»
        draw();
      });
    }
    function show(m, n) {
      if (api.proposal() || !m.res.variants[n]) return;           // открыто предложение до утверждения — его сначала применяют или отменяют
      m.state = 'busy';                     // пока вариант ставится черновиком, refresh() это сообщение не закрывает
      log.forEach(function (x) { if (x !== m && x.kind === 'live' && x.state === 'new') { x.state = 'closed'; x.note = 'Вместо этого — сообщение ниже.'; } });
      api.useVariant(m.res.variants[n]);
      m.used = n; m.key = api.draftKey(); m.state = 'used';
    }
    function liveDone(m, state, note) {
      m.state = state; m.note = m.note || note;
      if (queue.length) nextIncident();     // следующее происшествие из той же фразы — само
    }

    // ---------- ввод ----------
    function send(text) {
      text = String(text || '').trim();
      if (sending) return;
      if (!text) { api.toast('Напишите, что изменилось, или нажмите подсказку под полем.', 'warn'); return; }
      push({ who: 'me', kind: 'text', html: esc(text.length > 300 ? text.slice(0, 300) + '…' : text) });
      $('ch-text').value = '';
      if (text.length > MAX_TEXT) { say('Фраза длиннее ' + MAX_TEXT + ' знаков. Напишите короче.'); draw(); return; }
      var m = mode(), d = api.data(), follow = null;
      if (pending && pending.type === 'store') {
        if (answerStore(text)) return;
        // короткий ответ, который не подошёл ни к одному магазину, — переспрашиваем; длинный — это новая фраза
        if (text.split(/\s+/).length <= 3) { say('Не понял, какой. Нажмите на нужный магазин выше или напишите номер, улицу, название.'); draw(); return; }
      }
      // Ответ на вопрос ИИ или поправка: функция не помнит прошлых фраз, поэтому отправляем обе вместе (если влезают в лимит).
      if (pending && pending.type === 'ai' && pending.mode === m && (pending.text + pending.joiner + text).length <= MAX_TEXT) follow = pending.text + pending.joiner + text;
      pending = null;
      var wait = say('<p class="msg-note">Разбираю фразу…</p>');
      sending = true; $('ch-send').disabled = true; draw();
      A.ask(follow || text, m, d.vehicles).then(function (res) {
        sending = false; $('ch-send').disabled = false; remove(wait);
        if (mode() !== m) { say('Пока ИИ думал, план утвердили или сбросили. Отправьте фразу ещё раз.'); draw(); return; }
        if (!res.ok) { openCard({ mode: m, rows: [], questions: [], manual: true, message: res.message }); return; }
        var r = A.resolve(res, api.data(), { pick: api.pickVehicles });
        understood({ mode: m, rows: r.rows, questions: r.questions, message: '' }, { text: follow || text });
      });
    }
    // Подсказка без ИИ: строки собирает наш код и сразу считает.
    function hint(key) {
      var d = api.data(), m = mode(), rows, label;
      if (m === 'plan') {
        if (PLAN_HINTS.indexOf(key) < 0) return;
        rows = P.scenario(key, d, api.leastLoaded()).map(copy);
        if (key === 'minus1') rows.forEach(function (r) { r.auto = true; });
        label = planHintNames()[key];
      } else {
        var h = LIVE_HINTS.filter(function (x) { return x[0] === key; })[0];
        if (!h) return;
        var r = A.emptyRow(key, d);
        if (r.vehicleId != null) r.vehicleId = api.firstInRoute() || r.vehicleId;
        rows = [r]; label = h[1];
      }
      push({ who: 'me', kind: 'text', html: esc(label) });
      understood({ mode: m, rows: rows, questions: [], message: '' }, { noAi: true });
    }
    // Карточка: «Посчитать» после ручной правки.
    function go() {
      var m = card;
      if (!m) return;
      var b = A.blockers(m.a.rows);
      if (b.length) { api.toast(b[0], 'warn'); return; }
      if (m.a.mode !== mode()) { closeCard('План утвердили или сбросили, пока карточка была открыта. Напишите заново.'); draw(); return; }
      if (api.busy()) return;
      var a = m.a;
      closeCard();
      run(a);
    }
    // «Понял не так — поправить»: расчёт закрываем и спрашиваем словами; поправка уйдёт в ИИ вместе с первой фразой.
    function fix(m) {
      var md = m.kind === 'live' ? 'live' : 'plan';
      if (m.kind === 'proposal' && m.open) api.dropProposal('Понял не так — поправляю.');
      if (m.kind === 'live') {
        m.note = 'Понял не так — поправляю.';
        if (m.state === 'used') api.cancelDraft(); else m.state = 'closed';
      }
      queue = [];
      say('Что не так? Напишите — пересчитаю.');
      pending = m.text ? { type: 'ai', text: m.text, mode: md, joiner: '. Поправка: ' } : null;
      draw();
      var t = $('ch-text'); if (t && t.focus) t.focus();
    }
    function act(i, what, n) {
      var m = log[i];
      if (!m) return;
      if (what === 'fix') return fix(m);
      if (m.kind !== 'live' || (m.state !== 'new' && m.state !== 'used')) return;
      if (what === 'show') { if (api.proposal()) { api.busy(); return; } show(m, +n || 0); draw(); return; }
      if (what === 'approve') { api.approve(); return; }
      if (what === 'cancel') { m.note = 'Отменено: показан утверждённый план, водители едут по нему.'; api.cancelDraft(); return; }
    }

    // ---------- связь с экраном ----------
    // Экран зовёт refresh() после каждой отрисовки: здесь чат замечает, что план утвердили, сбросили или поменяли.
    function refresh() {
      var m = mode();
      // Без приветствий и подсказок «напишите…» (просьба автора 15 ноября): поле пустое, чат начинается с первой фразы логиста.
      lastMode = m;
      $('ch-hints').innerHTML = hintsHtml(m);
      $('ch-text').placeholder = '';
      if (card && card.a.mode !== m) closeCard('План утвердили или сбросили, пока карточка была открыта. Напишите заново.');
      log.forEach(function (x) {
        if (x.kind === 'proposal' && x.open && !api.proposal()) { x.open = false; x.note = x.note || 'Предложение закрыто.'; }
        if (x.kind === 'live' && x.state === 'used') {
          if (api.draftKey() !== x.key) liveDone(x, 'closed', 'Черновик поменялся: этот вариант больше не на карте.');
          else if (api.approval() === 'same') liveDone(x, 'approved', 'Утверждено в ' + nowText() + ': водители видят новые маршруты.');
        }
        if (x.kind === 'live' && x.state === 'new' && m !== 'live') { x.state = 'closed'; x.note = 'План сброшен.'; }
      });
      if (m !== 'live') queue = [];
      if (pending && pending.type === 'store' && pending.a.mode !== m) pending = null;
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
    // Сообщение водителя о проблеме («Перестроить» в ленте) → то же, что фраза: понятно — считаем, нет — карточка.
    function fromEvent(pre, text) {
      var d = api.data(), r = A.emptyRow(INCIDENT[pre.type] || 'delay', d);
      if (pre.vehicleId != null) r.vehicleId = pre.vehicleId;
      if (pre.orderId && A.needsStore(r)) {
        var o = d.orders.filter(function (x) { return x.id === pre.orderId; })[0];
        r.query = o ? o.name : ''; r.groups = o ? [{ ids: [o.id], title: '«' + o.name + '», ' + o.address }] : []; r.pick = o ? 0 : null;
      }
      say('Сообщение водителя: ' + esc(text));
      understood({ mode: mode(), rows: [r], questions: [], message: '' }, { noAi: true });
    }
    function reset() { log = []; card = null; queue = []; pending = null; lastMode = null; drawn = null; sending = false; $('ch-send').disabled = false; }

    root.addEventListener('click', function (e) {
      var t = e.target && e.target.closest ? e.target.closest('button') : e.target;
      if (!t || t.disabled) return;
      if (t.id === 'ch-send') return send($('ch-text').value);
      if (t.hasAttribute('data-hint')) return hint(t.getAttribute('data-hint'));
      if (t.hasAttribute('data-answer') && pending && pending.type === 'store') {
        var g = pending.a.rows[pending.i].groups[+t.getAttribute('data-answer')];
        if (g) { push({ who: 'me', kind: 'text', html: esc(g.title) }); answerStore('', +t.getAttribute('data-answer')); }
        return;
      }
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
    return { refresh: refresh, closeProposal: closeProposal, fromEvent: fromEvent, reset: reset, send: send, hint: hint };
  }

  window.MilkChat = { mount: mount };
})();
