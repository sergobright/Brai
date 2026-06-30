"use client";

import type { FormEvent, KeyboardEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Archive, CalendarDays, Ellipsis, Flag, Maximize2, Plus, Tag } from "lucide-react";
import { cleanTitle, limitTitle, normalizeDescription, TITLE_MAX_LENGTH } from "@/shared/activities/text";
import { Button } from "@/shared/ui/button";
import { useMobileSheetDrag } from "../hooks/useMobileSheetDrag";
import { cx, fitTextareaHeight } from "../appUtils";

export interface MobileCreateDraft {
  title: string;
  descriptionMd: string;
}

const MOBILE_CREATE_AUTOFOCUS_DELAY_MS = 130;

const MOBILE_CREATE_TOOL_ICONS = [
  ["calendar", "Дата", CalendarDays],
  ["flag", "Флаг", Flag],
  ["tag", "Тег", Tag],
  ["archive", "Архив", Archive],
  ["expand", "Развернуть", Maximize2],
  ["more", "Еще", Ellipsis],
] as const;

export function mobileCreateDraftHasText(draft: MobileCreateDraft) {
  return Boolean(draft.title.trim() || draft.descriptionMd.trim());
}

export function MobileCreateComposer({
  draft,
  descriptionLabel,
  submitLabel,
  titleLabel,
  onCancel,
  onDraftChange,
  onSubmit,
}: {
  draft: MobileCreateDraft;
  descriptionLabel: string;
  submitLabel: string;
  titleLabel: string;
  onCancel: () => void;
  onDraftChange: (draft: MobileCreateDraft) => void;
  onSubmit: (title: string, descriptionMd: string) => Promise<void>;
}) {
  const [descriptionActive, setDescriptionActive] = useState(false);
  const formRef = useRef<HTMLFormElement | null>(null);
  const textScrollRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLTextAreaElement | null>(null);
  const descriptionRef = useRef<HTMLTextAreaElement | null>(null);
  const { sheetDragHandlers, sheetRef, sheetStyle } = useMobileSheetDrag({ onClose: onCancel });
  const canSubmit = Boolean(cleanTitle(draft.title));

  const setFormRef = useCallback((node: HTMLFormElement | null) => {
    formRef.current = node;
    sheetRef(node);
  }, [sheetRef]);

  useEffect(() => {
    const delay = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : MOBILE_CREATE_AUTOFOCUS_DELAY_MS;
    const timer = window.setTimeout(() => {
      const input = titleRef.current;
      if (!input) return;
      const activeElement = document.activeElement;
      if (activeElement && formRef.current?.contains(activeElement) && activeElement !== input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }, delay);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    fitTextareaHeight(titleRef.current);
    fitTextareaHeight(descriptionRef.current);
    window.requestAnimationFrame(() => scrollActiveFieldIntoView(textScrollRef.current));
  }, [draft.descriptionMd, draft.title]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = cleanTitle(draft.title);
    if (!trimmed) return;
    await onSubmit(trimmed, normalizeDescription(draft.descriptionMd));
  }

  function onTitleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      descriptionRef.current?.focus();
    }
  }

  function onDescriptionKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    onCancel();
  }

  return (
    <form
      ref={setFormRef}
      className="actions-mobile-editor flex max-h-full w-full flex-col overflow-hidden rounded-t-2xl bg-card px-5 pb-1 pt-2 shadow-xl motion-safe:animate-[mobile-detail-sheet-in_180ms_ease-out] motion-safe:will-change-transform"
      style={sheetStyle}
      onClick={(event) => event.stopPropagation()}
      onSubmit={submit}
      {...sheetDragHandlers}
    >
      <div className="mobile-create-drag-zone flex h-6 shrink-0 touch-none cursor-grab items-start justify-center pt-1.5 active:cursor-grabbing">
        <span className="mobile-create-grabber h-1 w-11 rounded-full bg-muted-foreground/30" aria-hidden="true" />
      </div>
      <div
        ref={textScrollRef}
        className="mobile-create-text max-h-[calc(100dvh_-_env(safe-area-inset-top)_-_92px)] min-h-[76px] min-w-0 overflow-y-auto overscroll-contain"
        data-slot="scroll-area-viewport"
      >
        <textarea
          ref={titleRef}
          className="actions-mobile-create-title block min-h-6 w-full min-w-0 resize-none overflow-hidden border-0 bg-transparent p-0 text-lg/7 font-semibold tracking-normal text-foreground placeholder:text-muted-foreground/65 focus:outline-0"
          value={limitTitle(draft.title)}
          rows={1}
          maxLength={TITLE_MAX_LENGTH}
          enterKeyHint="enter"
          placeholder="Что бы вы хотели сделать?"
          aria-label={titleLabel}
          onChange={(event) => onDraftChange({ ...draft, title: limitTitle(event.target.value) })}
          onKeyDown={onTitleKeyDown}
        />
        <textarea
          ref={descriptionRef}
          className="actions-mobile-create-description mt-1.5 block min-h-10 w-full min-w-0 resize-none overflow-hidden border-0 bg-transparent p-0 text-sm/5 font-normal tracking-normal text-muted-foreground/75 placeholder:text-muted-foreground/60 focus:outline-0"
          value={draft.descriptionMd}
          rows={2}
          enterKeyHint="enter"
          placeholder={descriptionActive || draft.descriptionMd ? "Описание" : ""}
          aria-label={descriptionLabel}
          onFocus={() => setDescriptionActive(true)}
          onChange={(event) => onDraftChange({ ...draft, descriptionMd: event.target.value })}
          onKeyDown={onDescriptionKeyDown}
        />
      </div>
      <div className="mobile-create-toolbar mt-2 flex h-9 shrink-0 items-center justify-between gap-3 text-muted-foreground">
        <div className="flex min-w-0 items-center gap-2.5">
          {MOBILE_CREATE_TOOL_ICONS.map(([name, label, Icon]) => (
            <button
              key={name}
              type="button"
              className="mobile-create-tool-icon inline-grid size-7 place-items-center rounded-md border-0 bg-transparent text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-0 focus-visible:ring-[3px] focus-visible:ring-ring/50 active:bg-accent/80 active:text-foreground"
              aria-label={label}
              title={label}
              onPointerDown={(event) => event.preventDefault()}
            >
              <Icon className="size-5" />
            </button>
          ))}
        </div>
        <Button
          type="submit"
          variant="ghost"
          size="icon-sm"
          className={cx(
            "actions-add-submit rounded-full",
            canSubmit ? "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground" : "bg-secondary text-muted-foreground",
          )}
          aria-label={submitLabel}
          title={submitLabel}
          disabled={!canSubmit}
        >
          <Plus aria-hidden="true" />
        </Button>
      </div>
    </form>
  );
}

function scrollActiveFieldIntoView(scrollElement: HTMLDivElement | null) {
  const activeElement = document.activeElement;
  if (!scrollElement || !(activeElement instanceof HTMLTextAreaElement) || !scrollElement.contains(activeElement)) return;
  const nextScrollTop = activeElement.offsetTop + activeElement.offsetHeight - scrollElement.clientHeight;
  scrollElement.scrollTop = Math.max(0, nextScrollTop);
}
