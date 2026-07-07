import type { ComponentProps } from "react";
import { cn } from "@/shared/ui/cn";

type BadgeVariant = "default" | "destructive" | "error" | "outline" | "secondary";
type BadgeSize = "default" | "lg" | "sm";

const base =
  "relative inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-sm border border-transparent font-medium outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-3.5 sm:[&_svg:not([class*='size-'])]:size-3 [&_svg]:pointer-events-none [&_svg]:shrink-0 [button&,a&]:cursor-pointer [button&,a&]:pointer-coarse:after:absolute [button&,a&]:pointer-coarse:after:size-full [button&,a&]:pointer-coarse:after:min-h-11 [button&,a&]:pointer-coarse:after:min-w-11";

const sizes: Record<BadgeSize, string> = {
  default: "h-5.5 min-w-5.5 px-[calc(--spacing(1)-1px)] text-sm sm:h-4.5 sm:min-w-4.5 sm:text-xs",
  lg: "h-6.5 min-w-6.5 px-[calc(--spacing(1.5)-1px)] text-base sm:h-5.5 sm:min-w-5.5 sm:text-sm",
  sm: "h-5 min-w-5 rounded-[.25rem] px-[calc(--spacing(1)-1px)] text-xs sm:h-4 sm:min-w-4 sm:text-[.625rem]",
};

const variants: Record<BadgeVariant, string> = {
  default: "bg-primary text-primary-foreground [button&,a&]:hover:bg-primary/90",
  destructive: "bg-destructive text-white [button&,a&]:hover:bg-destructive/90",
  error: "bg-destructive/8 text-destructive-foreground dark:bg-destructive/16",
  outline: "border-input bg-background text-foreground dark:bg-input/32 [button&,a&]:hover:bg-accent/50 dark:[button&,a&]:hover:bg-input/48",
  secondary: "bg-secondary text-secondary-foreground [button&,a&]:hover:bg-secondary/90",
};

export function Badge({
  className,
  size = "default",
  variant = "secondary",
  ...props
}: ComponentProps<"span"> & {
  size?: BadgeSize;
  variant?: BadgeVariant;
}) {
  return <span className={cn(base, sizes[size], variants[variant], className)} data-slot="badge" {...props} />;
}
