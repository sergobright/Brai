"use client";

import type { CSSProperties, KeyboardEvent } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { BookOpen, Pencil } from "lucide-react";
import { installAndroidBackHandler } from "@/shared/platform/platform";
import {
  cleanTitle,
  limitTitle,
  markdownPreviewSource,
  TITLE_COUNTER_THRESHOLD,
  TITLE_MAX_LENGTH,
  visibleDescriptionPreview,
} from "@/shared/activities/text";
import type { ActivityItem } from "@/shared/types/activities";
import { Button } from "@/shared/ui/button";
import { hasMarkdownSyntax, MarkdownContent } from "@/shared/ui/markdown-content";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { cx, fitTextareaHeight, focusEditableEnd, plainEditableText, setPlainEditableText } from "../../appUtils";
import { useMobileSheetDrag } from "../../hooks/useMobileSheetDrag";
import { useMobileSheetTop } from "../../hooks/useMobileSheetTop";
import {
  DetailDbReference,
  DetailEmptyTab,
  DetailFields,
  DetailHistory,
  DetailPanelTabBar,
  type DetailPanelTab,
} from "../DetailPanelTabs";
import { activityDraftValues, scheduleActivityDraftEdit, useActivityDraftAutosave } from "./activityDetailModel";
import { loadActivityMarkdownPreviewMode, saveActivityMarkdownPreviewMode } from "./constants";

export function ActivityDetailEditor({
  action,
  titleDraft,
  mode,
  focusTitleRequest = 0,
  onClose,
  onTitleDraftChange = () => undefined,
  onAutosaveDetails,
}: {
  action: ActivityItem;
  titleDraft?: string;
  mode: "desktop" | "mobile";
  focusTitleRequest?: number;
  onClose: () => void;
  onTitleDraftChange?: (actionId: string, title: string | null) => void;
  onAutosaveDetails: (action: ActivityItem, title: string, descriptionMd: string) => Promise<void>;
}) {
  const initial = activityDraftValues(action);
  const title = limitTitle(titleDraft ?? initial.title);
  const titleRemaining = TITLE_MAX_LENGTH - title.length;
  const showTitleCounter = titleRemaining <= TITLE_COUNTER_THRESHOLD;
  const [description, setDescription] = useState(initial.descriptionMd);
  const [markdownPreview, setMarkdownPreview] = useState(loadActivityMarkdownPreviewMode);
  const [activeTab, setActiveTab] = useState<DetailPanelTab>("info");
  const titleRef = useRef<HTMLTextAreaElement | null>(null);
  const descriptionRef = useRef<HTMLDivElement | null>(null);
  const autosave = useActivityDraftAutosave(action, onAutosaveDetails);
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
    const end = titleRef.current.value.length;
    titleRef.current.setSelectionRange(end, end);
  }, [action.id, focusTitleRequest, mode]);

  useEffect(() => {
    if (markdownPreview || document.activeElement === descriptionRef.current) return;
    setPlainEditableText(descriptionRef.current, description);
  }, [action.id, activeTab, description, markdownPreview]);

  useLayoutEffect(() => {
    fitTextareaHeight(titleRef.current);
  }, [activeTab, mode, title]);

  useEffect(() => {
    const node = titleRef.current;
    if (!node || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => fitTextareaHeight(node));
    observer.observe(node);
    return () => observer.disconnect();
  }, [activeTab]);

  useEffect(() => {
    function flushOnHide() {
      autosave.flush();
    }

    window.addEventListener("pagehide", flushOnHide);
    document.addEventListener("visibilitychange", flushOnHide);
    return () => {
      window.removeEventListener("pagehide", flushOnHide);
      document.removeEventListener("visibilitychange", flushOnHide);
      autosave.flush();
    };
  }, [autosave]);

  useEffect(() => {
    if (mode !== "mobile") return undefined;
    resetOpen();
    window.history.pushState({ ...window.history.state, brightActivityEditor: action.id }, "", window.location.href);

    function onPopState() {
      autosave.flush();
      if (suppressPopRef.current) {
        suppressPopRef.current = false;
        return;
      }
      closeWithAnimation();
    }

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [action.id, autosave, closeWithAnimation, mode, resetOpen]);

  function schedule(nextTitle: string, nextDescription: string) {
    scheduleActivityDraftEdit(action, limitTitle(nextTitle), nextDescription, onTitleDraftChange, autosave);
  }

  function setPreviewMode(checked: boolean) {
    saveActivityMarkdownPreviewMode(checked);
    setMarkdownPreview(checked);
    if (checked) autosave.flush();
  }

  function closeEditor() {
    autosave.flush();
    if (mode === "mobile" && window.history.state?.brightActivityEditor === action.id) {
      suppressPopRef.current = true;
      window.history.back();
    }
    onClose();
  }

  useEffect(() => {
    if (mode !== "mobile") return undefined;
    return installAndroidBackHandler(() => {
      closeWithAnimation();
      return true;
    });
  }, [closeWithAnimation, mode]);

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
    <div className="min-h-full w-full min-w-0 pb-6 pt-3">
      {markdownPreview ? (
        <div
          className="actions-detail-description actions-detail-description-preview relative min-h-full w-full min-w-0 before:float-right before:h-10 before:w-12 before:content-['']"
          aria-label="MD просмотр описания действия"
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
            <p className="m-0 text-sm font-normal leading-[1.48] text-muted-foreground/55">
              Введите описание
            </p>
          )}
        </div>
      ) : (
        <div className="relative min-w-0">
          {previewToggle}
          <div
            ref={descriptionRef}
            className="actions-detail-description actions-detail-description-editor relative block min-h-full w-full min-w-0 overflow-hidden whitespace-pre-wrap border-0 bg-transparent p-0 text-sm font-normal leading-[1.48] tracking-normal text-foreground [overflow-wrap:anywhere] before:float-right before:h-10 before:w-12 before:content-[''] empty:after:text-muted-foreground/55 empty:after:content-[attr(data-placeholder)] focus:outline-0 max-[860px]:text-base"
            contentEditable="plaintext-only"
            data-placeholder="Введите описание"
            aria-label="Описание действия"
            aria-multiline="true"
            role="textbox"
            suppressContentEditableWarning
            onInput={(event) => {
              const nextDescription = plainEditableText(event.currentTarget);
              setDescription(nextDescription);
              schedule(title, nextDescription);
            }}
          />
        </div>
      )}
    </div>
  );
  const detailContent =
    activeTab === "history" ? (
      <DetailHistory kind="actions" item={action} />
    ) : activeTab === "details" ? (
      <DetailFields kind="actions" item={action} />
    ) : activeTab === "db" ? (
      <DetailDbReference kind="actions" />
    ) : (
      <DetailEmptyTab />
    );
  const closeButton = (
    <button
      type="button"
      className={cx(
        "actions-detail-close grid place-items-center rounded-full text-xl leading-none",
        mode === "desktop" &&
          "h-[34px] w-[34px] border border-border bg-secondary text-foreground",
        mode === "mobile" &&
          "fixed bottom-[calc(20px+env(safe-area-inset-bottom))] right-[18px] z-[2] h-[58px] w-[58px] border-0 bg-primary text-2xl font-semibold text-primary-foreground shadow-lg",
      )}
      aria-label={mode === "mobile" ? "Сохранить и закрыть" : "Закрыть редактор"}
      title={mode === "mobile" ? "Сохранить" : "Закрыть"}
      onClick={mode === "mobile" ? closeWithAnimation : closeEditor}
    >
      {mode === "mobile" ? "✓" : "×"}
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
        value={title}
        rows={1}
        maxLength={TITLE_MAX_LENGTH}
        aria-label="Название действия"
        onChange={(event) => {
          schedule(limitTitle(event.target.value), description);
        }}
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
        <div
          className="actions-detail-drag-zone absolute left-1/2 top-0 z-[3] flex h-3 w-32 -translate-x-1/2 touch-none cursor-grab items-start justify-center pt-0.5 active:cursor-grabbing"
        >
          <span
            className="actions-detail-grabber h-1 w-11 rounded-full bg-muted-foreground/30"
            aria-hidden="true"
          />
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
          aria-label="Редактирование действия"
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
      aria-label="Редактирование действия"
      data-nav-swipe-exclusion
      onKeyDown={onKeyDown}
    >
      {editorBody}
    </aside>
  );
}
