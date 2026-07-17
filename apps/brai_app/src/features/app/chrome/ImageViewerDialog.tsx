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
          className="fixed inset-0 z-[181] grid place-items-center px-3 pb-[max(env(safe-area-inset-bottom),1.5rem)] pt-[max(env(safe-area-inset-top),3.5rem)]"
          {...sheetDragHandlers}
        >
          <Dialog.Popup ref={sheetRef} className="grid h-full w-full max-w-5xl grid-rows-[2.5rem_minmax(0,1fr)] overflow-hidden outline-none" style={sheetStyle}>
            <Dialog.Title className="sr-only">{label}</Dialog.Title>
            <div className="flex justify-end gap-2" data-mobile-sheet-no-drag>
              {onDownload ? <Button type="button" size="sm" variant="secondary" onClick={onDownload}><Download aria-hidden="true" />Скачать</Button> : null}
              <Button type="button" size="icon-sm" variant="secondary" aria-label="Закрыть просмотр" onClick={close}><X aria-hidden="true" /></Button>
            </div>
            <div className="grid min-h-0 place-items-center overflow-hidden">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt={label} draggable={false} className="block max-h-full max-w-full object-contain" />
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
