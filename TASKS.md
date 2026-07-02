# TASKS.md

Журнал агентских задач перенесен в server SQLite `activities`.

Новые агентские записи нужно создавать в `activities` с `activity_type_id = 'operation'`, `author = 'Codex'` и заполненным `reason`. Пользовательские записи остаются `activity_type_id = 'action'`.

Текущие записи из этого файла перенесены миграцией `42`.
