"use client";

import { useMemo, useState } from "react";
import { type ColumnDef, flexRender, getCoreRowModel, getSortedRowModel, type SortingState, useReactTable } from "@tanstack/react-table";
import { Check, Pencil, Timer, X } from "lucide-react";
import { MOSCOW_OFFSET_MS } from "@/shared/time/format";
import type { TimerSession } from "@/shared/types/timer";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { CardFrame } from "@/shared/ui/card";
import { Input } from "@/shared/ui/input";
import { Table, TableBody, TableCell, TableRow } from "@/shared/ui/table";
import { cx } from "../../appUtils";
import { focusHistoryRows, type FocusHistoryRow } from "./focusHistoryModel";

type EditingRow = { id: string; start: string; end: string; error: string | null };

export function FocusHistoryTable({
  sessions,
  onEditSession,
}: {
  sessions: TimerSession[];
  onEditSession?: (sessionId: string, startedAtUtc: string, endedAtUtc: string) => void | Promise<void>;
}) {
  const [sorting, setSorting] = useState<SortingState>([
    {
      desc: true,
      id: "departureTime",
    },
  ]);
  const [editing, setEditing] = useState<EditingRow | null>(null);
  const rows = useMemo<FocusHistoryRow[]>(
    () => focusHistoryRows(sessions),
    [sessions],
  );
  const columns: ColumnDef<FocusHistoryRow>[] = [
    {
      accessorKey: "departureTime",
      cell: ({ row }) => {
        if (editing?.id === row.original.id) {
          return (
            <div className="grid min-w-0 gap-1.5">
              <div className="grid min-w-0 grid-cols-2 gap-1.5">
                <Input
                  aria-label="Начало фокуса"
                  className="h-8 min-w-0 px-2 text-xs tabular-nums"
                  onChange={(event) => setEditing({ ...editing, start: event.target.value, error: null })}
                  type="datetime-local"
                  value={editing.start}
                />
                <Input
                  aria-label="Финиш фокуса"
                  className="h-8 min-w-0 px-2 text-xs tabular-nums"
                  onChange={(event) => setEditing({ ...editing, end: event.target.value, error: null })}
                  type="datetime-local"
                  value={editing.end}
                />
              </div>
              {editing.error ? <div className="text-xs text-destructive">{editing.error}</div> : null}
            </div>
          );
        }

        return (
          <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] items-center gap-2 font-normal tabular-nums">
            <div className="justify-self-start">{row.original.departureTime}</div>
            <div className="grid min-w-0 grid-cols-[1fr_auto_1fr] items-center gap-1.5 text-center text-muted-foreground before:border-muted-foreground before:border-t before:border-dashed before:opacity-55 after:border-muted-foreground after:border-t after:border-dashed after:opacity-55">
              <span className="shrink-0 font-medium text-primary">{row.original.duration}</span>
            </div>
            <div className="justify-self-end text-right">{row.original.arrivalTime}</div>
          </div>
        );
      },
      header: "Time",
      size: editing ? 248 : 168,
    },
    {
      accessorKey: "destination",
      cell: ({ row }) => (
        <div className="min-w-0 overflow-hidden font-medium [mask-image:linear-gradient(to_right,#000_calc(100%-1.25rem),transparent)]">
          {row.getValue<string>("destination")}
          {row.original.pending ? <span className="ml-1 text-xs text-muted-foreground">...</span> : null}
        </div>
      ),
      header: "Destination",
      size: 176,
    },
    {
      id: "terminal",
      cell: ({ row }) => (
        <Badge aria-label="Фокус" className="h-7 min-w-7 px-0 font-normal tabular-nums" size="lg" title="Фокус" variant="outline">
          {row.original.pending ? <span className="text-xs">...</span> : <Timer aria-hidden="true" />}
        </Badge>
      ),
      header: "Terminal",
      size: 34,
    },
    ...(onEditSession ? [{
      id: "edit",
      cell: ({ row }) => editing?.id === row.original.id ? (
        <div className="flex items-center justify-end gap-1">
          <Button aria-label="Сохранить время фокуса" className="size-8" onClick={() => void saveEdit()} size="icon" type="button" variant="ghost">
            <Check className="size-4" aria-hidden="true" />
          </Button>
          <Button aria-label="Отменить изменение времени фокуса" className="size-8" onClick={() => setEditing(null)} size="icon" type="button" variant="ghost">
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>
      ) : (
        <Button aria-label="Изменить время фокуса" className="size-8" onClick={() => startEdit(row.original)} size="icon" type="button" variant="ghost">
          <Pencil className="size-4" aria-hidden="true" />
        </Button>
      ),
      header: "Edit",
      size: 72,
    } satisfies ColumnDef<FocusHistoryRow>] : []),
  ];

  function startEdit(row: FocusHistoryRow) {
    if (!row.endedAtUtc) return;
    setEditing({
      id: row.id,
      start: toMoscowInputValue(row.startedAtUtc),
      end: toMoscowInputValue(row.endedAtUtc),
      error: null,
    });
  }

  async function saveEdit() {
    if (!editing || !onEditSession) return;
    const startedAtUtc = fromMoscowInputValue(editing.start);
    const endedAtUtc = fromMoscowInputValue(editing.end);
    if (!startedAtUtc || !endedAtUtc || Date.parse(endedAtUtc) <= Date.parse(startedAtUtc)) {
      setEditing({ ...editing, error: "Финиш должен быть позже старта." });
      return;
    }
    await onEditSession(editing.id, startedAtUtc, endedAtUtc);
    setEditing(null);
  }

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table returns handler functions by design.
  const table = useReactTable({
    columns,
    data: rows,
    enableSortingRemoval: false,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onSortingChange: setSorting,
    state: {
      sorting,
    },
  });

  return (
    <CardFrame className="w-full">
      <Table variant="card" className="table-fixed">
        <colgroup>
          {columns.map((column, index) => (
            <col key={index} style={column.size ? { width: `${column.size}px` } : undefined} />
          ))}
        </colgroup>
        <TableBody>
          {table.getRowModel().rows.length ? (
            table.getRowModel().rows.map((row) => (
              <TableRow key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell
                    className={cx(
                      cell.column.id === "destination" && "min-w-0 px-1.5",
                      cell.column.id === "departureTime" && "px-1.5",
                      cell.column.id === "terminal" && "px-0.5 text-center",
                      cell.column.id === "edit" && "px-0.5 text-right",
                    )}
                    key={cell.id}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell className="h-24 text-center" colSpan={columns.length}>
                Сессий нет.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </CardFrame>
  );
}

function toMoscowInputValue(utcIso: string): string {
  const ms = Date.parse(utcIso);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms + MOSCOW_OFFSET_MS).toISOString().slice(0, 16);
}

function fromMoscowInputValue(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - MOSCOW_OFFSET_MS).toISOString();
}
