# Опциональный режим Ponytail

## Назначение

Этот guideline нужен только когда владелец проекта явно просит использовать Ponytail или один из его review skills.

## Режим по умолчанию: выключен

Ponytail не используется по умолчанию для software development, debugging, refactoring, code review или implementation work в этом workspace. Включать Ponytail и его review skills можно только по явному запросу владельца проекта.

Правила ниже описывают поведение явно включённого Ponytail и не применяются к обычной разработке.

Ponytail не означает "сделать хуже". Он означает:

- меньше нового кода;
- меньше файлов;
- меньше зависимостей;
- меньше speculative abstractions;
- boring code вместо clever code;
- deletion over addition.

## Лестница Ponytail

Перед добавлением кода проверь:

1. Нужно ли это вообще?
2. Покрывает ли это стандартная библиотека?
3. Покрывает ли это платформа нативно?
4. Покрывает ли это already-installed dependency?
5. Можно ли это сделать одной строкой?
6. Только потом пиши минимальный новый код.

## Что запрещено

- Interface с одной implementation.
- Factory для одного продукта.
- Config для значения, которое не меняется.
- Boilerplate "на будущее".
- Новый dependency для задачи, которую закрывают несколько строк или existing dependency.
- Широкий rewrite вместо точечного изменения.

## Что предпочитать

- Удаление перед добавлением.
- Boring code перед clever code.
- Fewest files possible.
- Existing project patterns перед новым стилем.
- Проверку, которая ломается при реальном regression, а не большой suite ради вида.

## Разметка и логика

- TSX/JSX файлы держат разметку и простую UI-связку: props, локальный UI state, handlers и conditional rendering.
- Нетривиальную бизнес-логику выноси из TSX/JSX в `*.model.ts`, shared helper или hook.
- К выносимой логике относятся data transforms, storage/API side effects, autosave/sync, сортировка/группировка доменных данных и расчёты view-model.
- Не выноси микроскопический UI glue ради формы: если код понятнее внутри компонента и не содержит доменного решения, оставь его на месте.

## Лимиты размера файлов

- Source/test файлы держи до 500 строк.
- Instruction/rule/guideline файлы держи до 100 строк.
- Если файл превышает лимит, раздели по существующей ответственности, а не создавай абстракцию ради абстракции.
- Исключения допустимы только для generated/vendor/binary artifacts или явно обоснованного blocker; зафиксируй причину рядом с изменением.

## Где Ponytail не применяется как упрощение

Нельзя упрощать:

- trust-boundary validation;
- error handling, предотвращающий потерю данных;
- security;
- accessibility basics;
- Android/native rollback and update safety;
- аппаратную/реальную калибровку;
- явно запрошенную full implementation.

## Проверка

Нетривиальная logic change оставляет одну runnable проверку: existing test, targeted test или минимальный self-check. Тривиальные one-liners не требуют теста.

## Документирование упрощений

Если оставлен deliberate shortcut с известным ceiling, пометь его коротким `ponytail:` comment и назови upgrade path.

Пример:

```ts
// ponytail: linear scan is fine for local settings; index if this grows past one screen.
```
