import type { ReactNode } from "react";
export function StatCard({
  icon,
  title,
  value,
  danger = false,
}: {
  icon?: ReactNode;
  title: string;
  value: string;
  danger?: boolean;
}) {
  return (
    <div className={`card statCard ${danger ? "danger" : ""}`}>
      <div className="statCardLabel">
        {icon && (
          <span className="cardIcon" aria-hidden="true">
            {icon}
          </span>
        )}
        <p>{title}</p>
      </div>
      <h2 className="amount">{value}</h2>
    </div>
  );
}
