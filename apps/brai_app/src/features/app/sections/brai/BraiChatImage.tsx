"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Expand, Loader2, RefreshCw, X } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { cx } from "../../appUtils";

export function BraiChatImage({
  attachmentId,
  className,
  label,
  loadBlob,
}: {
  attachmentId: string;
  className?: string;
  label: string;
  loadBlob: (id: string, download?: boolean) => Promise<Blob>;
}) {
  const [loadState, setLoadState] = useState<{ key: string; objectUrl: string; failed: boolean } | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [loadVersion, setLoadVersion] = useState(0);
  const objectUrlRef = useRef("");

  const releaseObjectUrl = useCallback(() => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = "";
  }, []);

  useEffect(() => {
    let cancelled = false;
    releaseObjectUrl();
    const key = `${attachmentId}:${loadVersion}`;
    void loadBlob(attachmentId).then((blob) => {
      if (cancelled) return;
      if (!blob.type.startsWith("image/") || blob.size === 0) throw new Error("invalid_image_blob");
      const nextUrl = URL.createObjectURL(blob);
      objectUrlRef.current = nextUrl;
      setLoadState({ key, objectUrl: nextUrl, failed: false });
    }).catch(() => {
      if (!cancelled) setLoadState({ key, objectUrl: "", failed: true });
    });
    return () => {
      cancelled = true;
      releaseObjectUrl();
    };
  }, [attachmentId, loadBlob, loadVersion, releaseObjectUrl]);
  const currentKey = `${attachmentId}:${loadVersion}`;
  const objectUrl = loadState?.key === currentKey ? loadState.objectUrl : "";
  const failed = loadState?.key === currentKey && loadState.failed;

  const download = useCallback(async () => {
    try {
      const blob = await loadBlob(attachmentId, true);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = label || "brai-image";
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      releaseObjectUrl();
      setLoadState({ key: currentKey, objectUrl: "", failed: true });
    }
  }, [attachmentId, currentKey, label, loadBlob, releaseObjectUrl]);

  if (failed) {
    return (
      <div className={cx("grid min-h-36 place-items-center gap-2 rounded-lg border border-dashed border-border p-5 text-center text-sm text-muted-foreground", className)}>
        <span>Изображение пока не загрузилось</span>
        <Button type="button" size="sm" variant="outline" onClick={() => setLoadVersion((value) => value + 1)}>
          <RefreshCw aria-hidden="true" />Повторить
        </Button>
      </div>
    );
  }

  if (!objectUrl) {
    return <div className={cx("grid min-h-36 place-items-center rounded-lg border border-border", className)}><Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Загрузка изображения" /></div>;
  }

  return (
    <>
      <div className={cx("group relative overflow-hidden rounded-lg border border-border bg-background", className)}>
        {/* The source is an authenticated, short-lived object URL. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={objectUrl} alt={label} className="h-auto max-h-[70dvh] w-full object-contain" />
        <div className="absolute right-2 top-2 flex gap-1 opacity-100 transition-opacity min-[861px]:opacity-0 min-[861px]:group-hover:opacity-100 min-[861px]:group-focus-within:opacity-100">
          <Button type="button" size="icon-sm" variant="secondary" aria-label="Открыть изображение" onClick={() => setViewerOpen(true)}><Expand aria-hidden="true" /></Button>
          <Button type="button" size="icon-sm" variant="secondary" aria-label="Скачать изображение" onClick={() => void download()}><Download aria-hidden="true" /></Button>
        </div>
      </div>
      {viewerOpen ? (
        <div role="dialog" aria-modal="true" aria-label={label} className="fixed inset-0 z-[180] grid grid-rows-[auto_minmax(0,1fr)] bg-background/95 p-3 backdrop-blur-sm">
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => void download()}><Download aria-hidden="true" />Скачать</Button>
            <Button type="button" size="icon" variant="secondary" aria-label="Закрыть просмотр" onClick={() => setViewerOpen(false)}><X aria-hidden="true" /></Button>
          </div>
          <div className="grid min-h-0 place-items-center overflow-auto p-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={objectUrl} alt={label} className="max-h-full max-w-full object-contain" />
          </div>
        </div>
      ) : null}
    </>
  );
}
