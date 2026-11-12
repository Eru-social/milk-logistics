// Страница водителя без браузера: что видит водитель сломанной машины и водитель машины-помощника.
const dir = process.argv[2] || require('path').join(__dirname, '..'), fs = require('fs'), vm = require('vm');
global.window = {};
require(dir + '/js/settings.js'); require(dir + '/js/data.js');
const S = require(dir + '/js/solver.js'), R = require(dir + '/js/replan.js');
const D = window.MILK_DATA, clone = x => JSON.parse(JSON.stringify(x));
const input = { depot: D.depot, orders: clone(D.orders), vehicles: clone(D.vehicles), settings: Object.assign({}, window.MILK_SETTINGS), roads: null };
const base = S.fromAssignment(input, S.toAssignment(S.solve(input)));
const res = R.propose(input, base, { type: 'breakdown', vehicleId: 7, at: 640 }, null), v = res.variants[0];
const helper = v.plan.routes.find(r => r.stops.some(x => x.pickup)).vehicle.id;
const approved = { assignment: clone(v.assignment), summary: { live: clone(v.live) }, at: new Date().toISOString() };
function page(vehicleId, events) {
  const els = {};
  const el = id => els[id] || (els[id] = { id, innerHTML: '', textContent: '', className: '', value: '', hidden: false, disabled: false,
    addEventListener() {}, querySelectorAll: () => [], setAttribute() {}, getAttribute: () => null });
  const win = { document: { getElementById: el }, localStorage: { getItem: () => String(vehicleId), setItem() {}, removeItem() {} }, console, setTimeout, clearTimeout,
    navigator: {}, location: { reload() {} }, scrollTo() {}, Promise, Date, Math, JSON,
    MILK_DATA: D, MILK_SETTINGS: window.MILK_SETTINGS, MilkSolver: S,
    MilkStore: { load: () => Promise.resolve({ orders: clone(input.orders), vehicles: clone(input.vehicles), settings: {}, approved: approved, draft: null, events: events || [], roads: null }),
      subscribe() {}, addEvent: () => Promise.resolve(null) } };
  win.window = win;
  vm.runInContext(fs.readFileSync(dir + '/js/driver.js', 'utf8'), vm.createContext(win), { filename: 'driver.js' });
  return new Promise(r => setImmediate(() => r(el('app').innerHTML)));
}
const strip = h => h.replace(/<a [^>]*>[^<]*<\/a>/g, '').replace(/<\/(li|p|h1|h2|h3|section|div|b)>/g, '\n').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').split('\n').map(s => s.trim()).filter(Boolean);
(async () => {
  let h = await page(7);
  console.log('--- водитель сломанной машины 7 ---'); strip(h).slice(0, 8).forEach(l => console.log('  ' + l));
  h = await page(helper, [{ id: 1, vehicleId: helper, kind: 'departed', note: '', at: new Date().toISOString() }]);
  const lines = strip(h), i = lines.findIndex(l => /Перегрузка из сломанной/.test(l));
  console.log('--- водитель машины-помощника ' + helper + ' ---'); lines.slice(0, 7).forEach(l => console.log('  ' + l));
  console.log('  …в списке точек:'); lines.slice(Math.max(0, i - 2), i + 6).forEach(l => console.log('  ' + l));
  // водитель дошёл до точки, перед которой перегрузка: карточка «Сначала перегрузка»
  const r = v.plan.routes.find(x => x.vehicle.id === helper), ev = [{ id: 1, vehicleId: helper, kind: 'departed', note: '', at: new Date().toISOString() }];
  for (const x of r.stops) { if (x.pickup) break; ev.push({ id: ev.length + 1, vehicleId: helper, orderId: v.plan.stops[x.stop].orders[0].id, kind: 'done', note: '', at: new Date().toISOString() }); }
  h = await page(helper, ev);
  console.log('--- он же, когда подошла очередь перегрузки ---'); strip(h).slice(1, 9).forEach(l => console.log('  ' + l));
  h = await page(2); console.log('--- обычная машина 2: страница открылась, строк ' + strip(h).length + ', перегрузок ' + (h.match(/pickup/g) || []).length);
})().catch(e => { console.log('УПАЛО: ' + e.stack); process.exit(1); });
