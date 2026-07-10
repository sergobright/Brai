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
| `idempotency_key` | `inbox.ingest_idempotency_hash` | Для одного владельца тот же key + тот же payload возвращает существующую запись; другой payload получает `409`. Исходный key не хранится. |

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

После создания записи server создаёт raw Inbox role row без `item_roles_id`, первый event без role link и запускает environment-local Temporal workflow `InboxNormalizationWorkflow`:

1. `ingest` сохраняет raw row, initial event, compact log и `workflow_executions` row; `items`/`item_roles` ещё не создаются.
2. `raw_normalizer` при необходимости вызывает `inbox.image_describer`, затем вызывает `inbox.normalizer`. Агенты возвращают данные activity-коду и не мутируют domain tables.
3. JSON normalizer валидируется. Schema errors получают до трёх реальных AI executions с контекстом предыдущей ошибки; каждый call пишет отдельный `ai_logs`.
4. `apply_normalized_raw` в одной idempotent transaction создаёт `items`, `item_roles`, обновляет Inbox, связывает с `item_roles_id` все принятые raw events (включая initial event), пишет replay-safe final domain event/log и завершает workflow read model.

DB/business errors останавливают workflow без повторного LLM call. Product UI читает compact status из `workflow_executions`; детали доступны через `GET /v1/inbox/<inbox-id>/workflow`.
Если API перезапустился между raw ingest и Temporal start, startup reconciliation повторно запускает оставшиеся `queued` executions по тому же stable workflow id.

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

Optional model для второй/третьей validation-попытки:

```env
BRAI_CODEX_FALLBACK_MODEL=gpt-5
```

Локальной эвристической нормализации нет. После трёх schema-validation failures запись остаётся raw, workflow получает `needs_review`; execution/business failure получает `failed`. `/v1/inbox` отдаёт `AI-working`, `failed` или `needs_review` state из database read model.

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
| 409 | `idempotency_conflict` | Тот же `idempotency_key` повторён с другим payload. |
| 413 | `request_too_large` / `attachment_too_large` / `attachments_too_large` | Превышены лимиты. |
