// Прогон экрана диспетчера и страницы водителя без браузера: простая подделка страницы.
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
  const win = { document, localStorage, location: { href: 'http://x/index.html', protocol: 'http:' }, navigator: {}, console,
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
  ['js/config.js', 'js/store.js', 'js/settings.js', 'js/data.js', 'js/roads.js', 'js/base-plan.js', 'js/solver.js', 'js/fleet.js', 'js/replan.js', 'js/changes.js', 'js/proposal.js', 'js/assistant.js', 'js/map.js', 'js/app.js'].forEach(A.load);
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

  console.log('\nЭкран диспетчера: ошибок нет');
})().catch(e => { console.log('УПАЛО: ' + e.stack); process.exit(1); });
