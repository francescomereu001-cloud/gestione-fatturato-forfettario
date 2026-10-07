import type { ReactNode } from "react";
export function PageHeader({
  title,
  description,
  eyebrow,
  action,
}: {
  title: string;
  description?: ReactNode;
  eyebrow?: string;
  action?: ReactNode;
}) {
  return (
    <header className="pageHeader">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {description && <p className="pageDescription">{description}</p>}
      </div>
      {action && <div className="pageHeaderAction">{action}</div>}
    </header>
  );
}
