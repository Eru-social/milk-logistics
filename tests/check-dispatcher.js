// Прогон экрана диспетчера и страницы водителя без браузера: простая подделка страницы.
// Здесь — старый экран (index.html?old=1: «Что изменилось?», «А если…», «Форс-мажор»); новый экран с чатом — tests/check-chat.js.
// Цель — убедиться, что ни одно действие не падает с ошибкой. Вёрстку этот прогон не видит.
const dir = process.argv[2] || require('path').join(__dirname, '..'), fs = require('fs'), vm = require('vm');
function makeWorld(storage) {
  const els = {};
  function el(id) {
    if (els[id]) return els[id];
    const handlers = {};
    const e = { id, innerHTML: '', textContent: '', className: '', value: '', hidden: false, disabled: false, style: {}, attrs: {}, handlers,
      classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
      addEventListener(t, f) { (handlers[t] = handlers[t] || []).push(f); },
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }, hasAttribute(k) { return k in this.attrs; },
      closest() { return this; }, querySelectorAll() { return []; }, focus() {}, remove() {},
      tBodies: [{ innerHTML: '', rows: [] }] };
    return els[id] = e;
  }
  const document = { getElementById: el, querySelectorAll: () => [], addEventListener() {}, createElement: () => el('tmp' + Math.random()), activeElement: null };
  const localStorage = { getItem: k => storage[k] || null, setItem: (k, v) => { storage[k] = String(v); }, removeItem: k => { delete storage[k]; } };
  const timers = [];
  const win = { document, localStorage, location: { href: 'http://x/index.html?old=1', search: '?old=1', protocol: 'http:' }, navigator: {}, console,
    setTimeout: (f, ms) => { timers.push(f); return timers.length; }, clearTimeout: i => { if (i) timers[i - 1] = null; },
    Promise, Date, Math, JSON, URL, AbortController, fetch: () => Promise.reject(new Error('нет сети')), scrollTo() {} };
  win.window = win; win.globalThis = win;
  const ctx = vm.createContext(win);
  const load = f => vm.runInContext(fs.readFileSync(dir + '/' + f, 'utf8'), ctx, { filename: f });
  const flush = async () => { for (let n = 0; n < 20; n++) { await new Promise(r => setImmediate(r)); const run = timers.splice(0); run.forEach(f => f && f()); } };
  const fire = (id, type, target) => { const hs = (els[id] && els[id].handlers[type]) || []; if (!hs.length) throw new Error('нет обработчика ' + id + ':' + type); hs.forEach(h => h({ target: target || els[id], preventDefault() {} })); };
  const btn = attrs => { const b = el('b' + Math.random()); Object.assign(b.attrs, attrs.attrs || {}); b.id = attrs.id || ''; b.closest = () => b; return b; };
  return { win, el, load, flush, fire, btn, els };
}
(async () => {
  const storage = {};
  const A = makeWorld(storage);
  ['js/config.js', 'js/store.js', 'js/settings.js', 'js/data.js', 'js/roads.js', 'js/base-plan.js', 'js/solver.js', 'js/fleet.js', 'js/replan.js', 'js/changes.js', 'js/proposal.js', 'js/assistant.js', 'js/chat.js', 'js/map.js', 'js/app.js'].forEach(A.load);
  await A.flush();
  const text = id => A.el(id).innerHTML || A.el(id).textContent;
  console.log('диспетчер открыт без сервера:', A.el('conn').textContent, '|', A.el('status').textContent);
  // форс-мажор до утверждения: должно быть предупреждение
  A.fire('btn-incident', 'click'); console.log('до утверждения:', A.el('toast').textContent.slice(0, 60));
  A.fire('btn-approve', 'click'); console.log('утверждение:', A.el('approval').textContent);
  // три вида происшествий подряд
  const steps = [['breakdown', 7], ['delay', 3], ['stop', 5], ['stop', 6, 'drop']];
  for (const [type, vid, action] of steps) {
    A.fire('btn-incident', 'click');
    if (A.el('fm-overlay').hidden) { console.log(type, 'окно не открылось:', A.el('toast').textContent); continue; }
    const sel = A.el('fm-vehicle'); sel.value = String(vid); A.fire('fm-body', 'change', sel);
    A.fire('fm-body', 'click', A.btn({ attrs: { 'data-type': type } }));
    if (action) A.fire('fm-body', 'click', A.btn({ attrs: { 'data-action': action } }));
    // поля формы в подделке пустые, поэтому читаем их из разметки
    const html = A.el('fm-body').innerHTML, at = /id="fm-at" value="([^"]+)"/.exec(html), stop = /<option value="(\d+)" selected>\d\d:\d\d/.exec(html);
    A.el('fm-at').value = at ? at[1] : ''; A.el('fm-delay').value = '40'; A.el('fm-stop').value = stop ? stop[1] : '0';
    A.fire('fm-body', 'click', A.btn({ id: 'fm-go' }));
    const body = A.el('fm-body').innerHTML, n = (body.match(/data-pick/g) || []).length, err = /fm-error">([^<]+)/.exec(body);
    console.log('\n' + type + ' машина ' + vid + ' в ' + (at && at[1]) + ': вариантов ' + n + (err ? ' | отказ: ' + err[1] : ''));
    if (!n) { A.fire('fm-body', 'click', A.btn({ id: 'fm-cancel' })); continue; }
    A.fire('fm-body', 'click', A.btn({ attrs: { 'data-pick': String(n - 1) } }));     // берём последний вариант
    console.log('  черновик:', A.el('approval').textContent, '|', (/<b>([^<]+)<\/b>/.exec(text('incident')) || [])[1], '| кнопки в баннере:', /inc-approve/.test(text('incident')));
    // раскрываем каждый маршрут, чтобы отрисовать списки точек
    for (let k = 0; k < 16; k++) { A.fire('routes', 'click', (() => { const b = A.btn({ attrs: { 'data-k': String(k) } }); return b; })()); }
    const routes = text('routes');
    console.log('  в маршрутах: перегрузок', (routes.match(/class="pickup"/g) || []).length, '· сломана', /снята с маршрута/.test(routes), '· «не доставим»', /Сегодня не доставим/.test(routes));
    // ручная правка: отдать недоставленную точку машине 1
    const give = /class="move" data-oid="(\d+)" aria-label="Всё-таки отдать машине"/.exec(routes);
    if (give) { const s = A.el('mv'); s.classList.contains = c => c === 'move'; s.value = '1'; s.attrs['data-oid'] = give[1]; A.fire('routes', 'change', s); console.log('  правка логиста:', A.el('toast').textContent); }
    A.fire('incident', 'click', { id: 'inc-approve' });
    console.log('  после утверждения:', A.el('approval').textContent, '|', /водители видят/.test(text('incident')));
  }
  // отмена предложения
  A.fire('btn-incident', 'click'); A.el('fm-at').value = ''; A.fire('fm-body', 'click', A.btn({ id: 'fm-go' }));
  if (/data-pick/.test(A.el('fm-body').innerHTML)) { A.fire('fm-body', 'click', A.btn({ attrs: { 'data-pick': '0' } })); A.fire('incident', 'click', { id: 'inc-cancel' }); console.log('\nотмена предложения:', A.el('approval').textContent, '|', A.el('toast').textContent); }
  else { console.log('\nещё одно происшествие:', (/fm-error">([^<]+)/.exec(A.el('fm-body').innerHTML) || [])[1]); A.fire('fm-body', 'click', A.btn({ id: 'fm-cancel' })); }
  // правка заказа в идущем дне, «по списку», пересчёт с нуля, сброс
  const kg = A.el('kgx'); kg.classList.contains = c => c === 'kg'; kg.value = '900'; kg.closest = () => ({ getAttribute: () => '12', classList: { toggle() {} } });
  A.fire('orders-table', 'change', kg); await A.flush(); console.log('правка заказа в идущем дне:', A.el('status').textContent);
  A.fire('view-naive', 'click'); A.fire('view-best', 'click');
  A.fire('btn-recalc', 'click'); await A.flush(); console.log('пересчёт с нуля:', A.el('toast').textContent.slice(0, 50), '|', A.el('approval').textContent);
  A.fire('btn-reset', 'click'); await A.flush(); console.log('сброс демо:', A.el('approval').textContent, '| баннер пуст:', text('incident') === '');
  // Правки автора 15 ноября: карточка машины по макету, время точки плашкой, клик по заказу → карта.
  {
    const who = A.btn({}); who.closest = sel => sel === 'td.who' ? who : (sel === 'tr' ? { getAttribute: () => '1' } : null);
    A.fire('orders-table', 'click', who); await A.flush();          // заказ 1 — «ст 64», важная точка
    const r = text('routes'), card = /<div class="route sel"[\s\S]*?<\/ol>/.exec(r);
    if (!card) throw new Error('клик по заказу не раскрыл маршрут его машины');
    if (!/class="chip route-num"/.test(r) || !/ точ · [\d,]+ км · \d\d:\d\d–\d\d:\d\d/.test(r)) throw new Error("строка машины не как у заказов");
    if (!/class="stop-time">\d\d:\d\d</.test(card[0]) || !/class="stop-star"[^>]*>★ важная · 06:00–07:00/.test(card[0])) throw new Error('нет плашки времени или звезды');
    if (!/<svg[\s\S]*r="16"/.test(A.el('map').innerHTML)) throw new Error('на схеме нет кольца вокруг выбранного заказа');
    console.log('клик по заказу «ст 64»: маршрут раскрыт, кольцо на схеме, звезда «★ важная · 06:00–07:00»');
  }
  // Строка «почему машин столько» и переключатель «Что важнее» во вкладке «Правила»: туда и обратно.
  console.log('строка про машины:', (/>([^<]+)<\/p>/.exec(text('fleet-note')) || [])[1]);
  if (!/Машины выбраны по весу/.test(text('fleet-note'))) throw new Error('нет строки «Машины выбраны по весу»');
  if (!/id="set-fleetPriority"/.test(text('settings-form'))) throw new Error('во вкладке «Правила» нет переключателя');
  for (const value of ['overtime', 'чепуха', 'fewer']) {
    const s = A.el('set-fleetPriority'); s.attrs['data-key'] = 'fleetPriority'; s.value = value;
    A.fire('settings-form', 'change', s); await A.flush();
    console.log('переключатель → ' + value + ':', A.el('status').textContent, '|', (/>([^<]+)<\/p>/.exec(text('fleet-note')) || [])[1].slice(0, 60));
  }
  // Этап 1Б: верхняя строка — четыре цели заказчика; пять кнопок «а если»: открыть → отменить → открыть → применить.
  for (const t of ['Время доставки', 'Суммарный пробег', 'Количество транспорта', 'Окно доставки']) if (text('kpis').indexOf(t) < 0) throw new Error('в верхней строке нет «' + t + '»');
  console.log('\nКнопки «а если»:');
  for (const key of ['normal', 'unload25', 'small200', 'minus1', 'priority']) {
    A.fire('btn-reset', 'click'); await A.flush();
    if (!/data-whatif="minus1"/.test(text('whatif'))) throw new Error('нет кнопок «а если» в неутверждённом плане');
    const kpiBefore = text('kpis'), routesBefore = text('routes');
    const b = A.btn({ attrs: { 'data-whatif': key } });
    A.fire('whatif', 'click', b); await A.flush();
    if (!/prop-apply/.test(text('proposal'))) throw new Error(key + ': карточка не открылась: ' + text('proposal').slice(0, 200));
    if (A.el('map-flag').hidden) throw new Error(key + ': на карте нет пометки «предложение»');
    if (text('whatif') !== '') throw new Error(key + ': кнопки «а если» видны поверх открытого предложения');
    // правка таблицы, пока предложение открыто: не принимается, подсказка
    A.fire('orders-table', 'change', kg); await A.flush();
    if (!/Открыто предложение/.test(A.el('toast').textContent)) throw new Error(key + ': правка при открытом предложении принята молча');
    A.fire('proposal', 'click', { id: 'prop-cancel' }); await A.flush();
    if (text('kpis') !== kpiBefore || text('routes') !== routesBefore) throw new Error(key + ': «Отменить» не вернуло прежний план');
    if (text('proposal') !== '' || !A.el('map-flag').hidden) throw new Error(key + ': карточка не закрылась');
    A.fire('whatif', 'click', b); await A.flush();
    const goals = (text('proposal').match(/<tr class="changed">/g) || []).length;
    A.fire('proposal', 'click', { id: 'prop-apply' }); await A.flush();
    console.log('  ' + key + ': изменилось целей в карточке ' + goals + ' | ' + A.el('status').textContent + ' | ' + (/>([^<]+)<\/p>/.exec(text('fleet-note')) || [])[1].slice(0, 70));
    if (text('proposal') !== '') throw new Error(key + ': после «Применить» карточка осталась');
  }
  // ошибочный список не роняет экран: карточка с отказом
  A.fire('btn-reset', 'click'); await A.flush();
  A.fire('whatif', 'click', A.btn({ attrs: { 'data-whatif': 'чепуха' } })); await A.flush();
  console.log('  чепуха: ' + (/не построено/.test(text('proposal')) ? 'отказ показан' : 'карточки нет'));
  A.fire('proposal', 'click', { id: 'prop-cancel' }); await A.flush();
  // после утверждения кнопок «а если» нет: день идёт
  A.fire('btn-approve', 'click'); await A.flush();
  if (text('whatif') !== '') throw new Error('кнопки «а если» видны после утверждения плана');
  // новый вид происшествия «просят другое время» в окне «Форс-мажор»
  A.fire('btn-incident', 'click');
  A.fire('fm-body', 'click', A.btn({ attrs: { 'data-type': 'later' } }));
  const fmHtml = A.el('fm-body').innerHTML, at = /id="fm-at" value="([^"]+)"/.exec(fmHtml), stop = /<option value="(\d+)" selected>\d\d:\d\d/.exec(fmHtml);
  A.el('fm-at').value = at ? at[1] : ''; A.el('fm-stop').value = stop ? stop[1] : '0'; A.el('fm-later').value = '14:00';
  A.fire('fm-body', 'click', A.btn({ id: 'fm-go' }));
  const body = A.el('fm-body').innerHTML, err = /fm-error">([^<]+)/.exec(body);
  console.log('  форс-мажор «просят другое время»: ' + (/data-pick/.test(body) ? (/<p class="fm-lead">([^<]+)/.exec(body) || [])[1] : 'отказ: ' + (err && err[1])));
  if (/data-pick/.test(body)) { A.fire('fm-body', 'click', A.btn({ attrs: { 'data-pick': '0' } })); console.log('  черновик: ' + A.el('approval').textContent); }
  else A.fire('fm-body', 'click', A.btn({ id: 'fm-cancel' }));
  A.fire('btn-reset', 'click'); await A.flush();

  // команда словами (этап 2): модель поддельная, отвечает так, как ответила бы на фразу
  console.log('\nкоманда словами:');
  const answer = changes => () => Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true, changes, questions: [] }) });
  const send = async text => { A.el('as-text').value = text; A.fire('assistant', 'click', A.btn({ id: 'as-send' })); await A.flush(); return text_('as-card'); };
  const text_ = id => A.el(id).innerHTML;
  A.win.fetch = answer([{ kind: 'vehicle_off', vehicle: 3 }, { kind: 'vehicle_off', vehicle: 9 }, { kind: 'order_time', store: 'Щорса', time: '10:00' }]);
  let cardHtml = await send('У машин 3 и 9 водители заболели, магазин на Щорса просит после 10');
  if (!/Я понял так/.test(cardHtml) || !/найдено 5, выберите/.test(cardHtml)) throw new Error('карточка «Я понял так» не та: ' + cardHtml.slice(0, 300));
  A.fire('assistant', 'click', A.btn({ id: 'as-go' })); await A.flush();
  if (!/выберите магазин/.test(A.el('toast').textContent) || text('proposal') !== '') throw new Error('посчитано без выбора магазина');
  const pickEl = A.btn({ attrs: { 'data-row': '2', 'data-field': 'pick' } }); pickEl.value = '1';
  A.fire('assistant', 'change', pickEl); await A.flush();
  A.fire('assistant', 'click', A.btn({ id: 'as-go' })); await A.flush();
  if (!/prop-apply/.test(text('proposal'))) throw new Error('предложение по команде не открылось: ' + text('proposal').slice(0, 300));
  console.log('  фраза автора → карточка → выбор магазина → предложение: ' + (text('proposal').match(/<li>[^<]+/g) || []).map(x => x.slice(4)).join('; '));
  A.fire('proposal', 'click', { id: 'prop-cancel' }); await A.flush();
  A.win.fetch = () => Promise.reject(new Error('нет сети'));
  cardHtml = await send('машина 5 не выходит');
  if (!/Заполните вручную/.test(cardHtml)) throw new Error('без сети нет пустой карточки: ' + cardHtml.slice(0, 200));
  A.el('as-add-kind').value = 'vehicle_off'; A.fire('assistant', 'click', A.btn({ id: 'as-add' })); await A.flush();
  A.fire('assistant', 'click', A.btn({ id: 'as-go' })); await A.flush();
  console.log('  без сети: ' + (/модель недоступна|Модель недоступна/i.test(cardHtml) ? 'сообщение есть' : 'нет сообщения') + ', ручная строка → ' + (/prop-apply/.test(text('proposal')) ? 'предложение открылось' : 'предложения нет'));
  if (!/prop-apply/.test(text('proposal'))) throw new Error('ручная строка не дала предложения');
  A.fire('proposal', 'click', { id: 'prop-cancel' }); await A.flush();
  A.fire('btn-approve', 'click'); await A.flush();
  if (!/Машина 4 сломалась/.test(text('as-examples'))) throw new Error('после утверждения примеры фраз не поменялись');
  A.win.fetch = answer([{ kind: 'breakdown', vehicle: 4 }]);
  await send('Машина 4 сломалась');
  A.fire('assistant', 'click', A.btn({ id: 'as-go' })); await A.flush();
  if (A.el('fm-overlay').hidden || !/<option value="4" selected>/.test(A.el('fm-body').innerHTML)) throw new Error('окно «Форс-мажор» не открылось с машиной 4: ' + A.el('toast').textContent);
  console.log('  день идёт: «Машина 4 сломалась» → окно «Форс-мажор», машина 4 выбрана');
  A.fire('fm-body', 'click', A.btn({ id: 'fm-cancel' }));
  A.fire('btn-reset', 'click'); await A.flush();

  // Этап 3: «минус 4 машины» → два варианта → «без нарушений» → вернуть точку машине → «Применить» → утвердить.
  console.log('\n«не везём сегодня»:');
  A.win.fetch = answer([3, 5, 7, 9].map(v => ({ kind: 'vehicle_off', vehicle: v })));
  await send('У машин 3, 5, 7 и 9 водители заболели');
  A.fire('assistant', 'click', A.btn({ id: 'as-go' })); await A.flush();
  if (!/data-variant="1"/.test(text('proposal'))) throw new Error('минус 4 машины: в карточке нет двух вариантов: ' + text('proposal').slice(0, 300));
  if (/Сегодня не доставим/.test(text('routes'))) throw new Error('вариант «везём всё» показал список «не доставим»');
  const vb = A.btn({ attrs: { 'data-variant': '1' } }); vb.closest = () => vb;
  A.fire('proposal', 'click', vb); await A.flush();
  const dropRoutes = text('routes'), nDrop = (/Сегодня не доставим: (\d+)/.exec(dropRoutes) || [])[1];
  if (!nDrop || !/Не везём сегодня: /.test(text('proposal'))) throw new Error('вариант «без нарушений»: нет списка «не везём»');
  if (!/Нарушений правил<\/th><td>[^<]*<\/td><td>0</.test(text('proposal'))) throw new Error('вариант «без нарушений»: в карточке нарушения не ноль');
  console.log('  «Без нарушений»: не доставим ' + nDrop + ' точ. | ' + (/>([^<]+)<\/p>/.exec(text('fleet-note')) || [])[1].slice(0, 120));
  // Вернуть точку машине, пока предложение открыто: меняется предложение, а не общий план.
  let give = /class="move" data-oid="(\d+)" aria-label="Всё-таки отдать машине"/.exec(dropRoutes);
  if (!give) throw new Error('у точки «не везём» нет «Всё-таки отдать машине»');
  const sel1 = A.el('mv3'); sel1.classList.contains = c => c === 'move'; sel1.value = '1'; sel1.attrs['data-oid'] = give[1];
  A.fire('routes', 'change', sel1); await A.flush();
  const nDrop2 = (/Сегодня не доставим: (\d+)/.exec(text('routes')) || [])[1];
  if (+nDrop2 !== nDrop - 1 || !/В предложении точка отдана машине 1/.test(A.el('toast').textContent)) throw new Error('вернуть точку в предложении: было ' + nDrop + ', стало ' + nDrop2);
  A.fire('proposal', 'click', { id: 'prop-apply' }); await A.flush();
  const saved = JSON.parse(storage['milk.plan.v3']).draft.assignment.filter(a => a.v === 0)[0];
  if (!saved || saved.s.length !== nDrop - 1) throw new Error('после «Применить» в черновике нет строки «не везём»');
  console.log('  вернули точку в предложении: ' + nDrop + ' → ' + nDrop2 + '; «Применить»: в черновике «не везём» ' + saved.s.length + ' точ.');
  // В общем плане до начала дня точку тоже можно вернуть.
  give = /class="move" data-oid="(\d+)" aria-label="Всё-таки отдать машине"/.exec(text('routes'));
  const sel2 = A.el('mv4'); sel2.classList.contains = c => c === 'move'; sel2.value = '2'; sel2.attrs['data-oid'] = give[1];
  A.fire('routes', 'change', sel2); await A.flush();
  const nDrop3 = (/Сегодня не доставим: (\d+)/.exec(text('routes')) || [])[1];
  if (+nDrop3 !== nDrop - 2) throw new Error('вернуть точку в общем плане: ' + nDrop3);
  A.fire('btn-approve', 'click'); await A.flush();
  const appr = JSON.parse(storage['milk.plan.v3']).approved.assignment.filter(a => a.v === 0)[0];
  if (!appr || appr.s.length !== nDrop - 2) throw new Error('утверждённый план без строки «не везём»');
  console.log('  вернули ещё одну в общем плане: ' + nDrop3 + '; утверждено, «не везём» ' + appr.s.length + ' точ.');
  // Поломка в идущем дне: утренние «не везём» остаются в списке.
  A.fire('btn-incident', 'click');
  const fh = A.el('fm-body').innerHTML, fat = /id="fm-at" value="([^"]+)"/.exec(fh);
  A.el('fm-at').value = fat ? fat[1] : ''; A.fire('fm-body', 'click', A.btn({ id: 'fm-go' }));
  if (/data-pick/.test(A.el('fm-body').innerHTML)) {
    A.fire('fm-body', 'click', A.btn({ attrs: { 'data-pick': '0' } }));
    const nLive = +(/Сегодня не доставим: (\d+)/.exec(text('routes')) || [])[1];
    if (!(nLive >= nDrop - 2)) throw new Error('после поломки утренние «не везём» пропали: ' + nLive);
    console.log('  поломка после утверждения: не доставим ' + nLive + ' точ. (с утра ' + (nDrop - 2) + ')');
  } else { console.log('  поломка: ' + (/fm-error">([^<]+)/.exec(A.el('fm-body').innerHTML) || [])[1]); A.fire('fm-body', 'click', A.btn({ id: 'fm-cancel' })); }
  A.fire('btn-reset', 'click'); await A.flush();
  if (/Сегодня не доставим/.test(text('routes'))) throw new Error('после сброса остался список «не доставим»');

  console.log('\nЭкран диспетчера: ошибок нет');
})().catch(e => { console.log('УПАЛО: ' + e.stack); process.exit(1); });
