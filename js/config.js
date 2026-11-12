// ПОДКЛЮЧЕНИЕ К БАЗЕ (Supabase).
// Этот ключ «публичный» по задумке Supabase: его можно держать в коде сайта.
// Что можно делать с ним, решают правила доступа в самой базе (RLS):
// читать и править демо-данные можно, удалять нельзя.
window.MILK_CONFIG = {
  supabaseUrl: 'https://mhdulbsrtmcdxrzeamqk.supabase.co',
  supabaseKey: 'sb_publishable_UkYV8ewwGWsOVZb2sjn5_Q_kADDBAGq'
};
