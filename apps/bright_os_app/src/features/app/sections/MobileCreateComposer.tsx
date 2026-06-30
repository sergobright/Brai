"use client";

import type { FormEvent, KeyboardEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { Archive, CalendarDays, Ellipsis, Flag, Maximize2, Plus, Tag } from "lucide-react";
import { cleanTitle, normalizeDescription, singleLineTitle } from "@/shared/activities/text";
import { Button } from "@/shared/ui/button";
import { cx, fitTextareaHeight } from "../appUtils";

const MOBILE_CREATE_TOOL_ICONS = [
  ["calendar", "Дата", CalendarDays],
  ["flag", "Флаг", Flag],
  ["tag", "Тег", Tag],
  ["archive", "Архив", Archive],
  ["expand", "Развернуть", Maximize2],
  ["more", "Еще", Ellipsis],
] as const;

export function MobileCreateComposer({
  descriptionLabel,
  submitLabel,
  titleLabel,
  onCancel,
  onSubmit,
}: {
  descriptionLabel: string;
  submitLabel: string;
  titleLabel: string;
  onCancel: () => void;
  onSubmit: (title: string, descriptionMd: string) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [descriptionActive, setDescriptionActive] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement | null>(null);
  const descriptionRef = useRef<HTMLTextAreaElement | null>(null);
  const canSubmit = Boolean(cleanTitle(title));

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  useEffect(() => {
    fitTextareaHeight(titleRef.current);
    fitTextareaHeight(descriptionRef.current);
  }, [description, title]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = cleanTitle(title);
    if (!trimmed) return;
    await onSubmit(trimmed, normalizeDescription(description));
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
      className="actions-mobile-editor flex max-h-[calc(100dvh_-_env(safe-area-inset-top)_-_8px)] w-full flex-col overflow-hidden rounded-t-2xl bg-card px-6 pb-2 pt-5 shadow-xl"
      onClick={(event) => event.stopPropagation()}
      onSubmit={submit}
    >
      <div className="mobile-create-text min-h-[84px] min-w-0 overflow-y-auto overscroll-contain">
        <textarea
          ref={titleRef}
          className="actions-mobile-create-title block min-h-7 w-full min-w-0 resize-none overflow-hidden border-0 bg-transparent p-0 text-lg/7 font-medium tracking-normal text-foreground placeholder:text-muted-foreground/65 focus:outline-0"
          value={title}
          rows={1}
          enterKeyHint="enter"
          placeholder="Что бы вы хотели сделать?"
          aria-label={titleLabel}
          onChange={(event) => setTitle(singleLineTitle(event.target.value))}
          onKeyDown={onTitleKeyDown}
        />
        <textarea
          ref={descriptionRef}
          className="actions-mobile-create-description mt-2 block min-h-12 w-full min-w-0 resize-none overflow-hidden border-0 bg-transparent p-0 text-base/6 font-normal tracking-normal text-muted-foreground placeholder:text-muted-foreground/65 focus:outline-0"
          value={description}
          rows={2}
          enterKeyHint="enter"
          placeholder={descriptionActive || description ? "Описание" : ""}
          aria-label={descriptionLabel}
          onFocus={() => setDescriptionActive(true)}
          onChange={(event) => setDescription(event.target.value)}
          onKeyDown={onDescriptionKeyDown}
        />
      </div>
      <div className="mobile-create-toolbar mt-3 flex h-10 shrink-0 items-center justify-between gap-4 text-muted-foreground">
        <div className="flex min-w-0 items-center gap-3">
          {MOBILE_CREATE_TOOL_ICONS.map(([name, label, Icon]) => (
            <button
              key={name}
              type="button"
              className="mobile-create-tool-icon inline-grid size-8 place-items-center rounded-md border-0 bg-transparent text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-0 focus-visible:ring-[3px] focus-visible:ring-ring/50 active:bg-accent/80 active:text-foreground"
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
