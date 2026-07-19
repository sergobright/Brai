"use client";

import { useCallback, useEffect } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Download, X } from "lucide-react";
import { installAndroidBackHandler } from "@/shared/platform/platform";
import { Button } from "@/shared/ui/button";
import { useMobileSheetDrag } from "../hooks/useMobileSheetDrag";

/** Shared full-screen image viewer for authenticated app content. */
export function ImageViewerDialog({
  label,
  onDownload,
  onOpenChange,
  open,
  src,
}: {
  label: string;
  onDownload?: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  src: string;
}) {
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const {
    backdropRef,
    backdropStyle,
    closeWithAnimation,
    gestureRef,
    resetOpen,
    sheetDragHandlers,
    sheetRef,
    sheetStyle,
  } = useMobileSheetDrag({ onClose: close });

  useEffect(() => {
    if (!open) return;
    resetOpen();
    return installAndroidBackHandler(() => {
      closeWithAnimation();
      return true;
    });
  }, [closeWithAnimation, open, resetOpen]);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) onOpenChange(true);
        else closeWithAnimation();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop ref={backdropRef} className="fixed inset-0 z-[180] bg-background/95 backdrop-blur-sm" style={backdropStyle} />
        <Dialog.Viewport
          ref={gestureRef}
          className="fixed inset-0 z-[181] grid place-items-center overflow-hidden p-0"
          {...sheetDragHandlers}
        >
          <Dialog.Popup ref={sheetRef} className="relative grid h-full w-full place-items-center overflow-hidden outline-none" style={sheetStyle}>
            <Dialog.Title className="sr-only">{label}</Dialog.Title>
            <div
              className="absolute right-[max(env(safe-area-inset-right),0.75rem)] top-[max(env(safe-area-inset-top),0.75rem)] z-[2] flex gap-1.5"
              data-mobile-sheet-no-drag
            >
              {onDownload ? (
                <Button
                  type="button"
                  size="icon-sm"
                  variant="secondary"
                  className="bg-background/65 text-foreground shadow-sm backdrop-blur-md hover:bg-background/85"
                  aria-label="Скачать изображение"
                  onClick={onDownload}
                >
                  <Download aria-hidden="true" />
                </Button>
              ) : null}
              <Button
                type="button"
                size="icon-sm"
                variant="secondary"
                className="bg-background/65 text-foreground shadow-sm backdrop-blur-md hover:bg-background/85"
                aria-label="Закрыть просмотр"
                onClick={close}
              >
                <X aria-hidden="true" />
              </Button>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt={label} draggable={false} className="block h-full w-full object-contain" />
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
