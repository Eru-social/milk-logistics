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
  ['js/config.js', 'js/store.js', 'js/settings.js', 'js/data.js', 'js/solver.js', 'js/replan.js', 'js/map.js', 'js/app.js'].forEach(A.load);
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
  console.log('\nЭкран диспетчера: ошибок нет');
})().catch(e => { console.log('УПАЛО: ' + e.stack); process.exit(1); });
