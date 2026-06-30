"use client";

import { Fragment, type MouseEvent, useEffect, useMemo, useState } from "react";
import { AlarmClock, Check, Minus, Pencil, Plus, SquareTerminal, Timer, Trash2, X } from "lucide-react";
import type { FocusSessionInterval, TimerSession } from "@/shared/types/timer";
import { formatHourMinute, moscowTime } from "@/shared/time/format";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { CardFrame } from "@/shared/ui/card";
import { Input } from "@/shared/ui/input";
import { Table, TableBody, TableCell, TableRow } from "@/shared/ui/table";
import { cx } from "../../appUtils";
import {
  applyFocusInput,
  applyFocusStep,
  canonicalSessionId,
  createFocusEditDraft,
  createFocusIntervalEditDraft,
  draftChanged,
  draftUtcRange,
  formatDurationInput,
  formatTimeInput,
  hasFocusOverlap,
  normalizedInputValue,
  type FocusEditDraft,
  type FocusEditField,
} from "./focusHistoryEditModel";
import { focusHistoryRows, type FocusHistoryRow } from "./focusHistoryModel";

type WarningState = { rowId: string; message: string };
type IntervalRangeEdit = { intervalId: string; sessionId: string; startedAtUtc: string; endedAtUtc: string };

const OVERLAP_WARNING = "Нельзя наложить на соседний фокус";
const FIELD_LABELS: Record<FocusEditField, string> = {
  start: "Старт",
  duration: "Итого",
  end: "Финиш",
};

export function FocusHistoryTable({
  allSessions,
  sessions,
  onDeleteSession,
  onEditInterval,
  onEditSession,
}: {
  allSessions: TimerSession[];
  sessions: TimerSession[];
  onDeleteSession?: (sessionId: string) => void | Promise<void>;
  onEditInterval?: (intervalId: string, sessionId: string, startedAtUtc: string, endedAtUtc: string) => void | Promise<void>;
  onEditSession?: (sessionId: string, startedAtUtc: string, endedAtUtc: string) => void | Promise<void>;
}) {
  const rows = useMemo<FocusHistoryRow[]>(() => focusHistoryRows(sessions), [sessions]);
  const displaySessions = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions]);
  const canonicalSessions = useMemo(
    () => new Map(allSessions.map((session) => [canonicalSessionId(session), session])),
    [allSessions],
  );
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const [draft, setDraft] = useState<FocusEditDraft | null>(null);
  const [editingField, setEditingField] = useState<FocusEditField | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [warning, setWarning] = useState<WarningState | null>(null);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(() => new Set());
  const [confirmDeleteRowId, setConfirmDeleteRowId] = useState<string | null>(null);

  async function openRow(row: FocusHistoryRow) {
    if (activeRowId === row.id) return;
    if (row.intervals.length > 1) {
      setExpandedRows((current) => toggleSetValue(current, row.id));
      return;
    }
    if (!(await saveActiveDraft({ close: false }))) return;
    const session = canonicalSessions.get(row.sessionId) ?? displaySessions.get(row.id);
    if (!session?.ended_at_utc) return;
    const nextDraft = createFocusEditDraft(session);
    if (!nextDraft) return;
    setActiveRowId(row.id);
    setDraft(nextDraft);
    setEditingField(null);
  }

  async function openInterval(row: FocusHistoryRow, interval: FocusSessionInterval, event: MouseEvent) {
    event.stopPropagation();
    if (!interval.ended_at_utc || activeRowId === interval.id) return;
    if (!(await saveActiveDraft({ close: false }))) return;
    const nextDraft = createFocusIntervalEditDraft(interval);
    if (!nextDraft) return;
    setExpandedRows((current) => new Set(current).add(row.id));
    setActiveRowId(interval.id);
    setDraft(nextDraft);
    setEditingField(null);
  }

  async function saveActiveDraft({ close }: { close: boolean }) {
    if (!draft || !activeRowId) return true;
    if (hasFocusOverlap(draft, allSessions, ignoredIntervalIdsForDraft(draft))) {
      showOverlapWarning(activeRowId);
      return false;
    }
    if (draftChanged(draft) && draft.intervalId && onEditInterval) {
      const edits = intervalRangeEdits(draft);
      if (!edits) {
        showOverlapWarning(activeRowId);
        return false;
      }
      for (const edit of edits) {
        await onEditInterval(edit.intervalId, edit.sessionId, edit.startedAtUtc, edit.endedAtUtc);
      }
    } else if (draftChanged(draft) && onEditSession) {
      const range = draftUtcRange(draft);
      await onEditSession(draft.sessionId, range.startedAtUtc, range.endedAtUtc);
    }
    if (close) closeEditor();
    return true;
  }

  async function deleteRow(row: FocusHistoryRow, event: MouseEvent) {
    event.stopPropagation();
    closeEditor();
    await onDeleteSession?.(row.sessionId);
  }

  async function deleteMultiRow(row: FocusHistoryRow, event: MouseEvent) {
    event.stopPropagation();
    if (confirmDeleteRowId !== row.id) {
      setConfirmDeleteRowId(row.id);
      return;
    }
    setConfirmDeleteRowId(null);
    closeEditor();
    await onDeleteSession?.(row.sessionId);
  }

  function closeEditor() {
    setActiveRowId(null);
    setDraft(null);
    setEditingField(null);
    setInputValue("");
    setWarning(null);
  }

  useEffect(() => {
    if (!activeRowId || rows.some((row) => row.id === activeRowId || row.intervals.some((interval) => interval.id === activeRowId))) return;
    closeEditor();
  }, [activeRowId, rows]);

  useEffect(() => {
    if (!warning) return undefined;
    const timeout = window.setTimeout(() => setWarning(null), 3000);
    return () => window.clearTimeout(timeout);
  }, [warning]);

  function showOverlapWarning(rowId: string) {
    setWarning({ rowId, message: OVERLAP_WARNING });
  }

  function updateDraft(rowId: string, nextDraft: FocusEditDraft | null) {
    if (!nextDraft || hasFocusOverlap(nextDraft, allSessions, ignoredIntervalIdsForDraft(nextDraft)) || !intervalRangeEdits(nextDraft)) {
      showOverlapWarning(rowId);
      return;
    }
    setDraft(nextDraft);
  }

  function beginInput(field: FocusEditField) {
    if (!draft) return;
    setEditingField(field);
    setInputValue(field === "duration" ? formatDurationInput(draft.startMs, draft.endMs) : formatTimeInput(field === "start" ? draft.startMs : draft.endMs));
  }

  function commitInput(rowId: string) {
    if (!draft || !editingField) return;
    const nextDraft = applyFocusInput(draft, editingField, inputValue);
    if (!nextDraft) return;
    if (hasFocusOverlap(nextDraft, allSessions, ignoredIntervalIdsForDraft(nextDraft)) || !intervalRangeEdits(nextDraft)) {
      showOverlapWarning(rowId);
      return;
    }
    setDraft(nextDraft);
    setInputValue(normalizedInputValue(editingField, inputValue) ?? inputValue);
    setEditingField(null);
  }

  function activeIntervalRow(nextDraft: FocusEditDraft): FocusHistoryRow | null {
    if (!nextDraft.intervalId) return null;
    return rows.find((row) => row.intervals.some((interval) => interval.id === nextDraft.intervalId)) ?? null;
  }

  function ignoredIntervalIdsForDraft(nextDraft: FocusEditDraft): string[] {
    const row = activeIntervalRow(nextDraft);
    if (!row || !nextDraft.intervalId) return [];
    const index = row.intervals.findIndex((interval) => interval.id === nextDraft.intervalId);
    return [row.intervals[index - 1]?.id, row.intervals[index + 1]?.id].filter(Boolean) as string[];
  }

  function intervalRangeEdits(nextDraft: FocusEditDraft): IntervalRangeEdit[] | null {
    if (!nextDraft.intervalId) return [];
    const row = activeIntervalRow(nextDraft);
    if (!row) return null;
    const index = row.intervals.findIndex((interval) => interval.id === nextDraft.intervalId);
    const interval = row.intervals[index];
    if (!interval?.ended_at_utc) return null;
    const beforeSelected: IntervalRangeEdit[] = [];
    const afterSelected: IntervalRangeEdit[] = [];

    const previous = row.intervals[index - 1];
    const intervalStartMs = Date.parse(interval.started_at_utc);
    if (previous?.ended_at_utc && Number.isFinite(intervalStartMs) && nextDraft.startMs !== intervalStartMs) {
      const previousStartMs = Date.parse(previous.started_at_utc);
      if (!Number.isFinite(previousStartMs) || nextDraft.startMs <= previousStartMs) return null;
      const previousEdit = rangeEdit(previous.id, nextDraft.sessionId, previousStartMs, nextDraft.startMs);
      if (nextDraft.startMs < intervalStartMs) {
        beforeSelected.push(previousEdit);
      } else {
        afterSelected.push(previousEdit);
      }
    }

    const next = row.intervals[index + 1];
    const intervalEndMs = Date.parse(interval.ended_at_utc);
    if (next?.ended_at_utc && Number.isFinite(intervalEndMs) && nextDraft.endMs !== intervalEndMs) {
      const nextEndMs = Date.parse(next.ended_at_utc);
      if (!Number.isFinite(nextEndMs) || nextDraft.endMs >= nextEndMs) return null;
      const nextEdit = rangeEdit(next.id, nextDraft.sessionId, nextDraft.endMs, nextEndMs);
      if (nextDraft.endMs > intervalEndMs) {
        beforeSelected.push(nextEdit);
      } else {
        afterSelected.push(nextEdit);
      }
    }

    return [
      ...beforeSelected,
      rangeEdit(interval.id, nextDraft.sessionId, nextDraft.startMs, nextDraft.endMs),
      ...afterSelected,
    ];
  }

  function renderEditorRow(row: FocusHistoryRow, rowDraft: FocusEditDraft, warningRowId: string) {
    return (
      <TableRow>
        <TableCell className="!p-0 !ps-0 !pe-0" colSpan={3}>
          <div className="grid max-h-14 overflow-hidden opacity-100 transition-[max-height,opacity] duration-200 ease-out">
            <div className="grid h-14 w-full grid-cols-[minmax(0,1fr)_5rem] items-center gap-2 px-2 py-1.5" data-nav-swipe-exclusion>
              <div className="grid min-w-0 grid-cols-3 gap-1.5">
                <TimeEditor
                  changed={rowDraft.startMs !== rowDraft.originalStartMs}
                  editing={editingField === "start"}
                  field="start"
                  label={FIELD_LABELS.start}
                  inputValue={inputValue}
                  onBeginInput={beginInput}
                  onCancelInput={() => setEditingField(null)}
                  onCommitInput={() => commitInput(warningRowId)}
                  onInput={setInputValue}
                  onStep={(direction) => updateDraft(warningRowId, applyFocusStep(rowDraft, "start", direction))}
                  value={formatTimeInput(rowDraft.startMs)}
                />
                <TimeEditor
                  changed={(rowDraft.endMs - rowDraft.startMs) !== (rowDraft.originalEndMs - rowDraft.originalStartMs)}
                  editing={editingField === "duration"}
                  featured
                  field="duration"
                  label={FIELD_LABELS.duration}
                  inputValue={inputValue}
                  onBeginInput={beginInput}
                  onCancelInput={() => setEditingField(null)}
                  onCommitInput={() => commitInput(warningRowId)}
                  onInput={setInputValue}
                  onStep={(direction) => updateDraft(warningRowId, applyFocusStep(rowDraft, "duration", direction))}
                  value={formatDurationInput(rowDraft.startMs, rowDraft.endMs)}
                />
                <TimeEditor
                  changed={rowDraft.endMs !== rowDraft.originalEndMs}
                  editing={editingField === "end"}
                  field="end"
                  label={FIELD_LABELS.end}
                  inputValue={inputValue}
                  onBeginInput={beginInput}
                  onCancelInput={() => setEditingField(null)}
                  onCommitInput={() => commitInput(warningRowId)}
                  onInput={setInputValue}
                  onStep={(direction) => updateDraft(warningRowId, applyFocusStep(rowDraft, "end", direction))}
                  value={formatTimeInput(rowDraft.endMs)}
                />
              </div>
              <div className="flex h-10 items-center justify-end gap-0.5 border-l pl-1">
                <Button aria-label="Отменить редактирование фокуса" className="size-6 text-muted-foreground" onClick={(event) => {
                  event.stopPropagation();
                  closeEditor();
                }} size="icon-sm" type="button" variant="ghost">
                  <X className="size-3.5" aria-hidden="true" />
                </Button>
                <Button aria-label="Удалить запись фокуса" className="size-6 text-destructive" onClick={(event) => void deleteRow(row, event)} size="icon-sm" type="button" variant="ghost">
                  <Trash2 className="size-3.5" aria-hidden="true" />
                </Button>
                <Button aria-label="Закрыть редактирование фокуса" className="size-6 text-foreground" onClick={(event) => {
                  event.stopPropagation();
                  void saveActiveDraft({ close: true });
                }} size="icon-sm" type="button" variant="ghost">
                  <Check className="size-3.5" aria-hidden="true" />
                </Button>
              </div>
            </div>
          </div>
        </TableCell>
      </TableRow>
    );
  }

  return (
    <CardFrame className="w-full">
      <Table variant="card" className="table-fixed">
        <colgroup>
          <col style={{ width: "168px" }} />
          <col />
          <col style={{ width: "34px" }} />
        </colgroup>
        <TableBody>
          {rows.length ? (
            rows.map((row) => {
              const parentDraft = activeRowId === row.id ? draft : null;
              const activeIntervalId = row.intervals.some((interval) => interval.id === activeRowId) ? activeRowId : null;
              const warned = warning?.rowId === row.id || row.intervals.some((interval) => interval.id === warning?.rowId);
              const warningMessage = warned ? warning?.message : null;
              const expanded = expandedRows.has(row.id);
              const additionalActionCount = Math.max(0, row.actionIntervalCount - 1);
              const rowEditLabel = `Редактировать фокус: ${row.departureTime} - ${row.duration} - ${row.arrivalTime}`;
              const openCurrentRow = () => {
                if (!warned) void openRow(row);
              };
              return (
                <Fragment key={row.id}>
                  <TableRow
                    className={cx("h-12 cursor-pointer overflow-hidden transition-colors", warned && "cursor-default")}
                    data-state={parentDraft || activeIntervalId ? "selected" : undefined}
                    onClick={openCurrentRow}
                  >
                    {warned ? (
                      <TableCell className="h-12 p-0" colSpan={3}>
                        <div className="flex h-12 w-full items-center gap-2 bg-primary/80 px-2.5 font-medium text-primary-foreground">
                          <AlarmClock className="size-4 shrink-0" aria-hidden="true" />
                          <span className="min-w-0 truncate">{warningMessage}</span>
                        </div>
                      </TableCell>
                    ) : (
                      <>
                        <TableCell className="h-12 px-1.5 py-0">
                          <button
                            aria-label={rowEditLabel}
                            className="grid h-12 w-full grid-cols-[auto_minmax(3rem,1fr)_auto] items-center gap-2 text-left font-normal tabular-nums outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                            onClick={(event) => {
                              event.stopPropagation();
                              openCurrentRow();
                            }}
                            type="button"
                          >
                            <div className="justify-self-start">{row.departureTime}</div>
                            <div className="grid min-w-0 grid-cols-[1fr_auto_1fr] items-center gap-1.5 text-center text-muted-foreground before:border-muted-foreground before:border-t before:border-dashed before:opacity-55 after:border-muted-foreground after:border-t after:border-dashed after:opacity-55">
                              <span className="shrink-0 font-medium text-primary">{row.duration}</span>
                            </div>
                            <div className="justify-self-end text-right">{row.arrivalTime}</div>
                          </button>
                        </TableCell>
                        <TableCell className="h-12 min-w-0 px-1.5 py-0">
                          <button
                            aria-label={rowEditLabel}
                            className="flex h-12 w-full min-w-0 items-center gap-1.5 overflow-hidden text-left font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                            onClick={(event) => {
                              event.stopPropagation();
                              openCurrentRow();
                            }}
                            tabIndex={-1}
                            type="button"
                          >
                            <span className="min-w-0 truncate">{row.destination}</span>
                            {additionalActionCount > 0 ? (
                              <Badge
                                aria-label={`Дополнительных действий: ${additionalActionCount}`}
                                className="h-5 shrink-0 px-1.5 text-xs font-medium tabular-nums"
                                size="sm"
                                title={`Еще действий: ${additionalActionCount}`}
                                variant="outline"
                              >
                                +{additionalActionCount}
                              </Badge>
                            ) : null}
                            {row.pending ? <span className="ml-1 text-xs text-muted-foreground">...</span> : null}
                          </button>
                        </TableCell>
                        <TableCell className="h-12 px-0.5 py-0 text-center">
                          <button
                            aria-label={rowEditLabel}
                            className="grid h-12 w-full place-items-center outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                            onClick={(event) => {
                              event.stopPropagation();
                              openCurrentRow();
                            }}
                            tabIndex={-1}
                            type="button"
                          >
                            <Badge aria-label="Фокус" className="h-7 min-w-7 px-0 font-normal tabular-nums" size="lg" title="Фокус" variant="outline">
                            {row.pending ? <span className="text-xs">...</span> : row.actionIntervalCount > 0 ? <SquareTerminal aria-hidden="true" /> : <Timer aria-hidden="true" />}
                          </Badge>
                          </button>
                        </TableCell>
                      </>
                    )}
                  </TableRow>
                  {expanded && row.intervals.length > 1 ? (
                    <>
                      {row.intervals.map((interval) => (
                        <Fragment key={interval.id}>
                          <TableRow className="h-10 bg-muted/35">
                            <TableCell className="h-10 px-2 py-0 text-xs tabular-nums text-muted-foreground">
                              {moscowIntervalLabel(interval)}
                            </TableCell>
                            <TableCell className="h-10 min-w-0 px-2 py-0 text-sm">
                              <span className="block truncate">{interval.activity_title ?? "В фокусе"}</span>
                            </TableCell>
                            <TableCell className="h-10 px-0.5 py-0 text-center">
                              <Button
                                aria-label={`Редактировать интервал: ${interval.activity_title ?? "В фокусе"}`}
                                className="size-7 text-muted-foreground"
                                disabled={!interval.ended_at_utc}
                                onClick={(event) => void openInterval(row, interval, event)}
                                size="icon-sm"
                                type="button"
                                variant="ghost"
                              >
                                <Pencil className="size-3.5" aria-hidden="true" />
                              </Button>
                            </TableCell>
                          </TableRow>
                          {activeIntervalId === interval.id && draft ? renderEditorRow(row, draft, interval.id) : null}
                        </Fragment>
                      ))}
                      <TableRow className="h-10 bg-muted/35">
                        <TableCell className="h-10 px-2 py-0" colSpan={3}>
                          <Button
                            className="h-8 w-full justify-center text-destructive"
                            onClick={(event) => void deleteMultiRow(row, event)}
                            size="sm"
                            type="button"
                            variant="ghost"
                          >
                            <Trash2 className="size-3.5" aria-hidden="true" />
                            {confirmDeleteRowId === row.id ? "Подтвердить удаление" : "Удалить сессию"}
                          </Button>
                        </TableCell>
                      </TableRow>
                    </>
                  ) : null}
                  {parentDraft ? renderEditorRow(row, parentDraft, row.id) : null}
                </Fragment>
              );
            })
          ) : (
            <TableRow>
              <TableCell className="h-24 text-center" colSpan={3}>
                Сессий нет.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </CardFrame>
  );
}

function TimeEditor({
  changed,
  editing,
  featured = false,
  field,
  inputValue,
  label,
  value,
  onBeginInput,
  onCancelInput,
  onCommitInput,
  onInput,
  onStep,
}: {
  changed: boolean;
  editing: boolean;
  featured?: boolean;
  field: FocusEditField;
  inputValue: string;
  label: string;
  value: string;
  onBeginInput: (field: FocusEditField) => void;
  onCancelInput: () => void;
  onCommitInput: () => void;
  onInput: (value: string) => void;
  onStep: (direction: -1 | 1) => void;
}) {
  const invalid = editing && normalizedInputValue(field, inputValue) == null;
  const changedClass = changed && "border-amber-500/70 bg-amber-500/10 text-amber-600 dark:border-amber-300/70 dark:bg-amber-300/10 dark:text-amber-300";
  return (
    <div
      className={cx(
        "grid h-11 min-w-0 grid-rows-[0.875rem_1fr] rounded-md border bg-background/45 px-1 py-0.5 transition-colors",
        featured && !changed && "border-primary/35 bg-primary/10",
        changedClass,
        editing && "border-ring bg-accent/40",
      )}
    >
      <span className={cx("truncate text-center text-xs leading-3", changed ? "text-amber-600 dark:text-amber-300" : "text-muted-foreground")}>{label}</span>
      <div className="grid min-w-0 grid-cols-[1.125rem_minmax(2.5rem,1fr)_1.125rem] items-center gap-0.5">
        <Button
          aria-label={editing ? "Отменить ввод времени" : "Уменьшить на 5 минут"}
          className="size-5 rounded-sm"
          onClick={(event) => {
            event.stopPropagation();
            if (editing) {
              onCancelInput();
            } else {
              onStep(-1);
            }
          }}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          {editing ? <X className="size-3" aria-hidden="true" /> : <Minus className="size-3" aria-hidden="true" />}
        </Button>
        {editing ? (
          <Input
            aria-invalid={invalid}
            aria-label="Значение времени"
            className="h-6 min-w-0 rounded-sm px-0.5 text-center text-sm text-amber-600 tabular-nums dark:text-amber-300"
            inputMode="numeric"
            onChange={(event) => onInput(event.target.value)}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Enter") onCommitInput();
              if (event.key === "Escape") onCancelInput();
            }}
            value={inputValue}
          />
        ) : (
          <button
            className={cx(
              "h-6 min-w-0 whitespace-nowrap rounded-sm px-0 text-center text-sm font-semibold tabular-nums transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
              changed ? "text-amber-600 dark:text-amber-300" : featured ? "text-primary" : "text-foreground",
            )}
            onClick={(event) => {
              event.stopPropagation();
              onBeginInput(field);
            }}
            type="button"
          >
            {value}
          </button>
        )}
        <Button
          aria-label={editing ? "Применить ввод времени" : "Увеличить на 5 минут"}
          className="size-5 rounded-sm"
          disabled={invalid}
          onClick={(event) => {
            event.stopPropagation();
            if (editing) {
              onCommitInput();
            } else {
              onStep(1);
            }
          }}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          {editing ? <Check className="size-3" aria-hidden="true" /> : <Plus className="size-3" aria-hidden="true" />}
        </Button>
      </div>
    </div>
  );
}

function moscowIntervalLabel(interval: FocusSessionInterval) {
  return `${moscowTime(interval.started_at_utc)}-${moscowTime(interval.ended_at_utc)} · ${formatHourMinute(interval.duration_seconds)}`;
}

function rangeEdit(intervalId: string, sessionId: string, startMs: number, endMs: number): IntervalRangeEdit {
  return {
    intervalId,
    sessionId,
    startedAtUtc: new Date(startMs).toISOString(),
    endedAtUtc: new Date(endMs).toISOString(),
  };
}

function toggleSetValue(values: Set<string>, value: string) {
  const next = new Set(values);
  if (next.has(value)) {
    next.delete(value);
  } else {
    next.add(value);
  }
  return next;
}
