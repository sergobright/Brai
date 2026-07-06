# Inbound API

Внутренняя справочная страница по универсальному внешнему inbound API Brai.
Здесь описан контракт, по которому сторонние приложения отправляют данные в
Brai.

Не записывай сюда реальные токены, пароли, приватные URL, дампы runtime БД или
пользовательские payload-ы.

## Текущий контракт

Brai использует короткий inbound endpoint:

```text
/v1/
```

Если request не указывает точку назначения, API использует `inbox`. Явная точка
назначения передается в JSON body через `target`/`destination` или в header
`X-Brai-Target`/`X-Brai-Destination`.

Сейчас поддерживается:

| Target | Статус | Назначение |
| --- | --- | --- |
| `inbox` | Активен | Создать Inbox-запись из внешнего текста, описания, metadata и вложений. |

Будущие target-ы, например `finance` или `calendar`, добавляются как новые
agents за тем же коротким endpoint. Не заводи для них новую top-level группу
routes.

## URL

Внутри Node-сервиса основной маршрут всегда `/v1/`.

| Окружение | Внешний URL |
| --- | --- |
| Production | `https://api.brightos.world/v1/` |
| Preview | `https://<slot>.test.brightos.world/api/v1/` |

В preview сегмент `/api` нужен только из-за Caddy: он проксирует
`/api/*` в API service и срезает `/api` перед Node-сервисом.

Старые inbound routes `/v1/in` и `/v1/in/:target` не поддерживаются.

## Встроенный Android Brai Cmd

Android-приложение Brai Cmd не использует внешний `X-Brai-API-Key` и не хранит
inbound secret в APK. Оно отправляет команды во входящие через внутренний route:

```text
POST /v1/brai-cmd/inbox
Authorization: Bearer <device access token>
X-Brai-Cmd-Device-Id: <install id>
```

Payload использует тот же Inbox mapping, что внешний `POST /v1/`: `text`,
`description_json`, `attachments[]`, `source`, `source_key`,
`idempotency_key`. Сервер принудительно маршрутизирует этот route в target
`inbox`.

## Авторизация

Все inbound-запросы требуют:

```http
X-Brai-API-Key: <BRAI_INBOUND_API_KEY>
```

Значение API-ключа живет в env как `BRAI_INBOUND_API_KEY`. Legacy env
`BRAI_INBOUND_TOKEN` и legacy `Authorization: Bearer <key>` пока
принимаются для обратной совместимости. Новый caller должен использовать
`X-Brai-API-Key`. Не коммить значение и не пиши его в документации.

Неверная или отсутствующая inbound-авторизация возвращает HTTP `401`:

```json
{ "error": "unauthorized" }
```

## Handshake

Стороннее приложение проверяет соединение через `GET` на тот же URL, куда потом
будет слать данные.

```http
GET /v1/
X-Brai-API-Key: <api-key>
```

Успех:

```json
{
  "ok": true,
  "target": "inbox"
}
```

Неизвестный target возвращает HTTP `404`:

```json
{ "error": "unsupported_target" }
```

Можно проверить будущий target через header:

```http
GET /v1/
X-Brai-API-Key: <api-key>
X-Brai-Target: finance
```

## Прием Inbox

`POST /v1/` принимает JSON. Если `target`/`destination` не указан, payload
попадает в `inbox`.

Минимальный payload:

```json
{
  "text": "текст пояснения"
}
```

Полный payload:

```json
{
  "target": "inbox",
  "text": "текст пояснения",
  "description": {
    "kind": "optional structured content"
  },
  "attachments": [
    {
      "base64": "base64-file-body",
      "mime": "application/pdf",
      "name": "optional-source-name.pdf"
    }
  ],
  "source": "optional source label",
  "source_key": "optional-source-key",
  "response_required": false,
  "record_type_id": 1,
  "idempotency_key": "optional-stable-key"
}
```

Успех создает или переиспользует Inbox-запись:

```json
{
  "ok": true,
  "target": "inbox",
  "inbox_id": "inbound:inbox:...",
  "created": true,
  "attachment_links": [
    "/v1/inbox/attachments/..."
  ],
  "state": {}
}
```

`created` будет `false`, если такой `idempotency_key` уже был обработан.

## Маппинг полей

| Payload field | Обязательное | Где хранится | Примечание |
| --- | --- | --- | --- |
| `target` | Нет | routing | Точка назначения. Default: `inbox`. |
| `destination` | Нет | routing | Алиас для `target`. |
| `text` | Да | `inbox.explanation_text` | Также используется для генерации заголовка и поиска фразы про предыдущее сообщение. |
| `description_text` | Нет | `inbox.description_text` | Строковое описание. |
| `description` | Нет | `inbox.description_text` | Строка сохраняется как trimmed text; object/array сохраняется как pretty JSON. |
| `content_text` | Нет | `inbox.description_text` | Алиас для текстового содержания. |
| `description_json` | Нет | `inbox.description_text` | Алиас для structured content; сохраняется как pretty JSON. |
| `content` | Нет | `inbox.description_text` | Алиас для structured content; сохраняется как pretty JSON. |
| `attachments[]` | Нет | `inbox.attachment_links_json` и файл в storage | Предпочтительный формат вложений. |
| `image_base64`, `image_mime` | Нет | `inbox.attachment_links_json` и файл в storage | Legacy-формат одной картинки. |
| `source` | Нет | `inbox.source` | Default: `inbound`. |
| `source_key` | Нет | `inbox.source_key` | Стабильный внешний ключ источника; используется для поиска предыдущей Inbox-записи. |
| `response_required` | Нет | `inbox.response_required` | Boolean-флаг для будущей маршрутизации ответа. |
| `record_type_id` | Нет | `inbox.record_type_id` | Inbound API принимает только `1` или `2`; default `1`. |
| `record_type` | Нет | `inbox.record_type_id` | Числовой алиас для `record_type_id`. |
| `idempotency_key` | Нет | seed для Inbox id/event id | Повторный ключ переиспользует существующую Inbox-запись. |

## Вложения

Предпочтительный формат:

```json
{
  "attachments": [
    {
      "base64": "base64-file-body",
      "mime": "image/png",
      "name": "optional-name.png"
    }
  ]
}
```

Допустимые алиасы внутри attachment object:

| Каноническое поле | Алиасы |
| --- | --- |
| `base64` | `file_base64`, `data_base64` |
| `mime` | `file_mime`, `image_mime` |

Текущая реализация не использует `name` для имени сохраненного файла. Имя
генерируется безопасно, расширение берется из MIME.

Принимаемые MIME-типы:

| Тип | MIME | Проверка |
| --- | --- | --- |
| PNG image | `image/png` | PNG signature |
| JPEG image | `image/jpeg` | JPEG signature |
| WebP image | `image/webp` | RIFF/WEBP signature |
| GIF image | `image/gif` | GIF87a/GIF89a signature |
| PDF | `application/pdf` | `%PDF-` signature |
| Plain text | `text/plain` | UTF-8 text, без NUL bytes |
| Markdown | `text/markdown` | UTF-8 text, без NUL bytes |
| CSV | `text/csv` | UTF-8 text, без NUL bytes |
| JSON file | `application/json` | Валидный UTF-8 JSON |
| Word document | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | ZIP container signature |
| Excel workbook | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` | ZIP container signature |
| PowerPoint deck | `application/vnd.openxmlformats-officedocument.presentationml.presentation` | ZIP container signature |

По умолчанию не принимаем: SVG, произвольный binary
`application/octet-stream`, архивы, executable-файлы и multipart uploads.

Текущие лимиты:

| Лимит | Значение |
| --- | --- |
| HTTP JSON body | 16 MB |
| Вложений на запрос | 10 |
| Decoded size одного вложения | 8 MB |
| Суммарный decoded size вложений | 12 MB |

Attachment links сохраняются как `/v1/inbox/attachments/<file>`. Файлы лежат в
storage root окружения из `BRAI_INBOUND_STORAGE_ROOT`.

Для image-вложений сервер пытается сразу создать уменьшенную копию
`/v1/inbox/attachments/<file>.thumb.jpg` размером до `640px` по большей стороне.
`attachment_links` по-прежнему содержит только оригиналы; UI строит preview URL
детерминированно. Preview доступен только если текущий пользователь имеет доступ
к оригинальному вложению.

## Типы записей

Типы записей зарегистрированы в `inbox_record_types`.

| ID | Key | Title | Поведение API |
| --- | --- | --- | --- |
| 1 | `api_human_inbound` | `Входящее от человека по API` | Default для inbound API. |
| 2 | `api_agent_inbound` | `Входящее от агента по API` | Допустимо, если caller отправляет `record_type_id: 2`. |
| 3 | `internal_agent_inbound` | `Внутреннее входящее от агента` | Зарезервировано для внутренних агентов, внешний inbound API не принимает. |
| 4 | `interface_human_created` | `Человек добавил из интерфейса` | Default для Inbox-записей из UI, внешний inbound API не принимает. |

External inbound API принимает только `1` или `2`. Остальные значения дают HTTP
`400` и `invalid_record_type`.

## Связь с предыдущим сообщением

Inbound Inbox handler всегда создает новую Inbox-запись. Если `text` или
description просит прикрепить или добавить данные к предыдущему сообщению,
новая строка получает ссылку в `inbox.related_inbox_id`.

Текущая эвристика:

- маркер предыдущего сообщения: `предыдущ`, `прошл`, `previous` или `last`;
- маркер прикрепления: `прикреп`, `добав`, `attach` или `append`;
- порядок поиска: последняя Inbox-запись с тем же `source_key`; если его нет,
  последняя с тем же `source`; иначе последняя Inbox-запись глобально.

Это намеренно простой механизм. Менять его стоит только при реальной
необходимости в более строгом parser-е команд.

## Генерация заголовка

AI-агент генерирует `inbox.title` из `text`.

Текущий LLM-агент зарегистрирован в SQLite `agents`:

| Поле | Значение |
| --- | --- |
| `id` | `inbound.inbox.title_generator` |
| `target` | `inbox` |
| `kind` | `inbound_llm_title_generator` |
| `source_module` | `services/brai_api/src/inbound.js` |

В этой строке хранятся описание, условия срабатывания/пропуска,
взаимодействия, side effects, `llm_provider`, `llm_model`,
`llm_prompt_template`, `llm_timeout_ms` и fallback behavior.

Runtime-настройки:

| Env | Назначение |
| --- | --- |
| `BRAI_CODEX_BIN` | Путь к Codex CLI. |
| `BRAI_CODEX_MODEL` | Runtime override модели Codex CLI; если не задан, используется `agents.llm_model`. |
| `BRAI_CODEX_TIMEOUT_MS` | Runtime override timeout генерации заголовка; если не задан, используется `agents.llm_timeout_ms`. |

Prompt хранится в `agents.llm_prompt_template`; `{{text}}` заменяется на
входной `text`. Текущий template:

```text
Сгенерируй короткий русский заголовок для входящего сообщения.
Верни только заголовок, без Markdown, кавычек и пояснений.

<text>
```

Если Codex CLI падает или выходит по timeout, fallback-заголовок берется из
первых семи слов `text`, чистится и режется до 80 символов. Если он пустой,
используется `Входящее`.

Каждое фактическое срабатывание генератора пишет ровно одну строку в
`ai_logs`: `agent_id = inbound.inbox.title_generator`, `agent_version` из
`agents.version`, `status = done` или `failed`, короткий русский
`ai_title`, и `json_data` стандарта `brai.ai_log.v1` с refs
`request.body.text`, `inbox.id` и `inbox.title`. Duplicate idempotency key не
создает вторую строку, потому генератор не запускается.

## Ошибки

| HTTP | Error | Значение |
| --- | --- | --- |
| 400 | `text_required` | Нет обязательного `text` или он пустой. |
| 400 | `invalid_attachments` | `attachments` передан, но это не array. |
| 400 | `unsupported_attachment_mime` | MIME не входит в список принимаемых. |
| 400 | `invalid_attachment` | Base64, signature, UTF-8 или JSON validation не прошли. |
| 400 | `invalid_image_mime` | Legacy `image_mime` отсутствует или не поддерживается. |
| 400 | `invalid_image` | Legacy image base64 или image signature не прошли validation. |
| 400 | `invalid_response_required` | `response_required` не boolean-like. |
| 400 | `invalid_record_type` | Inbound API получил record type не `1` и не `2`. |
| 400 | `invalid_target` | `target`/`destination` передан не строкой или содержит `/`. |
| 401 | `unauthorized` | Нет inbound API key или он неверный. |
| 404 | `unsupported_target` | Route target не зарегистрирован. |
| 405 | `method_not_allowed` | Method не `GET` и не `POST`. |
| 413 | `attachment_too_large` | Одно non-legacy вложение больше 8 MB decoded. |
| 413 | `image_too_large` | Legacy image больше 8 MB decoded. |
| 413 | `attachments_too_large` | Суммарный decoded size вложений больше 12 MB. |

## Правила изменения

При изменении этого API contract обновляй эту страницу в том же commit.

При создании или изменении inbound/runtime AI-агента обязательно обновляй
соответствующую строку SQLite `agents` в миграции/seed-коде.

Обновляй релевантный раздел, если меняется что-то из этого:

- route shape, target/destination name, environment URL, Caddy path behavior или auth;
- request payload fields, aliases, defaults, limits или validation rules;
- accepted MIME types, file storage path, attachment link format или file serving;
- response payload, status code или error string;
- DB field mapping, Inbox record type behavior, idempotency или previous-message linking;
- title-generation prompt, model setting, timeout behavior или fallback behavior;
- OpenSpec requirement, API tests, migration behavior или client projection behavior.

Минимальные companion updates для API contract changes:

1. Обновить OpenSpec requirements, если меняется поведение.
2. Обновить или добавить API tests, которые сломаются при регрессе документированного поведения.
3. Обновить `docs/checklists/CHECKLIST_API_OR_MIGRATION.md`, только если меняется процесс.
4. Запустить `npm --prefix services/brai_api test`.
5. Запустить `npm run openspec:validate`, если менялись OpenSpec files.
