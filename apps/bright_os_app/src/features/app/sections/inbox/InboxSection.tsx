"use client";

import type { CSSProperties, FormEvent, KeyboardEvent, MouseEvent, PointerEvent } from "react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { BookOpen, FilePenLine, FileText, Inbox, Link2, Mail, MessageSquare, Pencil, Plus, Sparkles, Trash2, X } from "lucide-react";
import { useSwipeable } from "react-swipeable";
import {
  cleanTitle,
  limitTitle,
  markdownPreviewSource,
  normalizeDescription,
  TITLE_COUNTER_THRESHOLD,
  TITLE_MAX_LENGTH,
  visibleDescriptionPreview,
} from "@/shared/activities/text";
import { installAndroidBackHandler } from "@/shared/platform/platform";
import type { InboxItem, InboxState } from "@/shared/types/inbox";
import { Button } from "@/shared/ui/button";
import { hasMarkdownSyntax, MarkdownContent } from "@/shared/ui/markdown-content";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/shared/ui/input-group";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { cx, fitTextareaHeight, focusEditableEnd, plainEditableText, setPlainEditableText } from "../../appUtils";
import { useMobileSheetDrag } from "../../hooks/useMobileSheetDrag";
import { useMobileSheetTop } from "../../hooks/useMobileSheetTop";
import { isMobileNavigationViewport } from "../../navigation/useSectionSwipeNavigation";
import {
  DetailAttachments,
  DetailDbReference,
  DetailEmptyTab,
  DetailFields,
  DetailHistory,
  DetailPanelTabBar,
  type DetailPanelTab,
} from "../DetailPanelTabs";
import { MobileCreateComposer, mobileCreateDraftHasText, type MobileCreateDraft } from "../MobileCreateComposer";
import { ActionsInfoPanel } from "../actions/ActionsInfoPanel";
import { ACTION_DELETE_REVEAL_WIDTH, ACTION_ROW_SERVICE_SELECTOR, ACTIONS_SPLIT_DEFAULT_PERCENT, ACTIONS_SPLIT_MIN_PERCENT, clampActionsSplitPercent, loadActivityMarkdownPreviewMode, saveActivityMarkdownPreviewMode } from "../actions/constants";

type DetailTitleFocus = "end" | null;

export function InboxSection({
  state,
  localSnapshotReady,
  autoFocusAddInput,
  onCreate,
  onUpdateTitle,
  onAutosaveDetails,
  onDelete,
  mobileCreateDraft,
  onMobileCreateDraftChange,
  onMobileOverlayChange,
}: {
  state: InboxState;
  localSnapshotReady: boolean;
  autoFocusAddInput: boolean;
  onCreate: (title: string, descriptionMd?: string) => Promise<void>;
  onUpdateTitle: (item: InboxItem, title: string) => Promise<void>;
  onAutosaveDetails: (item: InboxItem, title: string, descriptionMd: string) => Promise<void>;
  onDelete: (item: InboxItem) => Promise<void>;
  mobileCreateDraft: MobileCreateDraft;
  onMobileCreateDraftChange: (draft: MobileCreateDraft) => void;
  onMobileOverlayChange: (open: boolean) => void;
}) {
  const [draft, setDraft] = useState("");
  const [mobileCreateOpen, setMobileCreateOpen] = useState(false);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [mobileEditItemId, setMobileEditItemId] = useState<string | null>(null);
  const [openDeleteItemId, setOpenDeleteItemId] = useState<string | null>(null);
  const [splitPercent, setSplitPercent] = useState(ACTIONS_SPLIT_DEFAULT_PERCENT);
  const [titleDrafts, setTitleDrafts] = useState<Record<string, string>>({});
  const [detailTitleFocusRequest, setDetailTitleFocusRequest] = useState(0);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const splitDragStyleRef = useRef<{ userSelect: string } | null>(null);
  const desktopInputRef = useRef<HTMLInputElement | null>(null);
  const suppressMobileCreatePopRef = useRef(false);
  const selectedItem = selectedItemId ? state.inbox.find((item) => item.id === selectedItemId) : null;
  const mobileEditItem = mobileEditItemId ? state.inbox.find((item) => item.id === mobileEditItemId) : null;
  const visibleOpenDeleteItemId =
    openDeleteItemId && state.inbox.some((item) => item.id === openDeleteItemId) ? openDeleteItemId : null;
  const mobileOverlayOpen = mobileCreateOpen || mobileEditItem != null;
  const desktopSidePanelOpen = true;
  const mobileSheetTop = useMobileSheetTop();
  const mobileCreateHasDraft = mobileCreateDraftHasText(mobileCreateDraft);
  const MobileCreateFabIcon = mobileCreateHasDraft ? FilePenLine : Plus;
  const mobileCreateFabLabel = mobileCreateHasDraft ? "Продолжить черновик входящего" : "Добавить входящее";

  useEffect(() => {
    if (autoFocusAddInput) desktopInputRef.current?.focus();
  }, [autoFocusAddInput]);

  useEffect(() => {
    onMobileOverlayChange(mobileOverlayOpen);
    if (!mobileOverlayOpen) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
      onMobileOverlayChange(false);
    };
  }, [mobileOverlayOpen, onMobileOverlayChange]);

  async function submitDesktop(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = cleanTitle(draft);
    if (!title) return;
    setDraft("");
    await onCreate(title);
  }

  function closeOpenDeleteFromOutside(event: MouseEvent<HTMLElement>) {
    if (!visibleOpenDeleteItemId) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("[data-action-row-control]")) return;
    event.preventDefault();
    event.stopPropagation();
    setOpenDeleteItemId(null);
  }

  function openMobileCreate() {
    setOpenDeleteItemId(null);
    setMobileCreateOpen(true);
  }

  const closeMobileCreate = useCallback(() => {
    if (window.history.state?.brightMobileInboxCreate) {
      suppressMobileCreatePopRef.current = true;
      window.history.back();
    }
    setMobileCreateOpen(false);
  }, []);

  function openMobileEdit(item: InboxItem) {
    setOpenDeleteItemId(null);
    setSplitPercent(ACTIONS_SPLIT_DEFAULT_PERCENT);
    setSelectedItemId(item.id);
    setMobileEditItemId(item.id);
  }

  function setTitleDraft(itemId: string, title: string | null) {
    setTitleDrafts((current) => {
      if (title == null) {
        if (!(itemId in current)) return current;
        const next = { ...current };
        delete next[itemId];
        return next;
      }
      if (current[itemId] === title) return current;
      return { ...current, [itemId]: title };
    });
  }

  function selectItem(itemId: string, focusDetailTitle: DetailTitleFocus = "end") {
    if (selectedItemId !== itemId) setSplitPercent(ACTIONS_SPLIT_DEFAULT_PERCENT);
    setSelectedItemId(itemId);
    if (focusDetailTitle === "end") setDetailTitleFocusRequest((current) => current + 1);
  }

  async function submitMobile(title: string, descriptionMd: string) {
    await onCreate(title, descriptionMd);
    onMobileCreateDraftChange({ title: "", descriptionMd: "" });
    closeMobileCreate();
  }

  useEffect(() => {
    if (!mobileCreateOpen) return undefined;
    if (window.history.state?.brightMobileInboxCreate) {
      window.history.replaceState({ ...window.history.state, brightMobileInboxCreate: true }, "", window.location.href);
    } else {
      window.history.pushState({ ...window.history.state, brightMobileInboxCreate: true }, "", window.location.href);
    }

    function onPopState() {
      if (suppressMobileCreatePopRef.current) {
        suppressMobileCreatePopRef.current = false;
        return;
      }
      setMobileCreateOpen(false);
    }

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [mobileCreateOpen]);

  useEffect(() => {
    if (!mobileCreateOpen) return undefined;
    return installAndroidBackHandler(() => {
      closeMobileCreate();
      return true;
    });
  }, [closeMobileCreate, mobileCreateOpen]);

  function onSplitPointerDown(event: PointerEvent<HTMLButtonElement>) {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    event.preventDefault();
    splitDragStyleRef.current = {
      userSelect: document.body.style.userSelect,
    };
    document.body.style.userSelect = "none";
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onSplitPointerMove(event: PointerEvent<HTMLButtonElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const bounds = workspace.getBoundingClientRect();
    const rawPercent = ((event.clientX - bounds.left) / bounds.width) * 100;
    setSplitPercent(clampActionsSplitPercent(rawPercent));
  }

  function onSplitPointerEnd(event: PointerEvent<HTMLButtonElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const previous = splitDragStyleRef.current;
    if (!previous) return;
    document.body.style.userSelect = previous.userSelect;
    splitDragStyleRef.current = null;
  }

  function onSplitKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setSplitPercent((current) => clampActionsSplitPercent(current - 2));
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      setSplitPercent((current) => clampActionsSplitPercent(current + 2));
    }
    if (event.key === "Home") {
      event.preventDefault();
      setSplitPercent(ACTIONS_SPLIT_MIN_PERCENT);
    }
    if (event.key === "End") {
      event.preventDefault();
      setSplitPercent(100 - ACTIONS_SPLIT_MIN_PERCENT);
    }
  }

  return (
    <section
      className="actions-section relative grid h-full min-h-0 grid-rows-[minmax(0,1fr)] gap-3.5 max-[860px]:gap-0 max-[860px]:pb-0"
      aria-label="Входящие"
      onClickCapture={closeOpenDeleteFromOutside}
    >
      <div
        ref={workspaceRef}
        className={cx(
          "actions-workspace relative grid h-full min-h-0 min-w-0 items-stretch gap-[18px] max-[860px]:block",
          desktopSidePanelOpen ? "has-detail grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-0 overflow-hidden" : "grid-cols-[minmax(0,1fr)]",
        )}
        style={
          desktopSidePanelOpen
            ? ({
                "--actions-list-percent": `${splitPercent}%`,
                gridTemplateColumns: "minmax(0,var(--actions-list-percent)) minmax(0,calc(100% - var(--actions-list-percent)))",
              } as CSSProperties)
            : undefined
        }
      >
        <ScrollArea className="actions-list-pane h-full min-h-0 min-w-0">
          <form className="sticky top-0 z-[4] mb-[18px] max-[860px]:hidden" onSubmit={submitDesktop}>
            <InputGroup className="actions-add-form">
              <InputGroupInput
                ref={desktopInputRef}
                value={draft}
                maxLength={TITLE_MAX_LENGTH}
                placeholder="Добавить входящее"
                aria-label="Добавить входящее"
                autoFocus={autoFocusAddInput}
                onChange={(event) => setDraft(event.target.value)}
              />
              <InputGroupAddon align="inline-end">
                <Plus aria-hidden="true" />
              </InputGroupAddon>
            </InputGroup>
          </form>

          <div className="actions-list grid self-start" aria-label="Входящие">
            {state.inbox.length === 0 ? (
              <div className="actions-empty px-[52px] py-6 font-normal text-muted-foreground max-[860px]:px-3.5 max-[860px]:py-[18px] max-[860px]:text-center">
                {localSnapshotReady ? "Входящих нет" : "Загрузка входящих"}
              </div>
            ) : (
              state.inbox.map((item) => (
                <InboxRow
                  key={item.id}
                  item={item}
                  titleDraft={titleDrafts[item.id]}
                  selected={selectedItemId === item.id}
                  onSelect={(focusDetailTitle) => selectItem(item.id, focusDetailTitle)}
                  onEditMobile={openMobileEdit}
                  onUpdateTitle={onUpdateTitle}
                  onTitleDraftChange={setTitleDraft}
                  onDelete={onDelete}
                  deleteOpen={visibleOpenDeleteItemId === item.id}
                  onOpenDelete={() => setOpenDeleteItemId(item.id)}
                  onCloseDelete={() => setOpenDeleteItemId(null)}
                />
              ))
            )}
          </div>
        </ScrollArea>

        {desktopSidePanelOpen ? (
          <>
            <button
              type="button"
              className="actions-split-resizer group absolute inset-y-0 z-[5] hidden w-6 -translate-x-1/2 touch-none !cursor-ew-resize place-items-stretch justify-center border-0 bg-transparent px-[11px] py-0 max-[860px]:hidden min-[861px]:grid [&_*]:!cursor-ew-resize"
              style={{ left: `${splitPercent}%` }}
              aria-label="Изменить ширину панелей"
              aria-valuemin={ACTIONS_SPLIT_MIN_PERCENT}
              aria-valuemax={100 - ACTIONS_SPLIT_MIN_PERCENT}
              aria-valuenow={Math.round(splitPercent)}
              role="slider"
              onPointerDown={onSplitPointerDown}
              onPointerMove={onSplitPointerMove}
              onPointerUp={onSplitPointerEnd}
              onPointerCancel={onSplitPointerEnd}
              onKeyDown={onSplitKeyDown}
              data-inbox-split-divider
            >
              <span className="block h-full w-px bg-border transition-colors group-hover:bg-primary" aria-hidden="true" />
            </button>
            {selectedItem && !mobileEditItem ? (
              <InboxDetailEditor
                key={selectedItem.id}
                item={selectedItem}
                titleDraft={titleDrafts[selectedItem.id]}
                mode="desktop"
                focusTitleRequest={detailTitleFocusRequest}
                onClose={() => setSelectedItemId(null)}
                onTitleDraftChange={setTitleDraft}
                onAutosaveDetails={onAutosaveDetails}
              />
            ) : (
              <ActionsInfoPanel label="Информация о входящих" />
            )}
          </>
        ) : null}
      </div>

      {!mobileOverlayOpen ? (
        <button
          type="button"
          className="actions-fab absolute bottom-[18px] right-[18px] z-[26] hidden h-[58px] w-[58px] place-items-center rounded-full border-0 bg-primary text-primary-foreground shadow-lg max-[860px]:grid"
          aria-label={mobileCreateFabLabel}
          title={mobileCreateFabLabel}
          onClick={openMobileCreate}
        >
          <MobileCreateFabIcon aria-hidden="true" />
        </button>
      ) : null}

      {mobileCreateOpen ? (
        <div
          className="actions-mobile-overlay fixed inset-0 z-[80] hidden items-end bg-foreground/25 pb-[env(safe-area-inset-bottom)] max-[860px]:flex dark:bg-background/80"
          style={{ top: mobileSheetTop } as CSSProperties}
          data-nav-swipe-exclusion
          onClick={closeMobileCreate}
        >
          <MobileCreateComposer
            draft={mobileCreateDraft}
            titleLabel="Добавить входящее"
            descriptionLabel="Описание входящего"
            submitLabel="Добавить входящее"
            onCancel={closeMobileCreate}
            onDraftChange={onMobileCreateDraftChange}
            onSubmit={submitMobile}
          />
        </div>
      ) : null}

      {mobileEditItem ? (
        <InboxDetailEditor
          key={`mobile-${mobileEditItem.id}`}
          item={mobileEditItem}
          titleDraft={titleDrafts[mobileEditItem.id]}
          mode="mobile"
          onClose={() => setMobileEditItemId(null)}
          onTitleDraftChange={setTitleDraft}
          onAutosaveDetails={onAutosaveDetails}
        />
      ) : null}
    </section>
  );
}

function InboxRow({
  item,
  selected,
  onSelect,
  onEditMobile,
  onUpdateTitle,
  onDelete,
  titleDraft,
  onTitleDraftChange,
  deleteOpen,
  onOpenDelete,
  onCloseDelete,
}: {
  item: InboxItem;
  selected: boolean;
  onSelect: (detailTitleFocus?: DetailTitleFocus) => void;
  onEditMobile: (item: InboxItem) => void;
  onUpdateTitle: (item: InboxItem, title: string) => Promise<void>;
  onDelete: (item: InboxItem) => Promise<void>;
  titleDraft?: string;
  onTitleDraftChange: (itemId: string, title: string | null) => void;
  deleteOpen: boolean;
  onOpenDelete: () => void;
  onCloseDelete: () => void;
}) {
  const title = titleDraft ?? item.title;
  const preview = visibleDescriptionPreview(item.description_md);
  const typeIconId = useId();
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [removing, setRemoving] = useState(false);
  const tapStartRef = useRef<{ x: number; y: number } | null>(null);
  const actionControlOpen = deleteOpen || dragging;
  const swipeHandlers = useSwipeable({
    onSwiping: (data) => {
      if (!isMobileNavigationViewport()) return;
      if (data.dir !== "Left" && data.dir !== "Right") return;
      setDragging(true);
      setDragX(Math.max(-ACTION_DELETE_REVEAL_WIDTH, Math.min(0, data.deltaX)));
    },
    onSwipedLeft: (data) => {
      if (!isMobileNavigationViewport()) return;
      if (data.absX >= 28) onOpenDelete();
    },
    onSwipedRight: () => {
      if (!isMobileNavigationViewport()) return;
      onCloseDelete();
    },
    onSwiped: () => {
      setDragging(false);
      setDragX(0);
    },
    delta: 8,
    preventScrollOnSwipe: false,
    trackMouse: false,
    touchEventOptions: { passive: false },
  });
  const { ref: swipeRef, ...rowSwipeHandlers } = swipeHandlers;

  async function requestDelete() {
    if (removing) return;
    onCloseDelete();
    await onDelete(item);
    setRemoving(true);
  }

  function isRowServiceTarget(target: EventTarget | null, rowSurface: Element) {
    const service = target instanceof Element ? target.closest(ACTION_ROW_SERVICE_SELECTOR) : null;
    return service !== null && service !== rowSurface;
  }

  function openDetails() {
    if (isMobileNavigationViewport()) {
      onEditMobile(item);
      return;
    }
    onSelect("end");
  }

  function openDetailsFromRow(event: MouseEvent<HTMLDivElement>) {
    if (isRowServiceTarget(event.target, event.currentTarget)) return;
    openDetails();
  }

  function rememberMobileTap(event: PointerEvent<HTMLDivElement>) {
    if (!isMobileNavigationViewport()) return;
    tapStartRef.current = { x: event.clientX, y: event.clientY };
  }

  function openDetailsFromMobileTap(event: PointerEvent<HTMLDivElement>) {
    if (!isMobileNavigationViewport()) return;
    const tapStart = tapStartRef.current;
    tapStartRef.current = null;
    if (!tapStart || dragging || deleteOpen) return;
    if (Math.abs(event.clientX - tapStart.x) > 8 || Math.abs(event.clientY - tapStart.y) > 8) return;
    if (isRowServiceTarget(event.target, event.currentTarget)) return;
    openDetails();
  }

  return (
    <div
      ref={swipeRef}
      className={cx(
        "action-row group relative grid min-h-[54px] max-h-[220px] grid-cols-[minmax(0,1fr)_44px] items-stretch overflow-hidden border-b border-border transition-[max-height,opacity,border-color,box-shadow] duration-150 [&:has(+_.action-row.selected)]:border-b-transparent max-[860px]:grid-cols-[minmax(0,1fr)_46px] max-[860px]:select-none max-[860px]:[touch-action:pan-y]",
        item.pending && "pending opacity-80",
        deleteOpen && "delete-open",
        dragging && "dragging",
        removing && "removing pointer-events-none max-h-0 border-b-transparent opacity-0",
        selected && "selected rounded-lg border-b-transparent bg-primary/10",
      )}
      data-nav-swipe-exclusion
      data-action-row
      {...rowSwipeHandlers}
    >
      <div
        className="action-row-surface grid min-h-[54px] min-w-0 grid-cols-[38px_minmax(0,1fr)] items-center gap-x-1.5 py-2.5 transition-transform duration-150 will-change-transform max-[860px]:min-h-[54px] max-[860px]:py-[9px]"
        onClick={openDetailsFromRow}
        onPointerDownCapture={rememberMobileTap}
        onPointerUpCapture={openDetailsFromMobileTap}
        style={{
          transform: `translate3d(${dragX}px, 0, 0)`,
          transition: dragging ? "none" : undefined,
        }}
      >
        <span className="action-checkbox-cell flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground" data-action-row-service aria-labelledby={typeIconId}>
          <InboxTypeIcon id={item.id} />
          <span id={typeIconId} className="sr-only">Тип входящего</span>
        </span>
        <div className="action-main flex min-w-0 flex-1 flex-col gap-1">
          <InboxTitleEditor
            item={item}
            title={title}
            onSelect={onSelect}
            onEditMobile={onEditMobile}
            onUpdateTitle={onUpdateTitle}
            onTitleDraftChange={onTitleDraftChange}
          />
          {preview ? (
            <p
              className="action-description-preview block min-w-0 max-w-full overflow-hidden whitespace-nowrap text-xs/5 font-normal text-muted-foreground/70"
              style={{
                WebkitMaskImage: "linear-gradient(to right, #000 calc(100% - 44px), transparent)",
                maskImage: "linear-gradient(to right, #000 calc(100% - 44px), transparent)",
              }}
            >
              {preview}
            </p>
          ) : null}
        </div>
      </div>
      <button
        type="button"
        className={cx(
          "action-delete-button grid min-h-[54px] w-11 place-items-center border-0 bg-transparent text-destructive transition duration-150 hover:opacity-70 focus-visible:opacity-70 focus-visible:outline-0 max-[860px]:w-[46px]",
          actionControlOpen ? "visible pointer-events-auto scale-100 opacity-[0.42]" : "invisible pointer-events-none scale-[0.96] opacity-0",
          "group-hover:visible group-hover:pointer-events-auto group-hover:scale-100 group-hover:opacity-[0.42] group-focus-within:visible group-focus-within:pointer-events-auto group-focus-within:scale-100 group-focus-within:opacity-[0.42]",
        )}
        data-action-row-control
        aria-label={`Удалить: ${title}`}
        title="Удалить"
        disabled={removing}
        onClick={(event) => {
          event.stopPropagation();
          void requestDelete();
        }}
      >
        <Trash2 aria-hidden="true" />
      </button>
    </div>
  );
}

function InboxTitleEditor({
  item,
  title,
  onSelect,
  onEditMobile,
  onUpdateTitle,
  onTitleDraftChange,
}: {
  item: InboxItem;
  title: string;
  onSelect: (detailTitleFocus?: DetailTitleFocus) => void;
  onEditMobile: (item: InboxItem) => void;
  onUpdateTitle: (item: InboxItem, title: string) => Promise<void>;
  onTitleDraftChange: (itemId: string, title: string | null) => void;
}) {
  const titleRef = useRef<HTMLSpanElement | null>(null);

  useLayoutEffect(() => {
    if (!titleRef.current || document.activeElement === titleRef.current) return;
    titleRef.current.textContent = title;
  }, [title]);

  function resetTitle() {
    onTitleDraftChange(item.id, null);
    if (titleRef.current) titleRef.current.textContent = item.title;
  }

  async function saveTitle() {
    const nextTitle = cleanTitle(titleRef.current?.textContent ?? "");
    if (!nextTitle) {
      resetTitle();
      return;
    }
    onTitleDraftChange(item.id, nextTitle === item.title ? null : nextTitle);
    if (nextTitle !== item.title) await onUpdateTitle(item, nextTitle);
  }

  function onClick(event: MouseEvent<HTMLSpanElement>) {
    event.stopPropagation();
    if (isMobileNavigationViewport()) {
      event.preventDefault();
      onEditMobile(item);
      return;
    }
    onSelect(null);
  }

  function onInput() {
    titleRef.current?.animate?.([{ opacity: 0.72 }, { opacity: 1 }], { duration: 140, easing: "ease-out" });
    const nextTitle = limitTitle(titleRef.current?.textContent ?? "");
    if (titleRef.current && titleRef.current.textContent !== nextTitle) titleRef.current.textContent = nextTitle;
    onTitleDraftChange(item.id, nextTitle);
  }

  function onKeyDown(event: KeyboardEvent<HTMLSpanElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      titleRef.current?.blur();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      resetTitle();
      titleRef.current?.blur();
    }
  }

  return (
    <span
      ref={titleRef}
      className="action-title block max-h-12 min-w-0 overflow-hidden text-base/6 no-underline [overflow-wrap:anywhere] focus:text-primary focus:outline-0"
      data-title-fade
      style={{
        WebkitMaskImage: "linear-gradient(to bottom, #000 calc(100% - 12px), transparent)",
        maskImage: "linear-gradient(to bottom, #000 calc(100% - 12px), transparent)",
      }}
      contentEditable={!isMobileNavigationViewport()}
      suppressContentEditableWarning
      tabIndex={0}
      role="textbox"
      aria-label={`Название входящего: ${title}`}
      onClick={onClick}
      onInput={onInput}
      onBlur={() => void saveTitle()}
      onKeyDown={onKeyDown}
    />
  );
}

function InboxDetailEditor({
  item,
  titleDraft,
  mode,
  focusTitleRequest = 0,
  onClose,
  onTitleDraftChange,
  onAutosaveDetails,
}: {
  item: InboxItem;
  titleDraft?: string;
  mode: "desktop" | "mobile";
  focusTitleRequest?: number;
  onClose: () => void;
  onTitleDraftChange: (itemId: string, title: string | null) => void;
  onAutosaveDetails: (item: InboxItem, title: string, descriptionMd: string) => Promise<void>;
}) {
  const [description, setDescription] = useState(normalizeDescription(item.description_md));
  const [markdownPreview, setMarkdownPreview] = useState(loadActivityMarkdownPreviewMode);
  const [activeTab, setActiveTab] = useState<DetailPanelTab>("info");
  const titleValue = limitTitle(titleDraft ?? item.title);
  const titleRemaining = TITLE_MAX_LENGTH - titleValue.length;
  const showTitleCounter = titleRemaining <= TITLE_COUNTER_THRESHOLD;
  const titleRef = useRef<HTMLTextAreaElement | null>(null);
  const descriptionRef = useRef<HTMLDivElement | null>(null);
  const latestRef = useRef<{ title: string; descriptionMd: string } | null>(null);
  const timerRef = useRef<number | null>(null);
  const maxTimerRef = useRef<number | null>(null);
  const itemRef = useRef(item);
  const autosaveRef = useRef(onAutosaveDetails);
  const suppressPopRef = useRef(false);
  const {
    backdropRef,
    backdropStyle,
    closeWithAnimation,
    resetOpen,
    sheetDragHandlers,
    sheetRef,
    sheetStyle: mobileSheetStyle,
  } = useMobileSheetDrag({
    enabled: mode === "mobile",
    onClose: closeEditor,
  });
  const mobileSheetTop = useMobileSheetTop();

  useEffect(() => {
    if (!titleRef.current) return;
    if (mode !== "mobile" && focusTitleRequest === 0) return;
    titleRef.current.focus();
    titleRef.current.setSelectionRange(titleRef.current.value.length, titleRef.current.value.length);
  }, [item.id, focusTitleRequest, mode]);

  useEffect(() => {
    if (markdownPreview || document.activeElement === descriptionRef.current) return;
    setPlainEditableText(descriptionRef.current, description);
  }, [activeTab, description, item.id, markdownPreview]);

  useLayoutEffect(() => {
    fitTextareaHeight(titleRef.current);
  }, [activeTab, mode, titleValue]);

  useEffect(() => {
    const node = titleRef.current;
    if (!node || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => fitTextareaHeight(node));
    observer.observe(node);
    return () => observer.disconnect();
  }, [activeTab]);

  useEffect(() => {
    if (latestRef.current) return;
    const nextDescription = normalizeDescription(item.description_md);
    setDescription((current) => (current === nextDescription ? current : nextDescription));
  }, [item.description_md, item.id]);

  useEffect(() => {
    itemRef.current = item;
    autosaveRef.current = onAutosaveDetails;
  });

  const clearTimers = useCallback(() => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    if (maxTimerRef.current != null) window.clearTimeout(maxTimerRef.current);
    timerRef.current = null;
    maxTimerRef.current = null;
  }, []);

  const flush = useCallback(() => {
    if (!latestRef.current) return;
    const next = latestRef.current;
    latestRef.current = null;
    clearTimers();
    void autosaveRef.current(itemRef.current, next.title, next.descriptionMd);
  }, [clearTimers]);

  useEffect(() => {
    function flushOnHide() {
      flush();
    }

    window.addEventListener("pagehide", flushOnHide);
    document.addEventListener("visibilitychange", flushOnHide);
    return () => {
      window.removeEventListener("pagehide", flushOnHide);
      document.removeEventListener("visibilitychange", flushOnHide);
      flush();
    };
  }, [flush]);

  useEffect(() => {
    if (mode !== "mobile") return undefined;
    resetOpen();
    window.history.pushState({ ...window.history.state, brightInboxEditor: item.id }, "", window.location.href);

    function onPopState() {
      flush();
      if (suppressPopRef.current) {
        suppressPopRef.current = false;
        return;
      }
      closeWithAnimation();
    }

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [flush, item.id, closeWithAnimation, mode, resetOpen]);

  useEffect(() => {
    if (mode !== "mobile") return undefined;
    return installAndroidBackHandler(() => {
      closeWithAnimation();
      return true;
    });
  }, [closeWithAnimation, mode]);

  function schedule(nextTitle: string, nextDescription: string) {
    const limitedTitle = limitTitle(nextTitle);
    onTitleDraftChange(item.id, limitedTitle === item.title ? null : limitedTitle);
    latestRef.current = { title: limitedTitle, descriptionMd: nextDescription };
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(flush, 600);
    if (maxTimerRef.current == null) maxTimerRef.current = window.setTimeout(flush, 2000);
  }

  function setPreviewMode(checked: boolean) {
    saveActivityMarkdownPreviewMode(checked);
    setMarkdownPreview(checked);
    if (checked) flush();
  }

  function closeEditor() {
    flush();
    if (mode === "mobile" && window.history.state?.brightInboxEditor === item.id) {
      suppressPopRef.current = true;
      window.history.back();
    }
    onClose();
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (mode === "mobile") {
        closeWithAnimation();
      } else {
        closeEditor();
      }
    }
  }

  function onTitleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    schedule(cleanTitle(event.currentTarget.value), description);
    if (activeTab === "info" && !markdownPreview && descriptionRef.current) {
      focusEditableEnd(descriptionRef.current);
    } else {
      event.currentTarget.blur();
    }
  }

  const PreviewModeIcon = markdownPreview ? Pencil : BookOpen;
  const previewModeLabel = markdownPreview ? "Редактировать описание" : "Читать описание";
  const previewToggle = activeTab === "info" ? (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className="actions-detail-preview-toggle absolute right-0 top-3 z-[1] text-muted-foreground hover:text-foreground"
      aria-label={previewModeLabel}
      aria-pressed={markdownPreview}
      title={previewModeLabel}
      onClick={() => setPreviewMode(!markdownPreview)}
    >
      <PreviewModeIcon aria-hidden="true" />
    </Button>
  ) : null;
  const detailDescription = (
    <div className="min-h-full w-full min-w-0 px-0 pb-6 pt-3">
      <DetailAttachments links={item.attachment_links} />
      <div className="relative min-w-0">
        {markdownPreview ? (
          <div
            className="actions-detail-description actions-detail-description-preview relative min-h-full w-full min-w-0 before:float-right before:h-10 before:w-12 before:content-['']"
            aria-label="MD просмотр описания входящего"
          >
            {previewToggle}
            {visibleDescriptionPreview(description) ? (
              hasMarkdownSyntax(description) ? (
                <MarkdownContent source={markdownPreviewSource(description)} />
              ) : (
                <div className="whitespace-pre-wrap text-sm font-normal leading-[1.48] tracking-normal text-foreground max-[860px]:text-base">
                  {description}
                </div>
              )
            ) : (
              <p className="m-0 text-sm font-normal leading-[1.48] text-muted-foreground/55">Введите описание</p>
            )}
          </div>
        ) : (
          <>
            {previewToggle}
            <div
              ref={descriptionRef}
              className="actions-detail-description actions-detail-description-editor relative block min-h-full w-full min-w-0 overflow-hidden whitespace-pre-wrap border-0 bg-transparent p-0 text-sm font-normal leading-[1.48] tracking-normal text-foreground [overflow-wrap:anywhere] before:float-right before:h-10 before:w-12 before:content-[''] empty:after:text-muted-foreground/55 empty:after:content-[attr(data-placeholder)] focus:outline-0 max-[860px]:text-base"
              contentEditable="plaintext-only"
              data-placeholder="Введите описание"
              aria-label="Описание входящего"
              aria-multiline="true"
              role="textbox"
              suppressContentEditableWarning
              onInput={(event) => {
                const nextDescription = plainEditableText(event.currentTarget);
                setDescription(nextDescription);
                schedule(titleValue, nextDescription);
              }}
            />
          </>
        )}
      </div>
    </div>
  );
  const detailContent =
    activeTab === "history" ? (
      <DetailHistory kind="inbox" item={item} />
    ) : activeTab === "details" ? (
      <DetailFields kind="inbox" item={item} />
    ) : activeTab === "db" ? (
      <DetailDbReference kind="inbox" />
    ) : (
      <DetailEmptyTab />
    );
  const closeButton = (
    <button
      type="button"
      className={cx(
        "actions-detail-close grid place-items-center rounded-full leading-none",
        mode === "desktop" && "h-[34px] w-[34px] border border-border bg-secondary text-foreground",
        mode === "mobile" && "fixed bottom-[calc(20px+env(safe-area-inset-bottom))] right-[18px] z-[2] h-[58px] w-[58px] border-0 bg-primary text-primary-foreground shadow-lg",
      )}
      aria-label={mode === "mobile" ? "Сохранить и закрыть" : "Закрыть редактор"}
      title={mode === "mobile" ? "Сохранить" : "Закрыть"}
      onClick={mode === "mobile" ? closeWithAnimation : closeEditor}
    >
      <X className={mode === "mobile" ? "h-7 w-7" : "h-4 w-4"} aria-hidden="true" />
    </button>
  );
  const detailTitle = (
    <div className="actions-detail-title-block relative mb-2 mt-6 grid min-w-0">
      <textarea
        ref={titleRef}
        className={cx(
          "actions-detail-title block w-full min-w-0 resize-none overflow-hidden border-0 bg-transparent p-0 pb-4 font-semibold leading-[1.18] tracking-normal text-foreground [overflow-wrap:anywhere] focus:outline-0",
          mode === "mobile" ? "min-h-0 text-xl" : "min-h-11 text-2xl",
        )}
        value={titleValue}
        rows={1}
        maxLength={TITLE_MAX_LENGTH}
        aria-label="Название входящего"
        onChange={(event) => schedule(limitTitle(event.target.value), description)}
        onKeyDown={onTitleKeyDown}
      />
      {showTitleCounter ? (
        <div
          className={cx(
            "actions-detail-title-counter absolute bottom-0 right-0 text-xs font-normal leading-4 tracking-normal",
            titleRemaining === 0 ? "text-destructive" : "text-muted-foreground/60",
          )}
          aria-label="Осталось символов в заголовке"
        >
          {titleRemaining}
        </div>
      ) : null}
    </div>
  );
  const infoChromeInset = mode === "mobile" ? "pl-[18px] pr-5" : "pl-7 pr-5";
  const infoScrollInset = mode === "mobile" ? "pl-[18px] pr-5" : "pl-7 pr-7";
  const dragHeader = (
    <header
      className={cx(
        "actions-detail-header flex items-center gap-3",
        mode === "desktop" && "min-h-9 justify-end",
        mode === "mobile" && "relative h-3 min-h-3 justify-center pt-0",
        activeTab === "info" && infoChromeInset,
      )}
    >
      {mode === "mobile" ? (
        <div className="actions-detail-drag-zone absolute left-1/2 top-0 flex h-3 w-32 -translate-x-1/2 touch-none cursor-grab items-start justify-center pt-0.5 active:cursor-grabbing">
          <span className="actions-detail-grabber h-1 w-11 rounded-full bg-muted-foreground/30" aria-hidden="true" />
        </div>
      ) : null}
      {closeButton}
    </header>
  );
  const editorBody = activeTab === "info" ? (
    <>
      {dragHeader}
      <div className={infoChromeInset}>
        <DetailPanelTabBar activeTab={activeTab} className="mt-0" onChange={setActiveTab} />
      </div>
      <ScrollArea className="actions-detail-description-scroll min-h-0 w-full min-w-0" role="tabpanel">
        <div className={cx("min-h-full w-full min-w-0", infoScrollInset)}>
          {detailTitle}
          <div className="h-px bg-border" aria-hidden="true" />
          {detailDescription}
        </div>
      </ScrollArea>
    </>
  ) : (
    <>
      {dragHeader}
      <DetailPanelTabBar activeTab={activeTab} className="mt-0" onChange={setActiveTab} />
      {detailTitle}
      <div className="h-px bg-border" aria-hidden="true" />
      {detailContent}
    </>
  );
  const panelRows = activeTab === "info" ? "grid-rows-[auto_auto_minmax(0,1fr)]" : "grid-rows-[auto_auto_auto_auto_minmax(0,1fr)]";
  const panelPadding = activeTab === "info" ? "px-0" : mode === "mobile" ? "px-[18px]" : "pl-7 pr-7";

  if (mode === "mobile") {
    return (
      <div className="actions-detail-backdrop fixed inset-0 z-[84] hidden max-[860px]:block" data-nav-swipe-exclusion>
        <div ref={backdropRef} className="absolute inset-0 bg-foreground/20 dark:bg-background/80" style={backdropStyle} aria-hidden="true" />
        <aside
          ref={sheetRef}
          className={cx("actions-detail-panel mobile absolute inset-x-0 bottom-0 top-[env(safe-area-inset-top)] z-[1] grid min-h-0 min-w-0 gap-0 overflow-hidden rounded-t-2xl border-t border-border bg-card pb-[env(safe-area-inset-bottom)] pt-1 shadow-xl animate-[mobile-detail-sheet-in_180ms_ease-out] will-change-transform", panelRows, panelPadding)}
          style={{ ...mobileSheetStyle, top: mobileSheetTop } as CSSProperties}
          aria-label="Редактирование входящего"
          onKeyDown={onKeyDown}
          {...sheetDragHandlers}
        >
          {editorBody}
        </aside>
      </div>
    );
  }

  return (
    <aside
      className={cx("actions-detail-panel desktop grid h-full min-h-0 min-w-0 gap-0 overflow-hidden max-[860px]:hidden", panelRows, panelPadding)}
      aria-label="Редактирование входящего"
      data-nav-swipe-exclusion
      onKeyDown={onKeyDown}
    >
      {editorBody}
    </aside>
  );
}

function InboxTypeIcon({ id }: { id: string }) {
  const className = "h-[18px] w-[18px]";
  switch (inboxTypeIndex(id)) {
    case 0:
      return <Inbox className={className} aria-hidden="true" />;
    case 1:
      return <Mail className={className} aria-hidden="true" />;
    case 2:
      return <MessageSquare className={className} aria-hidden="true" />;
    case 3:
      return <FileText className={className} aria-hidden="true" />;
    case 4:
      return <Link2 className={className} aria-hidden="true" />;
    default:
      return <Sparkles className={className} aria-hidden="true" />;
  }
}

function inboxTypeIndex(id: string) {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) | 0;
  return Math.abs(hash) % 6;
}
