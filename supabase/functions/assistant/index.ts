// Точка входа серверной функции «assistant». Вся логика — в handler.ts, правила для модели — в understand.mjs.
// Разделено, чтобы проверка tests/check-function.ts могла вызвать обработчик без запуска сервера.
import { makeHandler } from './handler.ts';

Deno.serve(makeHandler({ env: (k) => Deno.env.get(k), fetch: fetch, now: () => Date.now() }));
