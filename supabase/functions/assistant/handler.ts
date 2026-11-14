// СЕРВЕРНАЯ ФУНКЦИЯ «КОМАНДА СЛОВАМИ» (Supabase Edge Function, этап 2): вся логика. Запуск — index.ts рядом.
// Экран диспетчера присылает фразу логиста → функция спрашивает языковую модель → проверяет её ответ → отдаёт
// список действий и вопросы. Ключ модели лежит здесь, в секретах Supabase, и никогда не попадает на сайт (решение 8).
//
// Поставщик модели заменяемый: подходит любой с «OpenAI-совместимым» адресом (Groq, OpenRouter, Cloudflare,
// Mistral, OpenAI…). Меняется тремя секретами, код трогать не нужно:
//   MODEL_API_KEY — ключ (обязательно);
//   MODEL_API_URL — адрес, по умолчанию Groq (бесплатно, без банковской карты, 1000 запросов в сутки, отвечает за 1–2 секунды);
//   MODEL_NAME    — название модели, по умолчанию openai/gpt-oss-120b (хорошо понимает русский и умеет отвечать строгим JSON).
// Запасной вариант без карты — OpenRouter: MODEL_API_URL = https://openrouter.ai/api/v1/chat/completions,
// MODEL_NAME — любая модель с «:free» в названии (50 запросов в сутки).
//
// Защита лимита: фраза не длиннее 500 знаков; не больше 8 запросов в минуту с одного адреса и 300 в сутки всего;
// одинаковые фразы отвечаются из памяти без запроса к модели. Память живёт, пока жив экземпляр функции
// (Supabase перезапускает их сам), для показа на хакатоне этого достаточно.
import { messages, normalize, MAX_TEXT } from './understand.mjs';

const DEFAULT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'openai/gpt-oss-120b';
const MODEL_TIMEOUT_MS = 7000;           // экран ждёт 8 секунд; модели даём 7, чтобы успеть ответить «не успела»
const PER_MINUTE = 8, PER_DAY = 300, CACHE_SIZE = 300;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });
}

type Deps = { env: (k: string) => string | undefined; fetch: typeof fetch; now: () => number };

// Состояние в памяти: счётчики запросов и ответы на одинаковые фразы.
export function makeHandler(deps: Deps) {
  const hits = new Map<string, number[]>();
  let day = { start: 0, count: 0 };
  const cache = new Map<string, unknown>();

  function limited(ip: string) {
    const t = deps.now();
    if (t - day.start > 86400000) day = { start: t, count: 0 };
    const list = (hits.get(ip) || []).filter((x) => t - x < 60000);
    if (list.length >= PER_MINUTE) return 'Слишком много запросов подряд. Подождите минуту или заполните строки вручную.';
    if (day.count >= PER_DAY) return 'Дневной лимит запросов к модели исчерпан. Заполните строки вручную.';
    list.push(t); hits.set(ip, list); day.count++;
    if (hits.size > 1000) hits.clear();
    return '';
  }

  return async function handle(req: Request): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    if (req.method !== 'POST') return reply(405, { ok: false, error: 'method', message: 'Нужен POST.' });
    let body: any;
    try { body = await req.json(); } catch { return reply(400, { ok: false, error: 'bad_request', message: 'Запрос не прочитан.' }); }
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    const mode = body?.mode === 'live' ? 'live' : 'plan';
    const vehicles = Array.isArray(body?.vehicles) ? body.vehicles.slice(0, 100)
      .filter((v: any) => v && Number.isFinite(Number(v.id))).map((v: any) => ({ id: Number(v.id), active: v.active !== false })) : [];
    if (!text) return reply(400, { ok: false, error: 'empty', message: 'Фраза пустая.' });
    if (text.length > MAX_TEXT) return reply(400, { ok: false, error: 'too_long', message: 'Фраза длиннее ' + MAX_TEXT + ' знаков. Напишите короче, одним-двумя предложениями.' });

    const key = mode + '|' + vehicles.map((v: any) => v.id + (v.active ? '' : '-')).join(',') + '|' + text.toLowerCase().replace(/\s+/g, ' ');
    if (cache.has(key)) return reply(200, { ok: true, cached: true, ...(cache.get(key) as object) });

    const apiKey = deps.env('MODEL_API_KEY');
    if (!apiKey) return reply(503, { ok: false, error: 'no_key', message: 'Модель не подключена: нет ключа в секретах Supabase. Заполните строки вручную.' });
    const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
    const limit = limited(ip);
    if (limit) return reply(429, { ok: false, error: 'limit', message: limit });

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), MODEL_TIMEOUT_MS);
    let content = '';
    try {
      const model = deps.env('MODEL_NAME') || DEFAULT_MODEL;
      const ask: Record<string, unknown> = { model, messages: messages(mode, vehicles, text), temperature: 0, response_format: { type: 'json_object' } };
      // gpt-oss «рассуждает» перед ответом; для перевода фразы в список хватает короткого рассуждения: быстрее и меньше расход лимита.
      if (model.indexOf('gpt-oss') >= 0) ask.reasoning_effort = 'low';
      const res = await deps.fetch(deps.env('MODEL_API_URL') || DEFAULT_URL, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        body: JSON.stringify(ask)
      });
      if (!res.ok) {
        const limitHit = res.status === 429;
        return reply(502, { ok: false, error: limitHit ? 'limit' : 'model',
          message: limitHit ? 'Лимит модели у поставщика исчерпан. Заполните строки вручную.' : 'Модель ответила ошибкой (' + res.status + '). Заполните строки вручную.' });
      }
      const data = await res.json();
      content = data?.choices?.[0]?.message?.content || '';
    } catch (e) {
      const slow = (e as Error)?.name === 'AbortError';
      return reply(504, { ok: false, error: slow ? 'timeout' : 'model',
        message: slow ? 'Модель не ответила вовремя. Заполните строки вручную.' : 'Модель недоступна. Заполните строки вручную.' });
    } finally { clearTimeout(timer); }

    const result = normalize(content, mode, vehicles);
    if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value as string);
    cache.set(key, result);
    return reply(200, { ok: true, cached: false, ...result });
  };
}
