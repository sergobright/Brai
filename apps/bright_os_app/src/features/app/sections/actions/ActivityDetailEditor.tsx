"use client";

import type { KeyboardEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { BookOpen, Pencil } from "lucide-react";
import { installAndroidBackHandler } from "@/shared/platform/platform";
import { cleanTitle, markdownPreviewSource, singleLineTitle, visibleDescriptionPreview } from "@/shared/activities/text";
import type { ActivityItem } from "@/shared/types/activities";
import { Button } from "@/shared/ui/button";
import { hasMarkdownSyntax, MarkdownContent } from "@/shared/ui/markdown-content";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { cx, fitTextareaHeight } from "../../appUtils";
import { useMobileSheetDrag } from "../../hooks/useMobileSheetDrag";
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
  const title = singleLineTitle(titleDraft ?? initial.title);
  const [description, setDescription] = useState(initial.descriptionMd);
  const [markdownPreview, setMarkdownPreview] = useState(loadActivityMarkdownPreviewMode);
  const [activeTab, setActiveTab] = useState<DetailPanelTab>("info");
  const titleRef = useRef<HTMLInputElement | null>(null);
  const descriptionRef = useRef<HTMLTextAreaElement | null>(null);
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

  useEffect(() => {
    if (!titleRef.current) return;
    if (mode !== "mobile" && focusTitleRequest === 0) return;
    titleRef.current.focus();
    const end = titleRef.current.value.length;
    titleRef.current.setSelectionRange(end, end);
  }, [action.id, focusTitleRequest, mode]);

  useEffect(() => {
    if (!markdownPreview) fitTextareaHeight(descriptionRef.current);
  }, [description, markdownPreview, mode]);

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
    scheduleActivityDraftEdit(action, nextTitle, nextDescription, onTitleDraftChange, autosave);
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

  function onTitleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    schedule(cleanTitle(event.currentTarget.value), description);
    if (activeTab === "info" && !markdownPreview && descriptionRef.current) {
      descriptionRef.current.focus();
      const end = descriptionRef.current.value.length;
      descriptionRef.current.setSelectionRange(end, end);
    } else {
      event.currentTarget.blur();
    }
  }

  const PreviewModeIcon = markdownPreview ? Pencil : BookOpen;
  const previewModeLabel = markdownPreview ? "Редактировать описание" : "Читать описание";
  const detailContent =
    activeTab === "info" ? (
      <ScrollArea className="actions-detail-description-scroll min-h-0 w-full min-w-0" role="tabpanel">
        {markdownPreview ? (
          <div
            className="actions-detail-description actions-detail-description-preview min-h-full w-full min-w-0 px-0 pb-6 pt-1"
            aria-label="MD просмотр описания действия"
          >
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
          <textarea
            ref={descriptionRef}
            className="actions-detail-description block min-h-full w-full min-w-0 resize-none overflow-hidden border-0 bg-transparent px-0 pb-6 pt-1 text-sm font-normal leading-[1.48] tracking-normal text-foreground placeholder:text-muted-foreground/55 focus:outline-0 max-[860px]:text-base"
            value={description}
            placeholder="Введите описание"
            aria-label="Описание действия"
            onChange={(event) => {
              setDescription(event.target.value);
              schedule(title, event.target.value);
            }}
          />
        )}
      </ScrollArea>
    ) : activeTab === "history" ? (
      <DetailHistory kind="actions" item={action} />
    ) : activeTab === "details" ? (
      <DetailFields kind="actions" item={action} />
    ) : activeTab === "db" ? (
      <DetailDbReference kind="actions" />
    ) : (
      <DetailEmptyTab />
    );
  const editorBody = (
    <>
      <header
        className={cx(
          "actions-detail-header flex min-h-9 items-center gap-3",
          mode === "desktop" && "justify-end",
          mode === "mobile" && "relative min-h-10 justify-center pt-1",
        )}
      >
        {mode === "mobile" ? (
          <div
            className="actions-detail-drag-zone absolute left-1/2 top-0 z-[3] flex h-8 w-32 -translate-x-1/2 touch-none cursor-grab items-start justify-center pt-2 active:cursor-grabbing"
          >
            <span
              className="actions-detail-grabber h-1.5 w-[50px] rounded-full bg-muted-foreground/30"
              aria-hidden="true"
            />
          </div>
        ) : null}
        {activeTab === "info" ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className={cx("actions-detail-preview-toggle text-muted-foreground hover:text-foreground", mode === "mobile" && "absolute right-0 top-1")}
            aria-label={previewModeLabel}
            aria-pressed={markdownPreview}
            title={previewModeLabel}
            onClick={() => setPreviewMode(!markdownPreview)}
          >
            <PreviewModeIcon aria-hidden="true" />
          </Button>
        ) : null}
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
      </header>
      <input
        ref={titleRef}
        className={cx(
          "actions-detail-title block min-h-11 w-full min-w-0 truncate border-0 bg-transparent p-0 text-2xl font-semibold leading-[1.18] text-foreground tracking-normal focus:outline-0 max-[860px]:min-h-[46px] max-[860px]:text-xl",
        )}
        value={title}
        aria-label="Название действия"
        onChange={(event) => {
          schedule(singleLineTitle(event.target.value), description);
        }}
        onKeyDown={onTitleKeyDown}
      />
      <DetailPanelTabBar activeTab={activeTab} onChange={setActiveTab} />
      {detailContent}
    </>
  );

  if (mode === "mobile") {
    return (
      <div className="actions-detail-backdrop fixed inset-0 z-[84] hidden max-[860px]:block" data-nav-swipe-exclusion>
        <div ref={backdropRef} className="absolute inset-0 bg-foreground/20 dark:bg-background/80" style={backdropStyle} aria-hidden="true" />
        <aside
          ref={sheetRef}
          className="actions-detail-panel mobile absolute inset-x-0 bottom-0 top-[env(safe-area-inset-top)] z-[1] grid min-h-0 min-w-0 grid-rows-[auto_auto_auto_minmax(0,1fr)] gap-3 overflow-hidden rounded-t-2xl border-t border-border bg-card px-[18px] pb-[env(safe-area-inset-bottom)] pt-2 shadow-xl animate-[mobile-detail-sheet-in_180ms_ease-out] will-change-transform"
          style={mobileSheetStyle}
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
      className="actions-detail-panel desktop grid h-full min-h-0 min-w-0 grid-rows-[auto_auto_auto_minmax(0,1fr)] gap-3 overflow-hidden pl-7 pr-7 max-[860px]:hidden"
      aria-label="Редактирование действия"
      data-nav-swipe-exclusion
      onKeyDown={onKeyDown}
    >
      {editorBody}
    </aside>
  );
}
