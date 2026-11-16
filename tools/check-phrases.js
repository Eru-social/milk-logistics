// Проверка команды словами С НАСТОЯЩЕЙ МОДЕЛЬЮ (этап 2). Запуск: node tools/check-phrases.js
// Нужны интернет и развёрнутая функция assistant с ключом модели в секретах Supabase.
// Отправляет 20 фраз из tests/phrases.json в функцию, находит магазины нашим кодом и сравнивает строки карточки с ожидаемыми.
// Итог по каждой фразе: «верно», «вопрос» (модель спросила вместо действия или вместо части действий, а лишнего
// не сделала — не ошибка, но и не успех), «НЕВЕРНО» (хоть одно действие не то, что ждали) или «СБОЙ» (модель не ответила:
// бесплатная модель занята, лимит, нет связи — логист видит пустую карточку и сообщение; это не неверное действие,
// но и не «верно», поэтому такие фразы нужно прогнать ещё раз по одной).
// Готово по плану, когда верно не меньше 18 из 20, а НЕВЕРНО — ни одной.
// Между фразами пауза 8,5 секунды: сама функция пускает не больше 8 запросов в минуту с одного адреса,
// у OpenRouter (модель по умолчанию) лимит 20 в минуту. Весь прогон ~3 минуты, 20 из 50 бесплатных запросов в сутки.
// Для Groq паузу нужно поднять до 20 секунд: там лимит 8000 токенов в минуту, а один запрос — около 2000.
const path = require('path'), fs = require('fs');
const dir = path.join(__dirname, '..');
global.window = {};
require(dir + '/js/config.js'); require(dir + '/js/data.js'); require(dir + '/js/changes.js');
const A = require(dir + '/js/assistant.js'), D = window.MILK_DATA;
const phrases = JSON.parse(fs.readFileSync(dir + '/tests/phrases.json', 'utf8')).phrases;
const url = window.MILK_CONFIG.supabaseUrl + '/functions/v1/assistant', key = window.MILK_CONFIG.supabaseKey;
const wait = ms => new Promise(r => setTimeout(r, ms));

(async function () {
  let good = 0, asked = 0, wrong = 0, busy = 0;
  for (let n = 0; n < phrases.length; n++) {
    const p = phrases[n];
    const res = await A.ask(p.text, p.mode, D.vehicles, { url, key, fetch, timeoutMs: 15000 });
    let verdict, got = '';
    if (!res.ok) { verdict = 'СБОЙ: ' + res.message; busy++; }
    else {
      const r = A.resolve(res, { orders: D.orders, vehicles: D.vehicles }); let lines = r.rows.map(A.line);
      got = JSON.stringify(lines) + (r.questions.length ? ' вопросы: ' + JSON.stringify(r.questions) : '');
      // Несколько подходящих магазинов: сверяем, сколько их нашлось, а не слова модели («Щорса» и «магазин на Щорса» —
      // одни и те же 5 магазинов; 16 ноября проверка из-за этого записала верный ответ в «неверно»).
      const same = l => l.replace(/\[выбрать из (\d+): [^\]]*\]/, '[выбрать из $1]');
      lines = lines.map(same); p.expect = p.expect.map(same);
      if (JSON.stringify(lines) === JSON.stringify(p.expect) && (!p.ask || r.questions.length)) { verdict = 'верно'; good++; }
      // «Вопрос» — модель не сделала ни одного неверного действия, но чего-то не поняла и спросила
      // (по плану этапа 2 это допустимо: «остальные заканчиваются вопросом, а не неверным действием»).
      else if (r.questions.length && lines.every(l => p.expect.indexOf(l) >= 0)) { verdict = 'вопрос'; asked++; }
      else { verdict = 'НЕВЕРНО, ждали ' + JSON.stringify(p.expect); wrong++; }
    }
    console.log((n + 1) + '. ' + p.text + '\n   ' + verdict + (got ? '\n   получено: ' + got : ''));
    if (n < phrases.length - 1) await wait(8500);
  }
  console.log('\nИтог: верно ' + good + ' из 20, вопрос вместо действия ' + asked + ', неверно ' + wrong + ', сбой поставщика ' + busy + '.');
  console.log(good >= 18 && !wrong ? 'Готово по плану этапа 2.' : 'Пока не готово: нужно не меньше 18 верных и ни одного неверного.');
  process.exit(good >= 18 && !wrong ? 0 : 1);
})();
