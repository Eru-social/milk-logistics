// ПОКАЗ БЕЗ ИНТЕРНЕТА (этап 6, решение 12). Запуск: node tests/check-offline.js (около полуминуты).
// Проверяем:
//   1) index.html и driver.html грузят библиотеки, шрифты и стили только из папки проекта, все файлы на месте;
//      в коде к чужим серверам обращаются только те места, у которых есть запасной путь (список ниже);
//   2) библиотеки в vendor/ — ровно те файлы, что были подключены с CDN до этапа 6 (отпечатки SHA-256 записаны в README.md);
//   3) номер ?v=N одинаковый во всех подключениях;
//   4) линии по улицам (js/base-roads.js) есть для каждого маршрута эталона и «плана по списку»: начинаются и кончаются
//      у завода, длина близка к длине по таблице дорог;
//   5) весь сценарий защиты на поддельной странице без сети: экран открывается, план и линии эталона видны (без пунктира),
//      QR-код рисуется, «по списку», «а если» → «Применить», «Сбросить демо», «Утвердить», «Форс-мажор»;
//      команда словами честно пишет, что модели нет, и карточка заполняется вручную.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const dir = path.join(__dirname, '..');
const { makePage } = require('./fake-page.js');
let fails = 0, checks = 0;
function ok(cond, text) { checks++; if (!cond) { fails++; console.log('  ОШИБКА: ' + text); } }
const read = f => fs.readFileSync(path.join(dir, f), 'utf8');

// ---------- 1. Что грузят страницы ----------
console.log('1. Что грузят страницы');
const versions = new Set();
for (const page of ['index.html', 'driver.html']) {
  const html = read(page);
  const refs = [...html.matchAll(/<script[^>]+src="([^"]+)"|<link[^>]+href="([^"]+)"/g)].map(m => m[1] || m[2]);
  refs.forEach(ref => {
    ok(!/^(https?:)?\/\//.test(ref), page + ': подключение с чужого сервера: ' + ref);
    const file = ref.split('?')[0];
    ok(fs.existsSync(path.join(dir, file)), page + ': нет файла ' + file);
    const v = /\?v=(\d+)/.exec(ref); if (v) versions.add(v[1]);
  });
  ok(refs.some(r => /vendor\/supabase-js-2\.118\.0\/supabase\.js/.test(r)), page + ': клиент базы не из vendor/');
  console.log('  ' + page + ': подключений ' + refs.length + ', все из папки проекта');
}
const dv = /js\/roads\.js\?v=(\d+)/.exec(read('js/driver.js')); if (dv) versions.add(dv[1]);
ok(versions.size === 1, 'номер ?v= разный: ' + [...versions].join(', '));
read('css/style.css').concat(read('css/driver.css'), read('vendor/fonts/fonts.css')).replace(/url\("?([^)"]+)"?\)/g, (m, u) => { ok(!/^https?:/.test(u), 'стили грузят с чужого сервера: ' + u); return m; });
// Чужие серверы в коде — только с запасным путём.
const ALLOWED = {
  'mhdulbsrtmcdxrzeamqk.supabase.co': 'база; без неё экран работает сам (js/store.js)',
  'tiles.openfreemap.org': 'плитки карты; без них — схема (js/map.js)',
  'router.project-osrm.org': 'линии по улицам не эталонных маршрутов; без них — пунктир (js/map.js)',
  'yandex.by': 'ссылка «Открыть в Яндекс Картах» у водителя'
};
fs.readdirSync(path.join(dir, 'js')).filter(f => /\.js$/.test(f) && !/^(roads|data|base-plan|base-roads)\.js$/.test(f)).forEach(f => {
  [...read('js/' + f).matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].forEach(m => ok(ALLOWED[m[1]], 'js/' + f + ' обращается к ' + m[1] + ' без запасного пути'));
});

// ---------- 2. Библиотеки — те же файлы, что были на CDN ----------
console.log('2. Отпечатки библиотек');
const SHA = {   // сняты 15 ноября 2026 с unpkg.com и cdn.jsdelivr.net (те же адреса, что были в index.html до этапа 6)
  'vendor/maplibre-gl-5.24.0/maplibre-gl.js': '45a9b07a9189ce56054c620a947ccf41e291e58c95e9b61533b740aaa65ee5cb',
  'vendor/maplibre-gl-5.24.0/maplibre-gl.css': 'ab1e70d59ec40465bae7e7030da2f3ccf28133fd502e62bd598eefbadfd7a732',
  'vendor/supabase-js-2.118.0/supabase.js': 'ee3be8de192b97cb1d73d1e95d6b82bb1f6b658c0f97c4ef757fc331996ed3d3',
  'vendor/qrcode-generator-1.4.4/qrcode.js': '18ae399f81182bc9de916e9c77b195df20cc58d6f2d55a62b085a299f1bf1780'
};
Object.keys(SHA).forEach(f => {
  const sum = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex');
  ok(sum === SHA[f], f + ': отпечаток не совпал с файлом на CDN');
  ok(read('README.md').indexOf(SHA[f]) >= 0, f + ': отпечатка нет в README.md');
});
['vendor/maplibre-gl-5.24.0/LICENSE.txt', 'vendor/supabase-js-2.118.0/LICENSE', 'vendor/qrcode-generator-1.4.4/LICENSE', 'vendor/fonts/OFL-GolosText.txt', 'vendor/fonts/OFL-Unbounded.txt']
  .forEach(f => ok(fs.existsSync(path.join(dir, f)), 'нет лицензии ' + f));

// ---------- 3. Линии по улицам эталона ----------
console.log('3. Линии по улицам эталона и «плана по списку»');
global.window = {}; global.localStorage = { getItem() { return null; }, setItem() {} };
['settings', 'data', 'roads', 'base-plan', 'base-roads'].forEach(f => require(dir + '/js/' + f + '.js'));
const S = require(dir + '/js/solver.js'); require(dir + '/js/map.js');
const D = window.MILK_DATA, M = window.MilkMap;
const inp = { depot: D.depot, orders: D.orders, vehicles: D.vehicles, settings: Object.assign({}, window.MILK_SETTINGS), roads: S.roadsFrom(window.MILK_ROADS) };
const km = (a, b) => S.haversineKm({ lat: a[1], lon: a[0] }, { lat: b[1], lon: b[0] });
let lines = 0;
[['эталон', S.fromAssignment(inp, window.MILK_BASE_PLAN.assignment)], ['по списку', S.naive(inp)]].forEach(([name, plan]) => {
  plan.routes.forEach(r => {
    if (!r.seq.length) return;
    const hit = M.roadCached(D.depot, r.stops.map(x => plan.stops[x.stop]), false);
    ok(hit && hit.fromFile, name + ', ' + r.vehicle.name + ': линии нет в js/base-roads.js');
    if (!hit) return;
    lines++;
    const c = hit.coords, depot = [D.depot.lon, D.depot.lat];
    ok(c.length > 20 && km(c[0], depot) < 0.3 && km(c[c.length - 1], depot) < 0.3, name + ', ' + r.vehicle.name + ': линия не от завода до завода');
    ok(Math.abs(hit.km - r.km) / r.km < 0.25, name + ', ' + r.vehicle.name + ': длина линии ' + hit.km + ' км, по таблице дорог ' + r.km.toFixed(1));
  });
});
console.log('  линий в файле ' + Object.keys(window.MILK_BASE_ROADS).length + ', найдено для маршрутов ' + lines);

// ---------- 4. Сценарий без сети ----------
console.log('4. Сценарий защиты без сети');
(async () => {
  const A = makePage({ storage: {}, extra: ['vendor/qrcode-generator-1.4.4/qrcode.js', 'js/base-roads.js'] });
  A.win.navigator.onLine = false;
  const tick = () => A.clock.advance(5000), toast = () => A.el('toast').textContent, text = A.text;
  await tick();
  ok(/Без сервера/.test(A.el('conn').textContent), 'экран открылся без сервера: «' + A.el('conn').textContent + '»');
  ['Время доставки', 'Суммарный пробег', 'Количество транспорта', 'Окно доставки'].forEach(t => ok(text('kpis').indexOf(t) >= 0, 'в верхней строке есть «' + t + '»'));
  ok(/397/.test(text('kpis')), 'пробег эталона 397 км на экране');
  const map = () => A.el('map').innerHTML;
  ok(/<svg/.test(map()) && !/stroke-dasharray/.test(map()), 'карта-схема: все 16 линий эталона по улицам, без пунктира');
  ok(!/Прокладываю/.test(A.el('map-note').textContent), 'подпись под картой не обещает «прокладываю»');
  A.fire('btn-qr', 'click');
  ok(/<svg/.test(A.el('qr-code').innerHTML), 'QR-код для водителя рисуется без интернета');
  A.fire('view-naive', 'click'); await tick();
  ok(!/stroke-dasharray/.test(map()), '«По списку»: линии тоже из файла');
  A.fire('view-best', 'click'); await tick();
  A.fire('whatif', 'click', A.btn({ attrs: { 'data-whatif': 'normal' } })); await tick();
  ok(/prop-apply/.test(text('proposal')), '«а если: обычный день» → предложение');
  A.fire('proposal', 'click', { id: 'prop-apply' }); await A.clock.advance(20000);
  ok(text('proposal') === '' && /применено/.test(A.el('status').textContent), '«Применить» без сервера: ' + A.el('status').textContent);
  ok(/пунктиром/.test(A.el('map-note').textContent), 'новый план: линий нет, подпись честно говорит про пунктир («' + A.el('map-note').textContent.slice(0, 60) + '…»)');
  A.fire('btn-reset', 'click'); await tick();
  ok(/эталонный план/.test(A.el('status').textContent) && !/stroke-dasharray/.test(map()), '«Сбросить демо»: эталон и линии из файла');
  A.el('as-text').value = 'машина 5 не выходит'; A.fire('assistant', 'click', A.btn({ id: 'as-send' })); await tick();
  ok(/Нет интернета: модель недоступна/.test(text('as-card')), 'команда словами: «Нет интернета: модель недоступна. Заполните строки вручную»');
  A.el('as-add-kind').value = 'vehicle_off'; A.fire('assistant', 'click', A.btn({ id: 'as-add' })); await tick();
  A.fire('assistant', 'click', A.btn({ id: 'as-go' })); await tick();
  ok(/prop-apply/.test(text('proposal')), 'строка вручную → предложение');
  A.fire('proposal', 'click', { id: 'prop-cancel' }); await tick();
  A.fire('btn-approve', 'click'); await tick();
  ok(/Утверждён/.test(A.el('approval').textContent), '«Утвердить план» без сервера');
  A.fire('btn-incident', 'click');
  const fm = A.el('fm-body').innerHTML, at = /id="fm-at" value="([^"]+)"/.exec(fm);
  A.el('fm-at').value = at ? at[1] : '09:00';
  A.fire('fm-body', 'click', A.btn({ id: 'fm-go' })); await tick();
  ok(/data-pick/.test(A.el('fm-body').innerHTML), '«Форс-мажор» (поломка) без сервера: варианты посчитаны');
  if (/data-pick/.test(A.el('fm-body').innerHTML)) {
    A.fire('fm-body', 'click', A.btn({ attrs: { 'data-pick': '0' } })); await tick();
    A.fire('incident', 'click', { id: 'inc-approve' }); await tick();
    ok(/Утверждён/.test(A.el('approval').textContent), 'перестроение утверждено');
  }
  A.fire('btn-reset', 'click'); await tick();
  ok(/План не утверждён/.test(A.el('approval').textContent), 'сброс в конце: план не утверждён');
  console.log(fails ? '\nПРОВАЛЕНО проверок: ' + fails + ' из ' + checks : '\nБез интернета: все ' + checks + ' проверок прошли');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('УПАЛО: ' + e.stack); process.exit(1); });
