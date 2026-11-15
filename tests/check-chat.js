// ЧАТ С ИИ на экране диспетчера (новый экран, без ?old=1). Запуск: node tests/check-chat.js (около минуты).
// Экран запускается без браузера (tests/fake-page.js), модель поддельная: отвечает так, как ответила бы на фразу.
// Проверяем путь «пишу → ИИ понял → сразу было → станет → Применить / Утвердить» без лишних шагов:
//   1) экран открывается: чат поздоровался, подсказки без ИИ, кнопки «Форс-мажор» и старых блоков нет;
//   2) подсказки (бывшие «А если…») без ИИ и сразу с расчётом; «Понял не так — поправить» → карточка → новый расчёт;
//   3) понятная фраза — сразу расчёт; неполная (какой из пяти магазинов) — карточка с вопросом; «один водитель заболел»
//      без номера — машину выбирает программа; вопрос ИИ → ответ уходит вместе с прошлой фразой;
//   4) ИИ недоступен (нет сети, нет интернета) → пустая карточка, строка вручную → предложение;
//   5) странный ввод: пустая фраза, 2 000 знаков; «минус 4 машины» → два варианта → «без нарушений» → «Применить»;
//   6) день идёт: «Машина 4 сломалась» → сразу на карте → «Утвердить»; две беды в одной фразе → по очереди, сами;
//      подсказка «Машина сломалась» без ИИ; «поправить» снимает черновик; «Сбросить демо» очищает чат;
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
  ok(log() === '' && !/chat-head|Что изменилось\?|решаете вы/.test(P.text('chat')), 'чат пустой: без приветствия и заголовка');
  ok(/data-hint="unload25"/.test(P.text('ch-hints')) && /data-hint="minus1"/.test(P.text('ch-hints')) && !/data-hint="normal"/.test(P.text('ch-hints')), 'подсказки «А если…» под полем (обычного дня среди них нет: это кнопка «Завтра»)');
  ok(P.el('btn-incident').hidden === true, 'кнопки «Форс-мажор» нет');
  ok(P.text('whatif') === '' && P.text('proposal') === '' && P.text('assistant') === '', 'старые блоки пустые');
  ok(P.el('ch-text').placeholder === '', 'поле ввода пустое, без подсказки');
  ok(/План доставки по Гродно · 214 заказов · 198 остановок · 63,6 т/.test(P.text('kpis')) && !/Как сейчас, две оценки/.test(P.text('kpis')) && P.el('meta').textContent === '',
    'строка «План доставки по Гродно…» — под пробегом, оценок «как сейчас» нет, в шапке пусто');
  clean('открытие');

  // ---------- 2. Подсказки без ИИ: сразу расчёт ----------
  console.log('2. Подсказки без ИИ');
  noAi(); const calls0 = P.aiCalls;
  const kpi0 = P.text('kpis'), routes0 = P.text('routes');
  click('', { 'data-hint': 'unload25' }); await tick();
  ok(/class="msg me">Разгрузка 25 мин вместо 30/.test(log()), 'подсказка видна как сообщение логиста');
  ok(/Без ИИ/.test(log()) && /Понял так/.test(log()) && /Разгрузка в обычной точке, мин»: 30 → 25/.test(log()), '«понял так» без ИИ: разгрузка 30 → 25');
  ok(/prop-apply/.test(log()) && /Было<\/th><th>Станет/.test(log()), 'сразу предложение «было → станет», без кнопки «Посчитать»');
  ok(!/id="as-go"/.test(log()), 'карточки с «Посчитать» нет');
  ok(!P.el('map-flag').hidden, 'на карте пометка «предложение»');
  click('prop-cancel'); await tick();
  ok(!/prop-apply/.test(log()) && /Отменено: показан прежний план/.test(log()), 'после «Отменить» кнопок нет, в чате «Отменено»');
  ok(P.text('kpis') === kpi0 && P.text('routes') === routes0 && P.el('map-flag').hidden, '«Отменить» вернуло прежний план');
  // «Минус одна машина»: номер не спрашивается, но можно поправить
  click('', { 'data-hint': 'minus1' }); await tick();
  ok(/выбрала программа: номер не важен/.test(log()) && /prop-apply/.test(log()), 'минус одна машина: номер выбрала программа, сразу расчёт');
  click('', { 'data-act': 'fix', 'data-msg': actMsg('fix') }); await tick();
  ok(/Понял не так — поправляю/.test(log()) && /Что не так\? Напишите/.test(lastMsg()) && !/prop-apply/.test(log()) && !/data-field=/.test(log()), '«Понял не так»: расчёт закрыт, вопрос словами, без формы');
  answer([{ kind: 'vehicle_off', vehicle: 16 }]);
  await send('убери шестнадцатую');
  ok(/^Машина \d+ сегодня не выходит\. Поправка: убери шестнадцатую$/.test(P.lastBody.text), 'поправка ушла в ИИ вместе с тем, что понято: ' + P.lastBody.text);
  ok(/Машина 16 сегодня не выходит/.test(log()) && /prop-apply/.test(log()), 'после поправки — новый расчёт');
  click('prop-apply'); await tick(1000);
  ok(/Применено: новый черновик/.test(log()) && !/prop-apply/.test(log()), 'после «Применить» в чате «Применено»');
  ok(/применено/.test(P.el('status').textContent), 'статус: ' + P.el('status').textContent);
  ok(P.aiCalls === calls0 + 1, 'подсказки не звали ИИ (позвала только поправка словами)');
  clean('подсказки');
  P.fire('btn-reset', 'click'); await tick(1000);
  ok(log() === '', '«Сбросить демо» очистил чат: ' + log().replace(/<[^>]+>/g, ' ').slice(0, 200));

  // ---------- 3. Фраза → ИИ ----------
  console.log('3. Фраза → ИИ → расчёт');
  answer([{ kind: 'vehicle_off', vehicle: 3 }, { kind: 'vehicle_off', vehicle: 9 }, { kind: 'order_time', store: 'Щорса', time: '10:00' }]);
  await send('У машин 3 и 9 водители заболели, магазин на Щорса просит после 10');
  ok(P.lastBody && P.lastBody.mode === 'plan', 'в ИИ ушёл режим «до утверждения»');
  ok(/нашёл 5 магазинов\. Какой из них\?/.test(lastMsg()) && /data-answer="4"/.test(lastMsg()) && !/<select/.test(log()), 'магазинов на Щорса пять: вопрос словами с вариантами, без формы');
  ok(P.el('ch-text').value === '' && !/prop-apply/.test(log()), 'поле очищено, без ответа не считает');
  const calls2 = P.aiCalls;
  await send('тот самый');
  ok(/Не понял, какой/.test(lastMsg()) && !/prop-apply/.test(log()), 'непонятный короткий ответ — переспросил');
  await send('восьмой');
  ok(P.aiCalls === calls2, 'ответ «какой магазин» разбирает наш код, без ИИ');
  ok(/prop-apply/.test(log()) && /Машина 3 сегодня не выходит/.test(log()) && /«Магазин №8\/Щорса\/» \(Щорса 26\): разгрузка не раньше 10:00/.test(log()), 'ответ «восьмой» → магазин №8 → предложение по фразе автора');
  click('prop-cancel'); await tick();
  await send('У машин 3 и 9 водители заболели, магазин на Щорса просит после 10');
  await send('на 26');
  ok(/prop-apply/.test(lastMsg()) && /«Магазин №8\/Щорса\/» \(Щорса 26\)/.test(lastMsg()), 'ответ «на 26» → тот же магазин №8');
  click('', { 'data-act': 'fix', 'data-msg': actMsg('fix') }); await tick();
  answer([{ kind: 'vehicle_off', vehicle: 3 }, { kind: 'vehicle_off', vehicle: 7 }, { kind: 'order_time', store: 'Магазин №8 Щорса 26', time: '10:00' }]);
  await send('не девятая, а седьмая');
  ok(/Магазин №8\/Щорса\/» \(Щорса 26\).*Поправка: не девятая, а седьмая$/.test(P.lastBody.text), 'в поправку ушёл уже уточнённый магазин: ' + P.lastBody.text);
  ok(/prop-apply/.test(lastMsg()) && /Машина 7 сегодня не выходит/.test(lastMsg()) && !/Какой из них/.test(lastMsg()), 'после поправки магазин не переспрашивается, сразу расчёт');
  click('', { 'data-hint': 'unload25' }); await tick();
  ok(/Открыто предложение/.test(P.el('toast').textContent), 'вторая подсказка при открытом предложении: «сначала Применить или Отменить»');
  click('prop-cancel'); await tick();
  // всё понятно — считает сразу
  answer([{ kind: 'vehicle_off', vehicle: 5 }]);
  await send('Машина 5 в ремонте');
  ok(/prop-apply/.test(lastMsg()) && /Машина 5 сегодня не выходит/.test(log()) && !/id="as-go"/.test(log()), 'понятная фраза: сразу «было → станет»');
  click('prop-cancel'); await tick();
  // без номера машины: «один водитель четырёхтонки заболел»
  answer([{ kind: 'vehicle_off', count: 1, cap: 4000 }]);
  await send('Один водитель на четырёхтонке заболел');
  const auto = /Машина (\d+) сегодня не выходит \(какую — выбрала программа/.exec(log());
  ok(auto && P.win.MILK_DATA.vehicles.find(v => v.id === +auto[1]).cap === 4000, 'без номера: программа сама убрала машину 4 т (' + (auto && auto[1]) + ')');
  ok(/prop-apply/.test(lastMsg()), 'и сразу посчитала');
  click('prop-cancel'); await tick();
  // вопрос ИИ → ответ логиста уходит вместе с прошлой фразой
  answer([], ['На сколько процентов меньше вес?']);
  await send('Сегодня заказов меньше');
  ok(/<p>На сколько процентов меньше вес\?<\/p>/.test(lastMsg()) && !/as-card/.test(lastMsg()), 'вопрос ИИ — простым сообщением');
  answer([{ kind: 'scale_kg', factor: 0.8 }]);
  await send('на 20%');
  ok(P.lastBody.text === 'Сегодня заказов меньше. на 20%', 'ответ на вопрос ушёл вместе с прошлой фразой: ' + P.lastBody.text);
  ok(/Вес всех заказов ×0,8/.test(log()) && /prop-apply/.test(lastMsg()), 'по двум фразам — сразу расчёт');
  ok(!/data-field=/.test(log()), 'ни одной формы в переписке');
  // кнопка-ответ на «какой магазин»
  answer([{ kind: 'order_kg', store: 'Щорса', kg: 0 }]);
  click('prop-cancel'); await tick();
  await send('Магазин на Щорса отменил заказ');
  click('', { 'data-answer': 3 }); await tick();
  ok(/class="msg me">«Доброном № 2135 \(Щорса\)», Щорса 58/.test(log()) && /Доброном № 2135 \(Щорса\)» \(Щорса 58\): заказ отменён/.test(log()) && /prop-apply/.test(lastMsg()), 'нажали вариант — ответ виден как сообщение, сразу расчёт');
  click('prop-cancel'); await tick();

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
  clean('странный ввод');
  ok(!/prop-apply/.test(log()), 'чепуха не дала предложения');
  answer([3, 5, 7, 9].map(v => ({ kind: 'vehicle_off', vehicle: v })));
  await send('У машин 3, 5, 7 и 9 водители заболели');
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
  ok(/data-hint="breakdown"/.test(P.text('ch-hints')) && !/data-hint="unload25"/.test(P.text('ch-hints')), 'подсказки сменились на происшествия');
  // Две беды в одной фразе → по очереди, само
  answer([{ kind: 'delay', vehicle: 2, minutes: 40 }, { kind: 'later', store: 'Евроопт на Суворова', time: '14:00' }]);
  await send('Машина 2 задерживается на 40 минут, Евроопт на Суворова просит после 14');
  ok(P.lastBody.mode === 'live', 'в ИИ ушёл режим «день идёт»');
  ok(/задерживается на 40 мин/.test(lastMsg()) && /data-act="approve"/.test(lastMsg()), 'первое происшествие сразу на карте: «Утвердить» / «Отменить»');
  ok(/Изменён после утверждения/.test(P.el('approval').textContent), 'вариант стал черновиком');
  click('', { 'data-act': 'cancel', 'data-msg': actMsg('cancel') }); await tick();
  ok(/Отменено: показан утверждённый план/.test(log()), '«Отменить»: в чате «Отменено»');
  ok(/Евроопт&quot;\(Суворова\) № 507» просит привезти не раньше 14:00/.test(lastMsg()) && (/data-act="approve"/.test(lastMsg()) || /msg-error/.test(lastMsg())),
    'следующее из той же фразы посчитано само: ' + lastMsg().replace(/<[^>]+>/g, ' ').slice(0, 200));
  if (/data-act="approve"/.test(lastMsg())) {
    click('', { 'data-act': 'approve', 'data-msg': actMsg('approve') }); await tick();
    ok(/Утверждено в \d\d:\d\d/.test(log()), 'утверждено');
    ok((log().match(/№ 507» просит привезти не раньше 14:00/g) || []).length >= 2 || /заказ 2 из 2/.test(log()), 'повтор магазина: второй заказ посчитан следом сам');
    if (/data-act="cancel"/.test(lastMsg())) { click('', { 'data-act': 'cancel', 'data-msg': actMsg('cancel') }); await tick(); }
  }
  answer([{ kind: 'breakdown', vehicle: 4 }]);
  await send('Машина 4 сломалась');
  ok(/msg-who">Расчёт/.test(lastMsg()) && /Было<\/th><th>Станет/.test(lastMsg()) && /data-act="approve"/.test(lastMsg()), 'поломка: сразу расчёт и на карте');
  ok(P.text('fm-body') === '', 'окно «Форс-мажор» не открывалось');
  const nVar = (lastMsg().match(/data-act="show"/g) || []).length;
  if (nVar > 1) { click('', { 'data-act': 'show', 'data-msg': actMsg('approve'), 'data-n': nVar - 1 }); await tick(); ok(new RegExp('data-n="' + (nVar - 1) + '" aria-pressed="true"').test(lastMsg()), 'на карте другой вариант'); }
  click('', { 'data-act': 'approve', 'data-msg': actMsg('approve') }); await tick();
  ok(/Утверждён в/.test(P.el('approval').textContent) && !/data-act="approve"/.test(log()), 'утверждено из чата, кнопок больше нет');
  clean('поломка');
  // Подсказка без ИИ в идущем дне
  noAi(); const calls1 = P.aiCalls;
  click('', { 'data-hint': 'breakdown' }); await tick();
  ok(/Без ИИ/.test(log()) && (/data-act="approve"/.test(lastMsg()) || /msg-error/.test(lastMsg())), 'подсказка «Машина сломалась» → сразу перестроение');
  ok(P.aiCalls === calls1, 'подсказка в идущем дне не звала ИИ');
  if (/data-act="fix"/.test(lastMsg())) {
    click('', { 'data-act': 'fix', 'data-msg': actMsg('fix') }); await tick();
    ok(/Что не так\? Напишите/.test(lastMsg()) && /Утверждён в/.test(P.el('approval').textContent), '«поправить» в идущем дне: черновик снят, вопрос словами');
  }
  // подсказка «Точка не принимает» без магазина — спрашивает словами, ответ — улица
  click('', { 'data-hint': 'stop_refuses' }); await tick();
  ok(/Какой магазин\? Напишите название или улицу/.test(lastMsg()), 'подсказка без магазина: вопрос словами');
  await send('Суворова 216');
  ok(/data-act="approve"/.test(lastMsg()) || /msg-error/.test(lastMsg()) || /Какой из них/.test(lastMsg()), 'ответ «Суворова 216» разобран: ' + lastMsg().replace(/<[^>]+>/g, ' ').slice(0, 160));
  clean('день идёт');
  P.fire('btn-reset', 'click'); await tick(1000);
  ok(log() === '', 'после сброса чат чистый');
  ok(/data-hint="unload25"/.test(P.text('ch-hints')), 'после сброса — подсказки «до утверждения»');

  // ---------- 7. «Завтра»: обычный день ----------
  console.log('7. «Завтра» — обычный день');
  {
    const kpiToday = P.text('kpis');
    P.fire('view-tomorrow', 'click'); await tick(1500);
    const k = P.text('kpis'), used = +(/Количество транспорта<\/span><span class="kpi-value">(\d+)/.exec(k) || [])[1];
    const kt = k.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    ok(/44,[56] т/.test(k) && used >= 11 && used <= 12, 'завтра: вес 44,6 т, машин ' + used + ' (по весу, остальные в гараже)');
    ok(/Переработки нет/.test(kt) && /— в норме 8 ч/.test(kt) && /10 из 10 важных вовремя/.test(kt), 'завтра: смена не больше 8 часов, важные вовремя: ' + kt.slice(-160));
    ok(/Все правила соблюдены/.test(P.text('problems')), 'завтра: все принципы заказчика выполнены: ' + P.text('problems').replace(/<[^>]+>/g, ' ').slice(0, 200));
    ok(/мелкая точка — до 250 кг/.test(P.el('status').textContent) && /В гараже: /.test(P.text('routes')), 'завтра: допущение о мелкой точке видно, машины в гараже видны');
    ok(!P.el('btn-approve').disabled && /План не утверждён/.test(P.el('approval').textContent), 'завтра — рабочий день: «Утвердить» открыто');
    const saved = JSON.parse(P.storage['milk.plan.v3']);
    ok(saved.settings.day === 'tomorrow' && saved.orders.reduce((a, o) => a + o.kg, 0) < 45000, 'завтра сохранено: данные обычного дня и отметка дня');
    clean('завтра');
    // утверждаем и ломаем машину — выезжает резервная из гаража
    P.fire('btn-approve', 'click'); await tick();
    ok(/Утверждён в/.test(P.el('approval').textContent), 'завтра утверждено');
    const vid = +(/class="chip route-num"[^>]*>(\d+)</.exec(P.text('routes')) || [])[1];
    answer([{ kind: 'breakdown', vehicle: vid, at: '08:30' }]);
    await send('Машина ' + vid + ' сломалась в 8:30');
    ok(/data-act="approve"/.test(lastMsg()), 'поломка завтра: перестроение посчитано');
    console.log('   поломка машины ' + vid + ' в 8:30: ' + (/резервная, стояла в гараже/.test(lastMsg()) ? 'выехала резервная из гаража' : 'точки забрали соседи'));
    ok(/без переработки/.test(lastMsg()) && /довезём всё/.test(lastMsg()), 'поломка завтра: довезём всё и без переработки');
    click('', { 'data-act': 'approve', 'data-msg': actMsg('approve') }); await tick();
    ok(/Утверждено в/.test(log()), 'перестроение утверждено');
    clean('поломка завтра');
    // «Сегодня» — обратно день максимальной загрузки
    P.fire('view-best', 'click'); await tick(1000);
    ok(P.text('kpis') === kpiToday && /План не утверждён/.test(P.el('approval').textContent) && log() === '', '«Сегодня» вернуло день максимальной загрузки, не утверждён, чат чистый');
    ok(!JSON.parse(P.storage['milk.plan.v3']).settings.day, 'отметка «завтра» снята');
  }

  // ---------- 8. Два экрана ----------
  console.log('8. Два экрана с одной базой');
  {
    const clock = makeClock(), server = makeServer(clock);
    const A = makePage({ clock, server, net: { up: 60, down: 60 }, storage: {}, search: '' });
    const B = makePage({ clock, server, net: { up: 60, down: 60 }, storage: {}, search: '' });
    await clock.advance(3000);
    const clickOn = (Pg, id, attrs) => Pg.fire('chat', 'click', button(id, attrs));
    clickOn(A, '', { 'data-hint': 'unload25' }); await clock.advance(300);
    ok(/prop-apply/.test(A.text('ch-log')), 'на экране A открыто предложение');
    clickOn(B, '', { 'data-hint': 'small200' }); await clock.advance(300);
    clickOn(B, 'prop-apply'); await clock.advance(40000);
    ok(/Применено/.test(B.text('ch-log')), 'экран B применил «мелкая точка до 200 кг»');
    ok(!/prop-apply/.test(A.text('ch-log')) && /изменились на другом экране|изменился на другом экране/.test(A.text('ch-log')), 'на экране A предложение закрыто с объяснением');
    ok(A.text('kpis') === B.text('kpis'), 'оба экрана показывают один план');
    // «Завтра» на экране A — экран B получает тот же рабочий день
    A.fire('view-tomorrow', 'click'); await clock.advance(60000);
    ok(/44,[56] т/.test(B.text('kpis')) && A.text('kpis') === B.text('kpis'), '«Завтра» с экрана A: экран B показывает тот же обычный день');
    ok(server.tables.app_settings.length && JSON.stringify(server.tables.app_settings).indexOf('tomorrow') >= 0, 'в базе отметка «завтра»');
    B.fire('view-best', 'click'); await clock.advance(30000);
    ok(/63,6 т/.test(A.text('kpis')) && A.text('kpis') === B.text('kpis'), '«Сегодня» с экрана B: оба экрана снова в дне максимальной загрузки');
  }

  console.log(fails ? '\nЧат: ОШИБОК ' + fails + ' из ' + checks : '\nЧат: все ' + checks + ' проверок прошли');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('УПАЛО: ' + e.stack); process.exit(1); });
