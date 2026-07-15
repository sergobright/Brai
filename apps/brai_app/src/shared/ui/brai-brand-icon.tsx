import { cx } from "@/features/app/appUtils";

export function BraiBrandIcon({ className }: { className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- the accepted navigation asset must stay the exact raster URL.
    <img src="/favicon.png" alt="" className={cx("block size-5 shrink-0", className)} aria-hidden="true" />
  );
}
