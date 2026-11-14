// Проверка команды словами С НАСТОЯЩЕЙ МОДЕЛЬЮ (этап 2). Запуск: node tools/check-phrases.js
// Нужны интернет и развёрнутая функция assistant с ключом модели в секретах Supabase.
// Отправляет 20 фраз из tests/phrases.json в функцию, находит магазины нашим кодом и сравнивает строки карточки с ожидаемыми.
// Итог по каждой фразе: «верно», «вопрос» (модель спросила вместо действия — не ошибка, но и не успех) или «НЕВЕРНО».
// Готово по плану, когда верно не меньше 18 из 20, а НЕВЕРНО — ни одной.
// Между фразами пауза 8 секунд: в функции лимит 8 запросов в минуту с одного адреса.
const path = require('path'), fs = require('fs');
const dir = path.join(__dirname, '..');
global.window = {};
require(dir + '/js/config.js'); require(dir + '/js/data.js'); require(dir + '/js/changes.js');
const A = require(dir + '/js/assistant.js'), D = window.MILK_DATA;
const phrases = JSON.parse(fs.readFileSync(dir + '/tests/phrases.json', 'utf8')).phrases;
const url = window.MILK_CONFIG.supabaseUrl + '/functions/v1/assistant', key = window.MILK_CONFIG.supabaseKey;
const wait = ms => new Promise(r => setTimeout(r, ms));

(async function () {
  let good = 0, asked = 0, wrong = 0;
  for (let n = 0; n < phrases.length; n++) {
    const p = phrases[n];
    const res = await A.ask(p.text, p.mode, D.vehicles, { url, key, fetch, timeoutMs: 15000 });
    let verdict, got = '';
    if (!res.ok) { verdict = 'ОШИБКА ФУНКЦИИ: ' + res.message; wrong++; }
    else {
      const r = A.resolve(res, { orders: D.orders, vehicles: D.vehicles }), lines = r.rows.map(A.line);
      got = JSON.stringify(lines) + (r.questions.length ? ' вопросы: ' + JSON.stringify(r.questions) : '');
      if (JSON.stringify(lines) === JSON.stringify(p.expect) && (!p.ask || r.questions.length)) { verdict = 'верно'; good++; }
      else if (!lines.length && r.questions.length) { verdict = 'вопрос'; asked++; }
      else { verdict = 'НЕВЕРНО, ждали ' + JSON.stringify(p.expect); wrong++; }
    }
    console.log((n + 1) + '. ' + p.text + '\n   ' + verdict + (got ? '\n   получено: ' + got : ''));
    if (n < phrases.length - 1) await wait(8000);
  }
  console.log('\nИтог: верно ' + good + ' из 20, вопрос вместо действия ' + asked + ', неверно ' + wrong + '.');
  console.log(good >= 18 && !wrong ? 'Готово по плану этапа 2.' : 'Пока не готово: нужно не меньше 18 верных и ни одного неверного.');
  process.exit(good >= 18 && !wrong ? 0 : 1);
})();
