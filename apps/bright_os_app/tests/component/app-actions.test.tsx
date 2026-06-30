import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { cachedActivitiesState, openProfileMenuItem, setupBrightOsAppTest } from "./app-test-support";
import { BrightOsApp } from "@/features/app/BrightOsApp";
import { ActionRow } from "@/features/app/sections/actions/ActionRow";
import { pendingActivityEvents, saveActivitiesState } from "@/shared/storage/activityStore";
import { pendingEvents, saveCanonicalState } from "@/shared/storage/syncStore";

describe("BrightOsApp actions", () => {
  setupBrightOsAppTest();

  it("adds an action and moves it to the completed group", async () => {
    render(<BrightOsApp />);
    const input = screen.getByRole("textbox", { name: "Добавить" });

    fireEvent.change(input, { target: { value: " Фокус " } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Название действия: Фокус" })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Выполнено 0/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "Фокус" }));

    await waitFor(() => expect(screen.getByRole("button", { name: /Выполнено 1/ })).toBeInTheDocument());
    expect(screen.getByRole("checkbox", { name: "Фокус" })).toBeChecked();
  });

  it("does not complete an action when its title is clicked", async () => {
    render(<BrightOsApp />);
    const input = screen.getByRole("textbox", { name: "Добавить" });

    fireEvent.change(input, { target: { value: "Фокус" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    const title = await screen.findByRole("textbox", { name: "Название действия: Фокус" });
    fireEvent.click(title);

    expect(screen.getByRole("checkbox", { name: "Фокус" })).not.toBeChecked();
    expect(screen.queryByRole("button", { name: /Выполнено 1/ })).not.toBeInTheDocument();
  });

  it("deletes an action from the list", async () => {
    render(<BrightOsApp />);
    const input = screen.getByRole("textbox", { name: "Добавить" });

    fireEvent.change(input, { target: { value: "Фокус" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Название действия: Фокус" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Удалить: Фокус", hidden: true }));

    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Название действия: Фокус" })).not.toBeInTheDocument());
  });

  it("opens Archive from the profile menu and restores a deleted action", async () => {
    render(<BrightOsApp />);
    const input = screen.getByRole("textbox", { name: "Добавить" });

    fireEvent.change(input, { target: { value: "Фокус" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Название действия: Фокус" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Удалить: Фокус", hidden: true }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Название действия: Фокус" })).not.toBeInTheDocument());

    await openProfileMenuItem("Архив");
    await waitFor(() => expect(screen.getByRole("heading", { name: "Архив" })).toBeInTheDocument());
    const archiveList = screen.getByLabelText("Удаленные действия");
    expect(within(archiveList).getByText("Фокус")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Восстановить: Фокус", hidden: true }));
    await waitFor(() => expect(within(archiveList).queryByText("Фокус")).not.toBeInTheDocument());

    fireEvent.click(screen.getAllByRole("button", { name: "Действия" }).at(-1) as HTMLElement);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Название действия: Фокус" })).toBeInTheDocument());
  });

  it("shows the cached Actions snapshot before the network refresh finishes", async () => {
    await saveActivitiesState({
      server_time_utc: "2026-06-16T12:00:00.000Z",
      server_revision: 3,
      actions: [
        {
          id: "action-cached",
          title: "Кэшированное действие",
          description_md: "",
          status: "New",
          created_at_utc: "2026-06-16T10:00:00.000Z",
          updated_at_utc: "2026-06-16T10:00:00.000Z",
          completed_at_utc: null,
          sort_order: null,
          deleted_at_utc: null,
          restored_at_utc: null,
        },
      ],
      archived_actions: [],
    });

    render(<BrightOsApp />);

    expect(screen.queryByText("Новых действий нет")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Кэшированное действие")).toBeInTheDocument());
  });

  it("opens the desktop activity detail panel and flushes description on close", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        media: "(max-width: 860px)",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1200 });
    await saveActivitiesState(cachedActivitiesState("action-detail", "Детальное действие"));

    render(<BrightOsApp />);

    await waitFor(() => expect(screen.getByText("Детальное действие")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("textbox", { name: "Название действия: Детальное действие" }));
    expect(screen.getByRole("button", { name: "Закрыть редактор" })).toBeInTheDocument();
    expect(screen.getByLabelText("Редактирование действия")).toHaveClass("pr-7");
    const detailTitle = screen.getByRole("textbox", { name: "Название действия" });
    expect(detailTitle).toHaveClass("truncate");
    expect(screen.getByRole("tab", { name: "Инфо" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Связи" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "AI" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "История" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Детали" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "БД" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Детали" }));
    expect(screen.getByText("status")).toBeInTheDocument();
    expect(screen.getByText("New")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Инфо" }));
    const splitSlider = screen.getByRole("slider", { name: "Изменить ширину панелей" });
    expect(splitSlider).toHaveAttribute("aria-valuenow", "50");
    fireEvent.keyDown(splitSlider, { key: "End" });
    expect(splitSlider).toHaveAttribute("aria-valuenow", "70");
    fireEvent.keyDown(splitSlider, { key: "Home" });
    expect(splitSlider).toHaveAttribute("aria-valuenow", "30");
    const storageKeys = Array.from({ length: window.localStorage.length }, (_, index) => window.localStorage.key(index) ?? "");
    expect(storageKeys.join(" ")).not.toMatch(/split|ratio|pane/i);

    const descriptionEditor = screen.getByRole("textbox", { name: "Описание действия" });
    expect(descriptionEditor.closest("[data-slot='scroll-area']")).toBeInTheDocument();
    expect(descriptionEditor).toHaveClass("overflow-hidden");
    fireEvent.change(descriptionEditor, {
      target: { value: "# Большое описание\n\n## Цель\n\n**важно**" },
    });
    const readModeButton = screen.getByRole("button", { name: "Читать описание" });
    expect(readModeButton).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(readModeButton);
    await waitFor(() => expect(screen.getByRole("button", { name: "Редактировать описание" })).toHaveAttribute("aria-pressed", "true"));
    expect(window.localStorage.getItem("bright_os_activity_md_preview")).toBe("true");
    expect(screen.getByLabelText("MD просмотр описания действия").closest("[data-slot='scroll-area']")).toBeInTheDocument();
    expect(screen.getByLabelText("MD просмотр описания действия")).toHaveTextContent("Большое описание");
    expect(screen.getByLabelText("MD просмотр описания действия")).toHaveTextContent("Цель");
    expect(screen.getByLabelText("MD просмотр описания действия")).toHaveTextContent("важно");
    expect(screen.getByLabelText("MD просмотр описания действия")).not.toHaveTextContent("# Цель");
    expect(screen.getByLabelText("MD просмотр описания действия")).not.toHaveTextContent("##");
    expect(screen.getByLabelText("MD просмотр описания действия")).not.toHaveTextContent("**");
    fireEvent.click(screen.getByRole("button", { name: "Закрыть редактор" }));

    await waitFor(async () => {
      expect(await pendingActivityEvents()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            actionId: "action-detail",
            type: "update_description",
            payload: { description_md: "# Большое описание\n\n## Цель\n\n**важно**" },
          }),
        ]),
      );
    });
  });

  it("keeps desktop action rows aligned and visually bounded", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        media: "(max-width: 860px)",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1200 });
    await saveActivitiesState({
      server_time_utc: "2026-06-20T12:00:00.000Z",
      server_revision: 9,
      actions: [
        {
          id: "action-long",
          title: "Очень длинное действие которое должно занимать только две строки и мягко исчезать",
          description_md: "Тихое описание действия",
          status: "New",
          created_at_utc: "2026-06-20T10:00:00.000Z",
          updated_at_utc: "2026-06-20T10:00:00.000Z",
          completed_at_utc: null,
          sort_order: null,
          deleted_at_utc: null,
          restored_at_utc: null,
        },
        {
          id: "action-done",
          title: "Завершенное действие",
          description_md: "",
          status: "Done",
          created_at_utc: "2026-06-20T09:00:00.000Z",
          updated_at_utc: "2026-06-20T09:30:00.000Z",
          completed_at_utc: "2026-06-20T09:30:00.000Z",
          sort_order: null,
          deleted_at_utc: null,
          restored_at_utc: null,
        },
      ],
      archived_actions: [],
    });

    render(<BrightOsApp />);

    const activeTitle = await screen.findByRole("textbox", { name: /Название действия: Очень длинное действие/ });
    const activeRow = activeTitle.closest(".action-row") as HTMLElement;
    const completedTitle = screen.getByRole("textbox", { name: "Название действия: Завершенное действие" });
    const completedRow = completedTitle.closest(".action-row") as HTMLElement;
    const completedToggle = screen.getByRole("button", { name: "Выполнено 1" });

    expect(activeRow.querySelector(".action-row-surface")).toHaveClass("grid-cols-[20px_28px_minmax(0,1fr)]");
    expect(completedRow.querySelector(".action-row-surface")).toHaveClass("grid-cols-[20px_28px_minmax(0,1fr)]");
    expect(activeRow.querySelector(".action-drag-handle svg")).toBeInTheDocument();
    expect(completedRow.querySelector(".action-drag-placeholder")).toBeInTheDocument();
    expect(completedRow.querySelector(".action-drag-handle")).not.toBeInTheDocument();
    expect(activeTitle).toHaveClass("max-h-12", "overflow-hidden", "text-base/6");
    expect(activeTitle).toHaveAttribute("data-title-fade");
    expect(activeRow.querySelector(".action-description-preview")?.className).toContain("text-xs/5");
    expect(activeRow.querySelector(".action-description-preview")?.className).toContain("text-muted-foreground/70");
    expect(completedToggle).toHaveClass("text-sm", "font-medium");
    expect(completedToggle.querySelector("svg.toggle-caret")).toBeInTheDocument();
    expect(completedToggle.querySelector("strong")).toHaveClass("text-primary");

    fireEvent.click(activeRow.querySelector(".action-row-surface") as HTMLElement);
    await waitFor(() => expect(screen.getByRole("button", { name: "Закрыть редактор" })).toBeInTheDocument());
    expect(activeRow).toHaveClass("selected", "bg-primary/10");
    expect(activeRow).toHaveClass("rounded-lg", "border-b-transparent");
    expect(activeRow).toHaveClass("[&:has(+_.action-row.selected)]:border-b-transparent");
    expect(activeRow).toContainElement(activeRow.querySelector(".action-delete-button") as HTMLElement);
  });

  it("queues action focus from a desktop action row", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        media: "(max-width: 860px)",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1200 });
    await saveActivitiesState(cachedActivitiesState("action-focus", "Фокус"));

    render(<BrightOsApp />);

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Название действия: Фокус" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Фокусироваться: Фокус", hidden: true }));

    await waitFor(async () =>
      expect(await pendingEvents()).toEqual([
        expect.objectContaining({
          type: "start_activity_focus",
          metadata: { activity_id: "action-focus" },
        }),
      ]),
    );
  });

  it("shows and stops active action focus from a desktop action row", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        media: "(max-width: 860px)",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1200 });
    const startedAtUtc = new Date(Date.now() - 120_000).toISOString();
    await saveActivitiesState(cachedActivitiesState("action-focus", "Фокус"));
    await saveCanonicalState({
      server_time_utc: new Date().toISOString(),
      server_revision: 5,
      timezone: "Europe/Moscow",
      active_session: {
        id: "session-active",
        started_at_utc: startedAtUtc,
        ended_at_utc: null,
        duration_seconds: null,
        intervals: [
          {
            id: "interval-active",
            focus_session_id: "session-active",
            activity_id: "action-focus",
            activity_title: "Фокус",
            started_at_utc: startedAtUtc,
            ended_at_utc: null,
            duration_seconds: null,
          },
        ],
        active_interval: {
          id: "interval-active",
          focus_session_id: "session-active",
          activity_id: "action-focus",
          activity_title: "Фокус",
          started_at_utc: startedAtUtc,
          ended_at_utc: null,
          duration_seconds: null,
        },
        active_activity_id: "action-focus",
        start_origin: "activity",
        started_by_activity_id: "action-focus",
      },
      elapsed_seconds: 120,
      active_interval: {
        id: "interval-active",
        focus_session_id: "session-active",
        activity_id: "action-focus",
        activity_title: "Фокус",
        started_at_utc: startedAtUtc,
        ended_at_utc: null,
        duration_seconds: null,
      },
      active_interval_elapsed_seconds: 120,
      active_activity_id: "action-focus",
      active_session_start_origin: "activity",
      active_session_started_by_activity_id: "action-focus",
    });

    render(<BrightOsApp />);

    const stopButton = await screen.findByRole("button", { name: "Остановить фокус: Фокус" });
    expect(within(stopButton).getByText("Стоп")).toBeInTheDocument();
    fireEvent.click(stopButton);

    await waitFor(async () =>
      expect(await pendingEvents()).toEqual([
        expect.objectContaining({
          type: "stop_activity_focus",
          metadata: { activity_id: "action-focus" },
        }),
      ]),
    );
  });

  it("requires a second mobile tap before stopping active action focus", async () => {
    vi.useFakeTimers();
    try {
      const onStopFocus = vi.fn(async () => undefined);
      render(
        <ActionRow
          action={{
            id: "action-focus",
            title: "Фокус",
            description_md: "",
            status: "New",
            created_at_utc: "2026-06-16T10:00:00.000Z",
            updated_at_utc: "2026-06-16T10:00:00.000Z",
            completed_at_utc: null,
            sort_order: null,
            deleted_at_utc: null,
            restored_at_utc: null,
          }}
          selected={false}
          activeFocus
          activeFocusElapsedSeconds={120}
          deleteOpen={false}
          onCloseDelete={() => undefined}
          onDelete={async () => undefined}
          onEditMobile={() => undefined}
          onOpenDelete={() => undefined}
          onSelect={() => undefined}
          onSetStatus={async () => undefined}
          onStopFocus={onStopFocus}
          onUpdateTitle={async () => undefined}
        />,
      );

      const stopButton = screen.getByRole("button", { name: "Остановить фокус: Фокус" });
      await act(async () => {
        fireEvent.click(stopButton);
      });
      expect(onStopFocus).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1700);
      });
      await act(async () => {
        fireEvent.click(stopButton);
      });
      expect(onStopFocus).not.toHaveBeenCalled();

      await act(async () => {
        fireEvent.click(stopButton);
      });
      expect(onStopFocus).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("mirrors desktop title drafts between the list and detail editor", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        media: "(max-width: 860px)",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1200 });
    await saveActivitiesState(cachedActivitiesState("action-title-draft", "Черновик"));

    render(<BrightOsApp />);

    const listTitle = await screen.findByRole("textbox", { name: "Название действия: Черновик" });
    const row = listTitle.closest(".action-row") as HTMLElement;
    fireEvent.click(row.querySelector(".action-row-surface") as HTMLElement);
    const detailTitle = await screen.findByRole("textbox", { name: "Название действия" });
    expect(document.activeElement).toBe(detailTitle);

    fireEvent.change(detailTitle, { target: { value: "Из detail без переноса" } });
    const mirroredListTitle = await screen.findByRole("textbox", { name: "Название действия: Из detail без переноса" });
    expect(detailTitle).toHaveValue("Из detail без переноса");
    expect(mirroredListTitle).toHaveTextContent("Из detail без переноса");

    const description = screen.getByRole("textbox", { name: "Описание действия" }) as HTMLTextAreaElement;
    fireEvent.change(description, { target: { value: "Описание" } });
    fireEvent.keyDown(detailTitle, { key: "Enter" });
    expect(document.activeElement).toBe(description);
    expect(description.selectionStart).toBe("Описание".length);

    mirroredListTitle.textContent = "Из списка";
    fireEvent.input(mirroredListTitle);
    await waitFor(() => expect(detailTitle).toHaveValue("Из списка"));

    fireEvent.blur(mirroredListTitle);
    await waitFor(async () => {
      expect(await pendingActivityEvents()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            actionId: "action-title-draft",
            type: "update_title",
            payload: { title: "Из списка" },
          }),
        ]),
      );
    });
  });

  it("keeps the desktop Actions info panel open by default", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        media: "(max-width: 860px)",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1200 });
    await saveActivitiesState(cachedActivitiesState("action-info-replace", "Информационная замена"));

    render(<BrightOsApp />);

    expect(screen.queryByRole("button", { name: "Информация о действиях" })).not.toBeInTheDocument();
    expect(document.querySelector(".actions-info-panel.desktop")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Закрыть информацию о действиях" })).not.toBeInTheDocument();

    await waitFor(() => expect(screen.getByText("Информационная замена")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("textbox", { name: "Название действия: Информационная замена" }));
    expect(document.querySelector(".actions-info-panel.desktop")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Закрыть редактор" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Закрыть редактор" }));
    expect(document.querySelector(".actions-info-panel.desktop")).toBeInTheDocument();
  });

  it("opens the mobile full-screen detail editor and flushes through the Android back bridge", async () => {
    await saveActivitiesState(cachedActivitiesState("action-mobile-detail", "Мобильное действие"));

    render(<BrightOsApp />);

    await waitFor(() => expect(screen.getByText("Мобильное действие")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("textbox", { name: "Название действия: Мобильное действие" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Сохранить и закрыть" })).toBeInTheDocument());

    const plainDescription = "https://magicui.design/docs/templates/changelog использовать вот этот\nшаблон";
    fireEvent.change(screen.getByRole("textbox", { name: "Описание действия" }), {
      target: { value: plainDescription },
    });
    fireEvent.click(screen.getByRole("button", { name: "Читать описание" }));
    const preview = await screen.findByLabelText("MD просмотр описания действия");
    expect(preview).toHaveTextContent("https://magicui.design/docs/templates/changelog");
    expect(preview.querySelector(".markdown-content")).toBeNull();
    expect(preview.firstElementChild).toHaveClass("whitespace-pre-wrap", "leading-[1.48]");
    fireEvent.click(screen.getByRole("button", { name: "Редактировать описание" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Описание действия" })).toHaveValue(plainDescription));
    expect(window.localStorage.getItem("bright_os_activity_md_preview")).toBe("false");
    await waitFor(() => expect(window.BrightOsAndroidBack).toBeTypeOf("function"));
    expect(window.BrightOsAndroidBack?.()).toBe(true);

    await waitFor(async () => {
      expect(screen.queryByRole("button", { name: "Сохранить и закрыть" })).not.toBeInTheDocument();
      expect(await pendingActivityEvents()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            actionId: "action-mobile-detail",
            type: "update_description",
            payload: { description_md: plainDescription },
          }),
        ]),
      );
    });
  });

  it("restores the global activity Markdown preview preference", async () => {
    window.localStorage.setItem("bright_os_activity_md_preview", "true");
    await saveActivitiesState(cachedActivitiesState("action-preview-preference", "Сохраненный режим", "## Цель"));

    render(<BrightOsApp />);

    await waitFor(() => expect(screen.getByText("Сохраненный режим")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("textbox", { name: "Название действия: Сохраненный режим" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Редактировать описание" })).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByLabelText("MD просмотр описания действия")).toHaveTextContent("Цель");
    expect(screen.queryByRole("textbox", { name: "Описание действия" })).not.toBeInTheDocument();
  });
});
