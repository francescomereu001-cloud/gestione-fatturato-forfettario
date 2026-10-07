import { CircleCheck, Inbox } from "lucide-react";
import type { ReactNode } from "react";
export function EmptyState({
  title,
  description,
  complete = false,
  children,
}: {
  title: string;
  description: string;
  complete?: boolean;
  children?: ReactNode;
}) {
  const Icon = complete ? CircleCheck : Inbox;
  return (
    <div className={`emptyState ${complete ? "emptyState--complete" : ""}`}>
      <span className="emptyStateIcon">
        <Icon size={28} aria-hidden="true" />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      {children}
    </div>
  );
}
