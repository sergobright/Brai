"use client";

/** Keeps failed Dexie migrations visibly blocked without deleting old data. */
export function LocalDatabaseBlockedScreen() {
  return (
    <main className="grid min-h-dvh place-items-center bg-background p-6" data-local-database-blocked>
      <section className="max-w-md rounded-xl border border-border bg-card p-5 text-center" role="alert">
        <h1 className="m-0 text-lg font-semibold">Локальные данные временно недоступны</h1>
        <p className="mb-4 mt-2 text-sm text-muted-foreground">
          Brai сохранил прежний кэш и несинхронизированные изменения. Повторите безопасное обновление базы.
        </p>
        <button
          type="button"
          className="min-h-11 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          onClick={() => window.location.reload()}
        >
          Повторить
        </button>
      </section>
    </main>
  );
}
