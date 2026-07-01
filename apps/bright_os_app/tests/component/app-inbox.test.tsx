import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BrightOsApp } from "@/features/app/BrightOsApp";
import { TITLE_MAX_LENGTH } from "@/shared/activities/text";
import { pendingInboxEvents, saveInboxState } from "@/shared/storage/inboxStore";
import { setupBrightOsAppTest } from "./app-test-support";

describe("BrightOsApp inbox", () => {
  setupBrightOsAppTest();

  it("creates a mobile inbox item with a description from the composer", async () => {
    render(<BrightOsApp />);

    fireEvent.click(screen.getAllByRole("button", { name: "Входящие" }).at(-1) as HTMLElement);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Входящие" })).toBeInTheDocument());
    fireEvent.click(document.querySelector(".actions-fab") as HTMLElement);
    const overlay = within(document.querySelector(".actions-mobile-overlay") as HTMLElement);

    const title = overlay.getByRole("textbox", { name: "Добавить входящее" }) as HTMLTextAreaElement;
    await waitFor(() => expect(title).toHaveFocus());
    expect(title).toHaveAttribute("enterkeyhint", "enter");

    const description = overlay.getByRole("textbox", { name: "Описание входящего" });
    fireEvent.focus(description);
    fireEvent.change(title, { target: { value: " Новое письмо " } });
    fireEvent.change(description, { target: { value: "Контекст письма" } });
    fireEvent.click(overlay.getByRole("button", { name: "Добавить входящее" }));

    await waitFor(async () => {
      expect(await pendingInboxEvents()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "create",
            payload: { title: "Новое письмо", description_md: "Контекст письма" },
          }),
        ]),
      );
    });
  });

  it("opens Входящие from the main dock and creates an incoming item without action statuses", async () => {
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

    render(<BrightOsApp />);

    fireEvent.click(screen.getAllByRole("button", { name: "Входящие" }).at(-1) as HTMLElement);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Входящие" })).toBeInTheDocument());
    expect(screen.getAllByLabelText("Информация о входящих").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Закрыть информацию о входящих" })).not.toBeInTheDocument();

    const input = screen.getByRole("textbox", { name: "Добавить входящее" });
    fireEvent.change(input, { target: { value: " Новое письмо " } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    const title = await screen.findByRole("textbox", { name: "Название входящего: Новое письмо" });
    const inboxRow = title.closest(".action-row") as HTMLElement;
    expect(screen.queryByRole("checkbox", { name: "Новое письмо" })).not.toBeInTheDocument();
    expect(screen.queryByText("Выполнено")).not.toBeInTheDocument();
    expect(screen.getByText("Тип входящего")).toBeInTheDocument();
    expect(inboxRow).toHaveClass("max-[860px]:select-none");

    fireEvent.click(title);
    await waitFor(() => expect(screen.getByRole("button", { name: "Закрыть редактор" })).toBeInTheDocument());
    expect(inboxRow).toHaveClass("rounded-lg", "border-b-transparent");
    expect(inboxRow).toHaveClass("[&:has(+_.action-row.selected)]:border-b-transparent");
    const detailPanel = screen.getByLabelText("Редактирование входящего");
    expect(detailPanel).toHaveClass("px-0");
    const detailTitle = screen.getByRole("textbox", { name: "Название входящего" });
    const detailTabs = detailPanel.querySelector(".actions-detail-tabs") as HTMLElement;
    expect(detailTabs.compareDocumentPosition(detailTitle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(detailTitle.closest(".actions-detail-title-block")).toHaveClass("mt-6");
    expect(detailTitle).not.toHaveClass("truncate");
    expect(detailPanel).toHaveClass("overflow-hidden");
    const limitedTitle = "В".repeat(TITLE_MAX_LENGTH);
    fireEvent.change(detailTitle, { target: { value: `${limitedTitle}лишнее` } });
    await waitFor(() => expect(detailTitle).toHaveValue(limitedTitle));
    expect(detailPanel.querySelector(".actions-detail-title-counter")).toHaveTextContent("0");
    expect(detailPanel.querySelector(".actions-detail-title-counter")).toHaveClass("text-destructive");
    const detailScroll = detailPanel.querySelector(".actions-detail-description-scroll");
    expect(detailScroll).toBeInTheDocument();
    expect(detailScroll?.parentElement).toBe(detailPanel);
    const splitSlider = screen.getByRole("slider", { name: "Изменить ширину панелей" });
    expect(splitSlider).toHaveAttribute("aria-valuenow", "50");
    fireEvent.keyDown(splitSlider, { key: "End" });
    expect(splitSlider).toHaveAttribute("aria-valuenow", "70");
    fireEvent.keyDown(splitSlider, { key: "Home" });
    expect(splitSlider).toHaveAttribute("aria-valuenow", "30");
    const descriptionEditor = screen.getByRole("textbox", { name: "Описание входящего" });
    expect(descriptionEditor).toHaveClass("before:float-right", "before:w-12");
    descriptionEditor.textContent = "# Контекст\n\n## Источник\n\n**важно**";
    fireEvent.input(descriptionEditor);
    expect(detailPanel.querySelector(".actions-detail-header .actions-detail-preview-toggle")).not.toBeInTheDocument();
    expect(detailPanel.querySelector(".actions-detail-description-scroll .actions-detail-preview-toggle")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Читать описание" })).toHaveClass("absolute");
    expect(screen.getByRole("button", { name: "Читать описание" })).not.toHaveClass("float-right");
    fireEvent.click(screen.getByRole("button", { name: "Читать описание" }));
    await waitFor(() => expect(screen.getByLabelText("MD просмотр описания входящего")).toHaveTextContent("Контекст"));
    fireEvent.click(screen.getByRole("tab", { name: "Детали" }));
    fireEvent.click(screen.getByRole("tab", { name: "Инфо" }));
    expect(screen.getByLabelText("MD просмотр описания входящего")).toHaveTextContent("Источник");
    expect(screen.getByLabelText("MD просмотр описания входящего")).toHaveTextContent("важно");
    fireEvent.click(screen.getByRole("button", { name: "Закрыть редактор" }));
    await waitFor(() => expect(screen.getAllByRole("status", { name: "сбой" }).length).toBeGreaterThan(0));

    await waitFor(async () => {
      expect(await pendingInboxEvents()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "update_description",
            payload: { description_md: "# Контекст\n\n## Источник\n\n**важно**" },
          }),
        ]),
      );
    });
  });

  it("shows inbox detail tabs with attachments, fields, and DB reference", async () => {
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
    await saveInboxState({
      server_time_utc: "2026-06-28T12:00:00.000Z",
      server_revision: 7,
      inbox: [
        {
          id: "inbox-tabs",
          title: "Входящее с файлами",
          description_md: "Описание",
          source: "telegram",
          source_key: "chain-1",
          response_required: true,
          related_inbox_id: null,
          record_type_id: 2,
          item_date: null,
          author: "",
          preliminary_section: "",
          urgency: "",
          attachment_links: ["/v1/inbox/attachments/photo.png", "/v1/inbox/attachments/brief.pdf"],
          explanation_text: "Сырой текст",
          normalization_text: "",
          is_normalized: false,
          created_at_utc: "2026-06-28T10:00:00.000Z",
          updated_at_utc: "2026-06-28T11:00:00.000Z",
          deleted_at_utc: null,
        },
      ],
    });

    render(<BrightOsApp />);

    fireEvent.click(screen.getAllByRole("button", { name: "Входящие" }).at(-1) as HTMLElement);
    const title = await screen.findByRole("textbox", { name: "Название входящего: Входящее с файлами" });
    fireEvent.click(title);

    expect(screen.getByRole("tab", { name: "Инфо" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Связи" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "AI" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "История" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Детали" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "БД" })).toBeInTheDocument();
    expect(screen.getByLabelText("Прикрепленные файлы")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /brief\.pdf/ })).toHaveAttribute("href", "/api/v1/inbox/attachments/brief.pdf");
    expect(screen.getByRole("link", { name: /brief\.pdf/ })).toHaveAttribute("download", "brief.pdf");

    fireEvent.click(screen.getByRole("button", { name: "Открыть вложение photo.png" }));
    expect(screen.getByRole("dialog", { name: "photo.png" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Закрыть вложение" }));
    expect(screen.queryByRole("dialog", { name: "photo.png" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Детали" }));
    expect(screen.getByRole("tab", { name: "Детали" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("source_key")).toBeInTheDocument();
    expect(screen.getByText("chain-1")).toBeInTheDocument();
    expect(screen.getByText("record_type_id")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Пустые поля/ }));
    expect(screen.getByText("author")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "БД" }));
    expect(screen.getByText("description_text")).toBeInTheDocument();
    expect(screen.getByText("Описание / основное содержимое, фактически Markdown-текст")).toBeInTheDocument();
    expect(screen.getByText("Входящее от агента по API")).toBeInTheDocument();
  });
});
