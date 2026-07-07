# Inbox API

Внутренняя справочная страница по внешней записи в Brai Inbox и доставке из Brai CMD.

## Routes

### `GET /v1/`

Проверка доступа к короткому Inbox endpoint.

Headers:

```http
X-Brai-API-Key: <BRAI_INBOX_API_KEY>
```

Response:

```json
{ "ok": true, "target": "inbox" }
```

### `POST /v1/`

Создаёт Inbox-запись. Запись сначала сохраняется и возвращается в `state`, затем AI-обработка запускается фоном.

Минимальный payload:

```json
{
  "text": "разбери экран"
}
```

Основные поля:

| Payload | DB field | Notes |
| --- | --- | --- |
| `text` | `inbox.explanation_text` | Сырой текст запроса. Для Brai CMD это транскрипт. |
| `description`, `description_text`, `content`, `description_json` | `inbox.description_text` | Текстовый контекст до AI-нормализации. |
| `source` | `inbox.source` | Default: `inbox`; Brai CMD ставит `brai-cmd`. |
| `source_key` | `inbox.source_key` | Стабильный ключ источника/устройства. |
| `response_required` | `inbox.response_required` | Boolean. |
| `record_type_id` | `inbox.record_type_id` | Внешний API принимает только `1` или `2`; default `1`. |
| `attachments[]` | `inbox.attachment_links_json` | Whitelisted MIME attachments, включая изображения. |
| `idempotency_key` | `inbox_events.event_id` | Повторный запрос не создаёт дубль. |

Legacy image shortcut всё ещё поддерживается для Android compatibility:

```json
{
  "text": "сохрани скрин",
  "image_base64": "<base64>",
  "image_mime": "image/png"
}
```

### `POST /v1/brai-cmd/inbox`

Внутренний route для Android Brai CMD. Авторизация идёт через Brai CMD access token, а payload затем проходит тот же Inbox creation path.

Brai CMD отправляет:

| Payload | DB field |
| --- | --- |
| `text` | `inbox.explanation_text` |
| `description_json` | `inbox.description_text` |
| `attachments[]` | `inbox.attachment_links_json` |
| `idempotency_key` | stable Inbox event id |

## Processing

После создания записи server schedules Inbox AI processing:

1. `inbox.image_describer` смотрит image attachments и пишет описание картинки в `normalization_text` через `normalize` event.
2. `inbox.normalizer` сопоставляет `explanation_text`, `description_text` и описание картинки, затем пишет:
   - `title`
   - `description_text`
   - `preliminary_section`
   - `normalization_text`
   - `is_normalized = 1`

`explanation_text` не перезаписывается: это source transcript/raw request.

Если `inbox.normalizer` возвращает class key, которого нет в `inbox_classes`, server добавляет строку со статусом `candidate`.

## Auth And Storage

External Inbox API key:

```env
BRAI_INBOX_API_KEY=...
```

Attachment storage root:

```env
BRAI_INBOX_STORAGE_ROOT=/srv/projects/brai/data/inbox-attachments
```

Optional Codex model retry:

```env
BRAI_CODEX_FALLBACK_MODEL=gpt-5
```

Если основная модель не вернула валидный результат, server может один раз повторить запрос другой моделью. Локальной эвристической нормализации нет: при ошибке запись остаётся `is_normalized = false`, ошибка видна в `ai_logs`, а `/v1/inbox` отдаёт `ai_processing_status = "failed"` и короткое `ai_processing_error` для ленты Inbox.

Attachments доступны через:

```text
/v1/inbox/attachments/<file>
```

Для чтения attachment нужен обычный app auth/session, а scoped user может читать только файлы, связанные с его Inbox rows.

## AI Logs

Factory читает runtime logs через:

```http
GET /v1/ai-logs
```

Новые Inbox processing logs пишутся в `ai_logs` с agent ids:

```text
inbox.image_describer
inbox.normalizer
```

## Record Types

| ID | Key | Meaning |
| --- | --- | --- |
| 1 | `api_human_inbox` | Входящее от человека по API. |
| 2 | `api_agent_inbox` | Входящее от агента по API. |
| 3 | `internal_agent_inbox` | Внутреннее входящее от агента. |
| 4 | `interface_human_created` | Человек добавил из интерфейса. |

## Errors

| Status | Error | Meaning |
| --- | --- | --- |
| 400 | `text_required` | Нет `text`. |
| 400 | `invalid_record_type` | API получил record type не `1` и не `2`. |
| 400 | `unsupported_attachment_mime` | MIME attachment не разрешён. |
| 400 | `invalid_attachment` / `invalid_image` | Base64 или bytes не проходят проверку. |
| 401 | `unauthorized` | Нет Inbox API key или он неверный. |
| 413 | `request_too_large` / `attachment_too_large` / `attachments_too_large` | Превышены лимиты. |
