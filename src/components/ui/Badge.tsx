import type { ReactNode } from "react";
export type BadgeVariant =
  "neutral" | "success" | "warning" | "danger" | "info";
export function Badge({
  children,
  variant = "neutral",
}: {
  children: ReactNode;
  variant?: BadgeVariant;
}) {
  return <span className={`badge badge--${variant}`}>{children}</span>;
}
