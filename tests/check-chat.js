// ЧАТ С ИИ на экране диспетчера (новый экран, без ?old=1). Запуск: node tests/check-chat.js (около минуты).
// Экран запускается без браузера (tests/fake-page.js), модель поддельная: отвечает так, как ответила бы на фразу.
// Проверяем весь путь «пишу → ИИ: Я понял так → Посчитать → было → станет → Применить / Утвердить»:
//   1) экран открывается: чат поздоровался, подсказки без ИИ, кнопки «Форс-мажор» и старых блоков нет;
//   2) подсказки (бывшие «А если…») работают без ИИ: карточка → «Посчитать» → предложение в чате → «Отменить» / «Применить»;
//   3) фраза автора → карточка → выбор магазина → предложение; вопрос ИИ → ответ уходит вместе с прошлой фразой;
//   4) ИИ недоступен (нет сети, нет интернета) → пустая карточка, строка вручную → предложение;
//   5) странный ввод: пустая фраза, 2 000 знаков; «минус 4 машины» → два варианта → «без нарушений» → «Применить»;
//   6) день идёт: «Машина 4 сломалась» → время по плану в строке → варианты → «Показать на карте» → «Утвердить»;
//      две беды в одной фразе → по очереди; подсказка «Машина сломалась» без ИИ; «Сбросить демо» очищает чат;
//   7) на экране нигде нет NaN, Infinity, undefined;
//   8) два экрана с базой: предложение в чате экрана A закрывается с объяснением, если экран B применил своё.
const { makePage, makeClock, makeServer } = require('./fake-page.js');
let fails = 0, checks = 0;
function ok(cond, text) { checks++; if (!cond) { fails++; console.log('  ОШИБКА: ' + text); } }

(async () => {
  const P = makePage({ search: '' });                 // новый экран: без ?old=1
  const tick = (ms) => P.clock.advance(ms || 200);
  await tick(500);
  const log = () => P.text('ch-log');
  // Кнопка, как её видит обработчик чата: closest('button') — она сама, closest('[data-variant]') — только у вариантов.
  const button = (id, attrs) => {
    attrs = attrs || {};
    return { id: id || '', attrs, disabled: false, value: '',
      hasAttribute: k => k in attrs, getAttribute: k => (k in attrs ? String(attrs[k]) : null),
      closest(sel) { return sel === '[data-variant]' ? ('data-variant' in attrs ? this : null) : this; } };
  };
  const click = (id, attrs) => P.fire('chat', 'click', button(id, attrs));
  const field = (row, name, value) => { const b = button('', { 'data-row': row, 'data-field': name }); b.value = String(value); P.fire('chat', 'change', b); };
  const lastMsg = () => { const h = log(), i = h.lastIndexOf('<div class="msg '); return h.slice(i); };
  const actMsg = what => { const m = new RegExp('data-act="' + what + '" data-msg="(\\d+)"').exec(log()); return m ? +m[1] : -1; };
  // Поддельная модель. Карта тоже ходит в сеть (линии по улицам) — ей всегда «нет сети».
  P.aiCalls = 0;
  const isAi = url => /functions\/v1\/assistant/.test(String(url));
  const answer = (changes, questions) => { P.win.fetch = (url, req) => { if (!isAi(url)) return Promise.reject(new Error('нет сети'));
    P.aiCalls++; P.lastBody = JSON.parse(req.body); return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true, changes, questions: questions || [] }) }); }; };
  const noAi = () => { P.win.fetch = url => { if (isAi(url)) P.aiCalls++; return Promise.reject(new Error('нет сети')); }; };
  const send = async text => { P.el('ch-text').value = text; click('ch-send'); await tick(); };
  const clean = label => { const all = ['kpis', 'routes', 'problems', 'ch-log', 'meta', 'status', 'incident'].map(id => P.text(id)).join('\n');
    ok(!/NaN|Infinity|undefined/.test(all), label + ': на экране NaN / Infinity / undefined'); };

  // ---------- 1. Открытие ----------
  console.log('1. Новый экран открывается');
  ok(/Напишите, что изменилось на завтра/.test(log()), 'чат поздоровался: ' + log().slice(0, 120));
  ok(/data-hint="normal"/.test(P.text('ch-hints')) && /data-hint="minus1"/.test(P.text('ch-hints')), 'подсказки «А если…» под полем');
  ok(P.el('btn-incident').hidden === true, 'кнопки «Форс-мажор» нет');
  ok(P.text('whatif') === '' && P.text('proposal') === '' && P.text('assistant') === '', 'старые блоки пустые');
  ok(/Например: у машин 3 и 9/.test(P.el('ch-text').placeholder), 'подсказка в поле ввода');
  clean('открытие');

  // ---------- 2. Подсказки без ИИ ----------
  console.log('2. Подсказки без ИИ');
  noAi(); const calls0 = P.aiCalls;
  const kpi0 = P.text('kpis'), routes0 = P.text('routes');
  click('', { 'data-hint': 'normal' }); await tick();
  ok(/class="msg me">Обычный день: вес на 30% меньше/.test(log()), 'подсказка видна как сообщение логиста');
  ok(/Без ИИ/.test(lastMsg()) && /Я понял так/.test(lastMsg()) && /data-field="factor" value="0.7"/.test(lastMsg()), 'карточка без ИИ: вес ×0,7');
  click('as-go'); await tick();
  ok(/prop-apply/.test(log()) && /Было<\/th><th>Станет/.test(log()), 'в чате предложение «было → станет»');
  ok(!P.el('map-flag').hidden, 'на карте пометка «предложение»');
  ok(/Посчитано ↓/.test(log()), 'карточка закрыта: «Посчитано»');
  click('prop-cancel'); await tick();
  ok(!/prop-apply/.test(log()) && /Отменено: показан прежний план/.test(log()), 'после «Отменить» кнопок нет, в чате «Отменено»');
  ok(P.text('kpis') === kpi0 && P.text('routes') === routes0 && P.el('map-flag').hidden, '«Отменить» вернуло прежний план');
  // «Минус одна машина»: машину можно поменять в карточке
  click('', { 'data-hint': 'minus1' }); await tick();
  ok(/data-field="vehicleId"/.test(lastMsg()), 'минус одна машина: выбор машины в строке');
  field(0, 'vehicleId', 16); await tick();
  ok(/<option value="16" selected>/.test(lastMsg()), 'машина поменялась на 16');
  click('as-go'); await tick();
  ok(/Машина 16 сегодня не выходит/.test(log()), 'в предложении «Машина 16 сегодня не выходит»');
  click('prop-apply'); await tick(1000);
  ok(/Применено: новый черновик/.test(log()) && !/prop-apply/.test(log()), 'после «Применить» в чате «Применено»');
  ok(/применено/.test(P.el('status').textContent), 'статус: ' + P.el('status').textContent);
  ok(P.aiCalls === calls0, 'подсказки не звали ИИ');
  clean('подсказки');
  P.fire('btn-reset', 'click'); await tick(1000);
  ok(!/Применено/.test(log()) && /Напишите, что изменилось/.test(log()), '«Сбросить демо» очистил чат');

  // ---------- 3. Фраза → ИИ ----------
  console.log('3. Фраза → ИИ → карточка → предложение');
  answer([{ kind: 'vehicle_off', vehicle: 3 }, { kind: 'vehicle_off', vehicle: 9 }, { kind: 'order_time', store: 'Щорса', time: '10:00' }]);
  await send('У машин 3 и 9 водители заболели, магазин на Щорса просит после 10');
  ok(P.lastBody && P.lastBody.mode === 'plan', 'в ИИ ушёл режим «до утверждения»');
  ok(/msg-who">ИИ/.test(lastMsg()) && /Я понял так/.test(lastMsg()) && /найдено 5, выберите/.test(lastMsg()), 'ответ ИИ: карточка с выбором магазина');
  ok(P.el('ch-text').value === '', 'поле ввода очищено');
  click('as-go'); await tick();
  ok(/выберите магазин/.test(P.el('toast').textContent) && !/prop-apply/.test(log()), 'без выбора магазина не считает');
  field(2, 'pick', 1); await tick();
  click('as-go'); await tick();
  ok(/prop-apply/.test(log()) && /Машина 3 сегодня не выходит/.test(log()) && /разгрузка не раньше 10:00/.test(log()), 'предложение по фразе автора');
  // пока предложение открыто, новая карточка не считается
  click('', { 'data-hint': 'unload25' }); await tick(); click('as-go'); await tick();
  ok(/Открыто предложение/.test(P.el('toast').textContent), 'вторая карточка при открытом предложении: подсказка «сначала Применить или Отменить»');
  click('prop-cancel'); await tick();
  // вопрос ИИ → ответ логиста уходит вместе с прошлой фразой
  answer([], ['Какую машину убрать?']);
  await send('Убери одну машину');
  ok(/as-questions/.test(lastMsg()) && /Какую машину убрать/.test(lastMsg()), 'вопрос ИИ виден в карточке');
  answer([{ kind: 'vehicle_off', vehicle: 7 }]);
  await send('седьмую');
  ok(P.lastBody.text === 'Убери одну машину. седьмую', 'ответ на вопрос ушёл вместе с прошлой фразой: ' + P.lastBody.text);
  ok(/Учёл и прошлую фразу/.test(lastMsg()) && /<option value="7" selected>/.test(lastMsg()), 'карточка по двум фразам: машина 7');
  ok(/Заменена новой/.test(log()), 'прошлая карточка закрыта');
  click('as-cancel'); await tick();
  ok(/Отменено\./.test(log()), 'карточку можно отменить');

  // ---------- 4. ИИ недоступен ----------
  console.log('4. ИИ недоступен');
  noAi();
  await send('машина 5 не выходит');
  ok(/Модель недоступна/.test(lastMsg()) && /Заполните вручную/.test(lastMsg()), 'без сети: сообщение и пустая карточка');
  P.el('as-add-kind').value = 'vehicle_off'; click('as-add'); await tick();
  field(0, 'vehicleId', 5); await tick();
  click('as-go'); await tick();
  ok(/prop-apply/.test(log()) && /Машина 5 сегодня не выходит/.test(log()), 'строка вручную → предложение');
  click('prop-cancel'); await tick();
  P.win.navigator.onLine = false;
  await send('машина 6 не выходит');
  ok(/Нет интернета: модель недоступна/.test(lastMsg()), 'нет интернета: честное сообщение');
  P.win.navigator.onLine = true;
  click('as-cancel'); await tick();

  // ---------- 5. Странный ввод и «минус 4 машины» ----------
  console.log('5. Странный ввод, «минус 4 машины»');
  const before = log();
  await send('   ');
  ok(log() === before && /Напишите, что изменилось/.test(P.el('toast').textContent), 'пустая фраза: подсказка, в чат ничего');
  await send('х'.repeat(2000));
  ok(/длиннее 500 знаков/.test(lastMsg()), 'фраза на 2 000 знаков: «напишите короче»');
  answer([{ kind: 'чепуха' }, { kind: 'vehicle_off', vehicle: 999 }]);
  await send('абракадабра');
  click('as-go'); await tick();
  clean('странный ввод');
  if (/prop-cancel/.test(log())) { click('prop-cancel'); await tick(); }
  answer([3, 5, 7, 9].map(v => ({ kind: 'vehicle_off', vehicle: v })));
  await send('У машин 3, 5, 7 и 9 водители заболели');
  click('as-go'); await tick();
  ok(/data-variant="1"/.test(log()), 'минус 4 машины: два варианта в предложении');
  click('', { 'data-variant': 1 }); await tick();
  const nDrop = +(/Сегодня не доставим: (\d+)/.exec(P.text('routes')) || [])[1];
  ok(nDrop > 0 && /Не везём сегодня: /.test(log()), 'вариант «Без нарушений»: список «не везём» (' + nDrop + ')');
  click('prop-apply'); await tick(1000);
  const saved = JSON.parse(P.storage['milk.plan.v3']).draft.assignment.filter(a => a.v === 0)[0];
  ok(saved && saved.s.length === nDrop, 'после «Применить» в черновике строка «не везём»');
  ok(/disabled class="variant/.test(log()), 'закрытое предложение осталось в чате без кнопок');
  P.fire('btn-reset', 'click'); await tick(1000);

  // ---------- 6. День идёт ----------
  console.log('6. День идёт');
  P.fire('btn-approve', 'click'); await tick();
  ok(/План утверждён: водители видят маршруты/.test(log()), 'чат заметил утверждение');
  ok(/data-hint="breakdown"/.test(P.text('ch-hints')) && !/data-hint="normal"/.test(P.text('ch-hints')), 'подсказки сменились на происшествия');
  // Две беды в одной фразе → по очереди
  answer([{ kind: 'delay', vehicle: 2, minutes: 40 }, { kind: 'later', store: 'Евроопт на Суворова', time: '14:00' }]);
  await send('Машина 2 задерживается на 40 минут, Евроопт на Суворова просит после 14');
  ok(/2 заказа/.test(lastMsg()), 'повтор магазина: одна строка на два заказа');
  field(1, 'at', '06:00'); await tick();        // время по плану подставлено само; ставим раннее, чтобы точка была ещё впереди
  ok(/data-field="at" value="06:00"/.test(lastMsg()), 'время в строке поправлено руками');
  click('as-go'); await tick();
  ok(/data-act="show"/.test(lastMsg()) || /msg-error/.test(lastMsg()), 'первое происшествие посчитано');
  if (/data-act="close"/.test(lastMsg())) { click('', { 'data-act': 'close', 'data-msg': actMsg('close') }); await tick(); }
  ok(/Дальше по очереди/.test(log()) && /data-act="next"/.test(log()), 'остальное — «Дальше по очереди»');
  click('', { 'data-act': 'next', 'data-msg': actMsg('next') }); await tick();
  ok(/Евроопт/.test(lastMsg()) && /data-act="show"/.test(lastMsg()), 'следующее посчитано: ' + lastMsg().replace(/<[^>]+>/g, ' ').slice(0, 300));
  // показать и отменить
  if (/data-act="show"/.test(lastMsg())) {
    click('', { 'data-act': 'show', 'data-msg': actMsg('show') }); await tick();
    click('', { 'data-act': 'cancel', 'data-msg': actMsg('cancel') }); await tick();
    ok(/Утверждён в/.test(P.el('approval').textContent) && /Отменено: показан утверждённый план/.test(log()), '«Отменить» вернул утверждённый план');
  }
  answer([{ kind: 'breakdown', vehicle: 4 }]);
  await send('Машина 4 сломалась');
  ok(P.lastBody.mode === 'live', 'в ИИ ушёл режим «день идёт»');
  const at = /data-field="at" value="(\d\d:\d\d)"/.exec(lastMsg());
  ok(at, 'время происшествия подставлено по плану');
  ok(/>Посчитать</.test(lastMsg()), 'кнопка «Посчитать»');
  click('as-go'); await tick();
  ok(/msg-who">Расчёт/.test(lastMsg()) && /data-act="show"/.test(lastMsg()) && /Было<\/th><th>Станет/.test(lastMsg()), 'варианты перестроения с «было → станет»');
  ok(P.text('fm-body') === '', 'окно «Форс-мажор» не открывалось');
  const nVar = (lastMsg().match(/data-act="sel"/g) || []).length;
  if (nVar > 1) { click('', { 'data-act': 'sel', 'data-msg': actMsg('show'), 'data-n': nVar - 1 }); await tick(); ok(/aria-pressed="true"><b>[^<]+<\/b><span>посмотреть/.test(lastMsg()), 'выбран другой вариант для просмотра'); }
  click('', { 'data-act': 'show', 'data-msg': actMsg('show') }); await tick();
  ok(/Изменён после утверждения/.test(P.el('approval').textContent), 'вариант стал черновиком: ' + P.el('approval').textContent);
  ok(/data-act="approve"/.test(lastMsg()) && /на карте как черновик/.test(lastMsg()), 'в сообщении «Утвердить» и «Отменить»');
  click('', { 'data-act': 'approve', 'data-msg': actMsg('approve') }); await tick();
  ok(/Утверждён в/.test(P.el('approval').textContent) && /Утверждено в \d\d:\d\d: водители видят новые маршруты/.test(log()), 'утверждено из чата');
  ok(!/data-act="approve"/.test(log()), 'после утверждения кнопок нет');
  clean('поломка');
  // Подсказка без ИИ в идущем дне
  noAi(); const calls1 = P.aiCalls;
  click('', { 'data-hint': 'breakdown' }); await tick();
  ok(/Без ИИ/.test(lastMsg()) && /data-field="at" value="\d\d:\d\d"/.test(lastMsg()), 'подсказка «Машина сломалась»: строка с машиной и временем');
  click('as-go'); await tick();
  ok(/data-act="show"/.test(lastMsg()) || /msg-error/.test(lastMsg()), 'подсказка → варианты перестроения');
  ok(P.aiCalls === calls1, 'подсказка в идущем дне не звала ИИ');
  clean('день идёт');
  P.fire('btn-reset', 'click'); await tick(1000);
  ok(/План утверждён, день идёт|Напишите, что изменилось на завтра/.test(log()) && !/Утверждено в/.test(log()), 'после сброса чат чистый');
  ok(/data-hint="normal"/.test(P.text('ch-hints')), 'после сброса — подсказки «до утверждения»');

  // ---------- 8. Два экрана ----------
  console.log('8. Два экрана с одной базой');
  {
    const clock = makeClock(), server = makeServer(clock);
    const A = makePage({ clock, server, net: { up: 60, down: 60 }, storage: {}, search: '' });
    const B = makePage({ clock, server, net: { up: 60, down: 60 }, storage: {}, search: '' });
    await clock.advance(3000);
    const clickOn = (Pg, id, attrs) => Pg.fire('chat', 'click', button(id, attrs));
    clickOn(A, '', { 'data-hint': 'unload25' }); await clock.advance(300); clickOn(A, 'as-go'); await clock.advance(300);
    ok(/prop-apply/.test(A.text('ch-log')), 'на экране A открыто предложение');
    clickOn(B, '', { 'data-hint': 'normal' }); await clock.advance(300); clickOn(B, 'as-go'); await clock.advance(300);
    clickOn(B, 'prop-apply'); await clock.advance(40000);
    ok(/Применено/.test(B.text('ch-log')), 'экран B применил «обычный день»');
    ok(!/prop-apply/.test(A.text('ch-log')) && /изменились на другом экране|изменился на другом экране/.test(A.text('ch-log')), 'на экране A предложение закрыто с объяснением');
    ok(A.text('kpis') === B.text('kpis'), 'оба экрана показывают один план');
  }

  console.log(fails ? '\nЧат: ОШИБОК ' + fails + ' из ' + checks : '\nЧат: все ' + checks + ' проверок прошли');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('УПАЛО: ' + e.stack); process.exit(1); });
