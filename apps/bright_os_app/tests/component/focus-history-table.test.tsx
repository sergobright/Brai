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
});
