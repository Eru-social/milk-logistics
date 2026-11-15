// ДВА ЭКРАНА ДИСПЕТЧЕРА ПРАВЯТ ОДНОВРЕМЕННО (этап 6). Запуск: node tests/check-two-screens.js (около минуты).
// Два экрана (A и B) работают с одной поддельной базой (tests/fake-page.js): база выполняет запросы js/store.js
// и рассылает изменения в порядке записи, у каждого экрана своя задержка сети. Проверяем:
//   — правки с двух экранов почти в одну секунду (разные заказы, разные правила, разные машины) не теряются:
//     все есть в базе и на обоих экранах;
//   — после этого оба экрана показывают один и тот же план, и это план из базы: третий экран C, открытый с нуля,
//     показывает то же самое (верхняя строка и маршруты совпадают до знака);
//   — пока другой экран применяет «обычный день» (214 заказов), числа на втором экране меняются не больше двух раз
//     («ждём план» → новый план), а не прыгают после каждой пачки строк;
//   — «Сбросить демо», когда связь с базой пропала: экран всё равно возвращается к эталону и честно об этом пишет;
//     когда связь вернулась, сброс снова идёт через базу;
//   — медленная сеть: база не ответила за 12 секунд — экран открывается сам по себе, с эталонным планом.
const { makeClock, makeServer, makePage } = require('./fake-page.js');
let fails = 0;
function ok(cond, text) { if (!cond) { fails++; console.log('  ОШИБКА: ' + text); } else console.log('  верно: ' + text); }
const stripStatus = h => h;   // верхняя строка и маршруты не содержат времени и статуса — сравниваем как есть

(async () => {
  const clock = makeClock(), server = makeServer(clock);
  const open = net => makePage({ clock, server, net, storage: {} });
  // У B медленная отправка: его правка доходит до A, когда A уже посчитал свой план, — черновики «перекрещиваются».
  const A = open({ up: 60, down: 60 }), B = open({ up: 1000, down: 90 });
  await clock.advance(3000);
  ok(A.el('conn').textContent === 'Онлайн' && B.el('conn').textContent === 'Онлайн', 'оба экрана на связи');
  const view = P => stripStatus(P.text('kpis')) + '\n' + P.text('routes');
  function sameEverywhere(label) {
    const C = open({ up: 40, down: 40 });
    return clock.advance(3000).then(() => {
      ok(view(A) === view(B), label + ': экраны A и B показывают один план');
      ok(view(C) === view(A), label + ': новый экран C (план из базы) показывает тот же план');
    });
  }
  const orderEdit = (P, id, kg) => {
    const tr = P.btn({ attrs: { 'data-id': String(id) } });
    P.fire('orders-table', 'change', P.btn({ cls: 'kg', value: kg, tr }));
  };
  const settingEdit = (P, key, value) => P.fire('settings-form', 'change', P.btn({ attrs: { 'data-key': key }, type: 'number', value }));
  const vehicleOff = (P, id) => { const b = P.btn({ cls: 'veh-on', attrs: { 'data-id': String(id) } }); b.checked = false; P.fire('vehicles-table', 'change', b); };
  const row = (t, id) => server.tables[t].find(r => r.id === id);

  console.log('1. Два экрана правят разные заказы в одну секунду');
  orderEdit(A, 12, 900); orderEdit(B, 40, 0);
  await clock.advance(30000);
  ok(row('orders', 12).kg === 900 && row('orders', 40).kg === 0, 'обе правки в базе (заказ 12 — 900 кг, заказ 40 — 0 кг)');
  ok(A.el('kg-40').value == 0 && B.el('kg-12').value == 900, 'каждый экран видит чужую правку в таблице');
  await sameEverywhere('заказы');

  console.log('2. Два экрана правят разные правила в одну секунду');
  settingEdit(A, 'serviceMin', '25'); settingEdit(B, 'minLoadPct', '85');
  await clock.advance(30000);
  const st = (server.tables.app_settings[0] || {}).data || {};
  ok(st.serviceMin === 25 && st.minLoadPct === 85, 'в базе оба правила: разгрузка 25 мин и загрузка 85% (было бы одно — последний затёр бы первого)');
  ok(/id="set-serviceMin"[^>]*value="25"/.test(B.text('settings-form')) && /id="set-minLoadPct"[^>]*value="85"/.test(A.text('settings-form')), 'каждый экран видит чужое правило во вкладке «Правила»');
  await sameEverywhere('правила');

  console.log('3. Два экрана снимают с линии разные машины в одну секунду');
  vehicleOff(A, 3); vehicleOff(B, 5);
  await clock.advance(30000);
  ok(row('vehicles', 3).active === false && row('vehicles', 5).active === false, 'в базе сняты обе машины, 3 и 5');
  await sameEverywhere('машины');

  console.log('4. Экран A применяет «обычный день», экран B смотрит');
  A.fire('btn-reset', 'click'); await clock.advance(20000);
  await sameEverywhere('после сброса');
  ok(server.tables.plans.find(p => p.id === 'draft').author === 'base', 'после сброса в базе эталонный черновик');
  const before = B.el('kpis').history.length;
  A.fire('whatif', 'click', A.btn({ attrs: { 'data-whatif': 'normal' } })); await clock.advance(500);
  ok(/prop-apply/.test(A.text('proposal')), 'на экране A открыто предложение «обычный день»');
  ok(B.el('kpis').history.length === before, 'пока предложение не применено, экран B не меняется (в базу ничего не ушло)');
  A.fire('proposal', 'click', { id: 'prop-apply' });
  await clock.advance(40000);
  const flips = B.el('kpis').history.length - before;
  ok(flips >= 1 && flips <= 2, 'числа на экране B сменились ' + flips + ' раз(а) — не мигают');
  ok(server.tables.orders.every(r => r.kg === 0 || r.kg % 10 === 0) && row('orders', 12).kg !== 900, 'в базе вес «обычного дня»');
  await sameEverywhere('«обычный день»');

  console.log('5. Связь с базой пропала, жюри нажимает «Сбросить демо»');
  server.offline = true;
  A.fire('btn-reset', 'click'); await clock.advance(20000);
  ok(/только на этом экране/.test(A.el('toast').textContent), 'экран A сбросился сам и честно пишет: «' + A.el('toast').textContent.slice(0, 70) + '…»');
  const fresh = makePage({ clock, storage: {} });          // экран без базы — эталон из файлов
  await clock.advance(2000);
  ok(view(A) === view(fresh), 'на экране A эталонный план, как у экрана без базы');
  server.offline = false;
  A.fire('btn-reset', 'click'); await clock.advance(20000);
  ok(A.el('conn').textContent === 'Онлайн' && /Демо сброшено/.test(A.el('toast').textContent), 'связь вернулась: сброс снова идёт через базу');
  await sameEverywhere('после сброса через базу');

  console.log('6. Медленная сеть: база отвечает дольше 12 секунд');
  const slow = open({ up: 9000, down: 9000 });
  await clock.advance(5000);
  ok(slow.el('conn').textContent === 'Подключаюсь…', 'первые секунды экран честно пишет «Подключаюсь…»');
  await clock.advance(15000);
  ok(/Без сервера/.test(slow.el('conn').textContent) && /Время доставки/.test(slow.text('kpis')), 'через 12 секунд экран работает сам по себе: «' + slow.el('conn').textContent + '», план на экране');

  console.log(fails ? '\nПРОВАЛЕНО проверок: ' + fails : '\nДва экрана: все проверки прошли');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('УПАЛО: ' + e.stack); process.exit(1); });
