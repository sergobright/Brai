import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { setupBraiAppTest, swipe } from "./app-test-support";
import { BraiApp } from "@/features/app/BraiApp";
import { installAndroidBackHandler } from "@/shared/platform/platform";
import { saveInboxState } from "@/shared/storage/inboxStore";
import { saveHistoryCache } from "@/shared/storage/syncStore";

describe("BraiApp gestures", () => {
  setupBraiAppTest();

  it("tries Android back handlers from the top layer down", () => {
    const calls: string[] = [];
    const cleanupBase = installAndroidBackHandler(() => {
      calls.push("base");
      return true;
    });
    const cleanupTop = installAndroidBackHandler(() => {
      calls.push("top");
      return false;
    });

    expect(window.BraiAndroidBack?.()).toBe(true);
    expect(calls).toEqual(["top", "base"]);

    cleanupTop();
    cleanupBase();
  });

  it("does not move screens from horizontal page-body drags", () => {
    render(<BraiApp />);
    const main = screen.getByRole("main");

    fireEvent.touchStart(main, {
      changedTouches: [{ identifier: 1, clientX: 320, clientY: 220 }],
    });
    fireEvent.touchMove(main, {
      changedTouches: [{ identifier: 1, clientX: 240, clientY: 224 }],
    });

    const current = document.querySelector('[data-section-page="actions"]');

    expect(current).toBeInstanceOf(HTMLElement);
    expect((current as HTMLElement).style.transform).toBe("");
    expect(document.querySelector('[data-section-page="focus"]')).not.toBeInTheDocument();
  });

  it("opens the Actions navigation drawer from a left-edge page swipe", async () => {
    render(<BraiApp />);
    const main = screen.getByRole("main");

    fireEvent.touchStart(main, {
      changedTouches: [{ identifier: 1, clientX: 2, clientY: 220 }],
    });
    fireEvent.touchMove(main, {
      changedTouches: [{ identifier: 1, clientX: 88, clientY: 224 }],
    });
    fireEvent.touchEnd(main, {
      changedTouches: [{ identifier: 1, clientX: 116, clientY: 224 }],
    });

    const drawer = await screen.findByRole("dialog", { name: "Списки действий" });
    expect(drawer).toHaveClass("mobile-profile-drawer", "w-[min(86vw,22rem)]");
    expect(within(drawer).getByRole("navigation", { name: "Списки действий" })).toBeInTheDocument();
    expect(within(drawer).getByRole("button", { name: /^Все\d*$/ })).toBeInTheDocument();
    expect(document.querySelector(".mobile-dock-overflow-sheet")).not.toBeInTheDocument();

    fireEvent.click(within(drawer).getByRole("button", { name: /Операции/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Списки действий" })).not.toBeInTheDocument());
  });

  it("keeps the left-edge swipe routed to dock overflow outside Actions", async () => {
    render(<BraiApp initialSection="focus" />);
    const main = screen.getByRole("main");

    fireEvent.touchStart(main, {
      changedTouches: [{ identifier: 1, clientX: 2, clientY: 220 }],
    });
    fireEvent.touchMove(main, {
      changedTouches: [{ identifier: 1, clientX: 88, clientY: 224 }],
    });
    fireEvent.touchEnd(main, {
      changedTouches: [{ identifier: 1, clientX: 116, clientY: 224 }],
    });

    const sheet = await waitFor(() => {
      const current = document.querySelector(".mobile-dock-overflow-sheet");
      expect(current).toBeInstanceOf(HTMLElement);
      return current as HTMLElement;
    });
    expect(sheet).toHaveAttribute("aria-label", "Левое меню");
    expect(within(sheet).getByRole("button", { name: "Настройки" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Списки действий" })).not.toBeInTheDocument();
  });

  it("switches adjacent mobile tabs by swiping anywhere across the bottom menu zone", async () => {
    render(<BraiApp />);
    const dock = document.querySelector(".main-dock");
    expect(dock).toBeInstanceOf(HTMLElement);

    fireEvent.touchStart(dock as HTMLElement, {
      changedTouches: [{ identifier: 1, clientX: 340, clientY: 720 }],
    });
    fireEvent.touchMove(dock as HTMLElement, {
      changedTouches: [{ identifier: 1, clientX: 260, clientY: 724 }],
    });
    const current = document.querySelector('[data-section-page="actions"]');
    const adjacent = document.querySelector('[data-section-page="inbox"]');
    expect((current as HTMLElement).style.transform).toBe("translate3d(-80px, 0, 0)");
    expect((adjacent as HTMLElement).style.transform).toBe("translate3d(280px, 0, 0)");
    fireEvent.touchEnd(dock as HTMLElement, {
      changedTouches: [{ identifier: 1, clientX: 180, clientY: 724 }],
    });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Входящие" })).toBeInTheDocument());

    swipe(dock as HTMLElement, { fromX: 20, toX: 160 });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Действия" })).toBeInTheDocument());
  });

  it("does not switch mobile tabs while the profile drawer is open", () => {
    render(<BraiApp />);
    const dock = document.querySelector(".main-dock");
    expect(dock).toBeInstanceOf(HTMLElement);

    fireEvent.click(screen.getByRole("button", { name: "Открыть меню" }));
    swipe(dock as HTMLElement, { fromX: 320, toX: 180 });

    expect(document.querySelector('[data-section-page="actions"]')).toBeInTheDocument();
  });

  it("closes the mobile profile drawer through the Android back bridge", async () => {
    render(<BraiApp />);

    fireEvent.click(screen.getByRole("button", { name: "Открыть меню" }));
    await waitFor(() => expect(window.BraiAndroidBack).toBeTypeOf("function"));
    expect(window.BraiAndroidBack?.()).toBe(true);

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Списки действий" })).not.toBeInTheDocument());
  });

  it("closes the mobile dock overflow through the Android back bridge", async () => {
    render(<BraiApp />);

    fireEvent.click(screen.getByRole("button", { name: "Открыть правое меню" }));
    await waitFor(() => expect(window.BraiAndroidBack).toBeTypeOf("function"));
    expect(window.BraiAndroidBack?.()).toBe(true);

    await waitFor(() => expect(document.querySelector(".mobile-dock-overflow-sheet")).not.toBeInTheDocument());
  });

  it("keeps focus inside the modal drawer and restores it after Escape", async () => {
    render(<BraiApp />);

    const trigger = screen.getByRole("button", { name: "Открыть меню" });
    trigger.focus();
    fireEvent.click(trigger);
    const drawer = await screen.findByRole("dialog", { name: "Списки действий" });
    expect(drawer).toHaveAttribute("aria-modal", "true");
    expect(within(drawer).queryByRole("button", { name: "Закрыть меню" })).not.toBeInTheDocument();
    await waitFor(() => expect(drawer).toContainElement(document.activeElement as HTMLElement));

    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Списки действий" })).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("keeps vertical gestures as page scroll instead of tab navigation", () => {
    render(<BraiApp />);
    const main = screen.getByRole("main");

    swipe(main, { fromX: 320, toX: 240, fromY: 120, toY: 260 });

    expect(screen.getByRole("heading", { name: "Действия" })).toBeInTheDocument();
  });

  it("does not switch tabs from excluded horizontal gesture areas", async () => {
    render(<BraiApp initialSection="focus" />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Фокус" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "История фокуса" }));

    const excluded = document.querySelector(".focus-history-backdrop");
    expect(excluded).toBeInstanceOf(HTMLElement);
    swipe(excluded as HTMLElement, { fromX: 320, toX: 180 });

    expect(screen.getByRole("heading", { name: "Фокус" })).toBeInTheDocument();
    expect(document.querySelector(".mobile-context-sheet")).toBeInTheDocument();
  });

  it("fades the mobile sheet backdrop after the drag passes the sheet midpoint", async () => {
    render(<BraiApp initialSection="focus" />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Фокус" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "История фокуса" }));

    const sheet = document.querySelector(".mobile-context-sheet") as HTMLElement | null;
    const backdrop = document.querySelector(".mobile-context-backdrop > div") as HTMLElement | null;
    expect(sheet).toBeInstanceOf(HTMLElement);
    expect(backdrop).toBeInstanceOf(HTMLElement);
    Object.defineProperty(sheet, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ bottom: 500, height: 400, left: 0, right: 360, top: 100, width: 360, x: 0, y: 100 }),
    });

    fireEvent.touchStart(sheet as HTMLElement, {
      changedTouches: [{ identifier: 1, clientX: 200, clientY: 100 }],
    });
    fireEvent.touchMove(sheet as HTMLElement, {
      changedTouches: [{ identifier: 1, clientX: 200, clientY: 350 }],
    });

    await waitFor(() => expect(Number((backdrop as HTMLElement).style.getPropertyValue("--mobile-sheet-backdrop-opacity"))).toBeLessThan(1));
    expect((sheet as HTMLElement).style.getPropertyValue("--mobile-sheet-offset")).toBe("240px");
  });

  it("closes the mobile Focus history sheet from a downward row drag", async () => {
    await saveHistoryCache({
      sessions: [{
        id: "history-drag-session",
        started_at_utc: "2026-06-22T05:00:00.000Z",
        ended_at_utc: "2026-06-22T06:00:00.000Z",
        duration_seconds: 3600,
      }],
      groups: {},
    });
    render(<BraiApp initialSection="focus" />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Фокус" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "История фокуса" }));

    const sheet = await waitFor(() => {
      const current = document.querySelector(".mobile-context-sheet");
      expect(current).toBeInstanceOf(HTMLElement);
      return current as HTMLElement;
    });
    Object.defineProperty(sheet, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ bottom: 500, height: 400, left: 0, right: 360, top: 100, width: 360, x: 0, y: 100 }),
    });
    const rowButton = (await screen.findAllByRole("button", { name: /Редактировать фокус/ }))[0];

    fireEvent.touchStart(rowButton, {
      changedTouches: [{ identifier: 1, clientX: 200, clientY: 120 }],
    });
    fireEvent.touchMove(rowButton, {
      changedTouches: [{ identifier: 1, clientX: 200, clientY: 340 }],
    });
    fireEvent.touchEnd(rowButton, {
      changedTouches: [{ identifier: 1, clientX: 200, clientY: 340 }],
    });

    await waitFor(() => expect(document.querySelector(".mobile-context-sheet")).not.toBeInTheDocument());
  });

  it("closes a mobile Inbox detail sheet from a downward image attachment drag", async () => {
    await saveInboxState({
      server_time_utc: "2026-06-28T12:00:00.000Z",
      server_revision: 7,
      inbox: [{
        id: "inbox-image-drag",
        title: "Preview demo: картинка во входящих",
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
        status: "New",
        completed_at_utc: null,
        attachment_links: ["/v1/inbox/attachments/codex-inbox-image-previews-demo.png"],
        explanation_text: "",
        normalization_text: "",
        is_normalized: false,
        created_at_utc: "2026-06-28T10:00:00.000Z",
        updated_at_utc: "2026-06-28T11:00:00.000Z",
        deleted_at_utc: null,
      }],
    });
    render(<BraiApp initialSection="inbox" />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Входящие" })).toBeInTheDocument());
    fireEvent.click(await screen.findByRole("textbox", { name: "Название входящего: Preview demo: картинка во входящих" }));

    const sheet = await waitFor(() => {
      const current = document.querySelector(".actions-detail-panel.mobile");
      expect(current).toBeInstanceOf(HTMLElement);
      return current as HTMLElement;
    });
    Object.defineProperty(sheet, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ bottom: 700, height: 600, left: 0, right: 360, top: 100, width: 360, x: 0, y: 100 }),
    });
    const image = await screen.findByRole("img", { name: "codex-inbox-image-previews-demo.png" });
    expect(image).toHaveAttribute("draggable", "false");

    fireEvent.touchStart(image, {
      changedTouches: [{ identifier: 1, clientX: 180, clientY: 260 }],
    });
    fireEvent.touchMove(image, {
      changedTouches: [{ identifier: 1, clientX: 180, clientY: 620 }],
    });
    fireEvent.touchEnd(image, {
      changedTouches: [{ identifier: 1, clientX: 180, clientY: 620 }],
    });

    await waitFor(() => expect(document.querySelector(".actions-detail-panel.mobile")).not.toBeInTheDocument());
  });

  it("closes an open mobile sheet through the Android back bridge", async () => {
    render(<BraiApp initialSection="focus" />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Фокус" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "История фокуса" }));

    await waitFor(() => expect(window.BraiAndroidBack).toBeTypeOf("function"));
    expect(window.BraiAndroidBack?.()).toBe(true);

    await waitFor(() => expect(document.querySelector(".mobile-context-sheet")).not.toBeInTheDocument());
  });
});
