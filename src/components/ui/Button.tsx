import type { ButtonHTMLAttributes } from "react";
export function Button({
  variant = "primary",
  className = "",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "icon";
}) {
  return (
    <button
      type="button"
      className={`button button--${variant} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
