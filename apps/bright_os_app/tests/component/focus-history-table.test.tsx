import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FocusHistoryTable } from "@/features/app/sections/focus/FocusHistoryTable";
import type { TimerSession } from "@/shared/types/timer";

const sessions: TimerSession[] = [
  {
    id: "session-1",
    started_at_utc: "2026-06-14T10:00:00.000Z",
    ended_at_utc: "2026-06-14T11:00:00.000Z",
    duration_seconds: 3600,
  },
  {
    id: "session-2",
    started_at_utc: "2026-06-14T11:00:00.000Z",
    ended_at_utc: "2026-06-14T12:00:00.000Z",
    duration_seconds: 3600,
  },
];

describe("FocusHistoryTable", () => {
  it("opens from the row, blocks overlaps, and deletes by canonical session", async () => {
    const onDeleteSession = vi.fn();
    const onEditSession = vi.fn();

    render(
      <FocusHistoryTable
        allSessions={sessions}
        sessions={sessions}
        onDeleteSession={onDeleteSession}
        onEditSession={onEditSession}
      />,
    );

    expect(screen.queryByLabelText("Изменить время фокуса")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("13:00"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Удалить запись фокуса" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "01:00" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Значение времени" }), {
      target: { value: "0:30" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Применить ввод времени" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "00:30" })).toHaveClass("text-amber-600"));
    expect(screen.getByRole("button", { name: "13:30" })).toHaveClass("text-amber-600");

    fireEvent.click(screen.getByRole("button", { name: "00:30" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Значение времени" }), {
      target: { value: "2:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Применить ввод времени" }));

    await waitFor(() => expect(screen.getByText("Нельзя наложить на соседний фокус")).toBeInTheDocument());
    expect(onEditSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Отменить редактирование фокуса" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Удалить запись фокуса" })).not.toBeInTheDocument());

    fireEvent.click(screen.getByText("13:00"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Удалить запись фокуса" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Удалить запись фокуса" }));
    await waitFor(() => expect(onDeleteSession).toHaveBeenCalledWith("session-1"));
  });

  it("edits a nested interval and confirms multi-interval deletion", async () => {
    const onDeleteSession = vi.fn();
    const onEditInterval = vi.fn();
    const multiIntervalSession: TimerSession = {
      id: "session-intervals",
      started_at_utc: "2026-06-14T10:00:00.000Z",
      ended_at_utc: "2026-06-14T11:00:00.000Z",
      duration_seconds: 3600,
      intervals: [
        {
          id: "interval-1",
          focus_session_id: "session-intervals",
          activity_id: "action-1",
          activity_title: "Письмо",
          started_at_utc: "2026-06-14T10:00:00.000Z",
          ended_at_utc: "2026-06-14T10:30:00.000Z",
          duration_seconds: 1800,
        },
        {
          id: "interval-2",
          focus_session_id: "session-intervals",
          activity_id: "action-2",
          activity_title: "Очень длинная подготовка",
          started_at_utc: "2026-06-14T10:30:00.000Z",
          ended_at_utc: "2026-06-14T10:40:00.000Z",
          duration_seconds: 600,
        },
        {
          id: "interval-3",
          focus_session_id: "session-intervals",
          activity_id: null,
          activity_title: null,
          started_at_utc: "2026-06-14T10:40:00.000Z",
          ended_at_utc: "2026-06-14T11:00:00.000Z",
          duration_seconds: 1200,
        },
      ],
      activity_interval_count: 2,
      primary_activity_id: "action-1",
      primary_activity_title: "Письмо",
    };

    render(
      <FocusHistoryTable
        allSessions={[multiIntervalSession]}
        sessions={[multiIntervalSession]}
        onDeleteSession={onDeleteSession}
        onEditInterval={onEditInterval}
      />,
    );

    expect(screen.getByText("Очень длинная подготовка")).toBeInTheDocument();
    expect(screen.getByLabelText("Дополнительных действий: 1")).toHaveTextContent("+1");

    fireEvent.click(screen.getByText("Очень длинная подготовка"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Редактировать интервал: Письмо" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Редактировать интервал: Письмо" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Закрыть редактирование фокуса" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "00:30" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Значение времени" }), {
      target: { value: "0:35" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Применить ввод времени" }));
    fireEvent.click(screen.getByRole("button", { name: "Закрыть редактирование фокуса" }));

    await waitFor(() => expect(onEditInterval).toHaveBeenCalledTimes(2));
    expect(onEditInterval).toHaveBeenNthCalledWith(
      1,
      "interval-2",
      "session-intervals",
      "2026-06-14T10:35:00.000Z",
      "2026-06-14T10:40:00.000Z",
    );
    expect(onEditInterval).toHaveBeenNthCalledWith(
      2,
      "interval-1",
      "session-intervals",
      "2026-06-14T10:00:00.000Z",
      "2026-06-14T10:35:00.000Z",
    );

    fireEvent.click(screen.getByRole("button", { name: "Удалить сессию" }));
    expect(onDeleteSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Подтвердить удаление" }));
    await waitFor(() => expect(onDeleteSession).toHaveBeenCalledWith("session-intervals"));
  });

  it("shows expanded multi-interval sessions as a continuous timeline", async () => {
    const session: TimerSession = {
      id: "session-gaps",
      started_at_utc: "2026-06-14T08:50:00.000Z",
      ended_at_utc: "2026-06-14T11:00:00.000Z",
      duration_seconds: 7800,
      intervals: [
        {
          id: "interval-focus-a",
          focus_session_id: "session-gaps",
          activity_id: null,
          activity_title: null,
          started_at_utc: "2026-06-14T08:50:00.000Z",
          ended_at_utc: "2026-06-14T09:15:00.000Z",
          duration_seconds: 1500,
        },
        {
          id: "interval-write",
          focus_session_id: "session-gaps",
          activity_id: "action-write",
          activity_title: "Demo: написать письмо",
          started_at_utc: "2026-06-14T09:30:00.000Z",
          ended_at_utc: "2026-06-14T10:00:00.000Z",
          duration_seconds: 1800,
        },
        {
          id: "interval-call",
          focus_session_id: "session-gaps",
          activity_id: "action-call",
          activity_title: "Demo: созвон",
          started_at_utc: "2026-06-14T10:03:00.000Z",
          ended_at_utc: "2026-06-14T10:17:00.000Z",
          duration_seconds: 840,
        },
        {
          id: "interval-focus-b",
          focus_session_id: "session-gaps",
          activity_id: null,
          activity_title: null,
          started_at_utc: "2026-06-14T10:20:00.000Z",
          ended_at_utc: "2026-06-14T11:00:00.000Z",
          duration_seconds: 2400,
        },
      ],
    };

    render(<FocusHistoryTable allSessions={[session]} sessions={[session]} />);

    fireEvent.click(screen.getByText("Demo: написать письмо"));

    expect(await screen.findByText("11:50-12:30 · 0:40")).toBeInTheDocument();
    expect(screen.getByText("12:30-13:00 · 0:30")).toBeInTheDocument();
    expect(screen.getByText("13:00-13:14 · 0:14")).toBeInTheDocument();
    expect(screen.getByText("13:14-14:00 · 0:46")).toBeInTheDocument();
  });
});
