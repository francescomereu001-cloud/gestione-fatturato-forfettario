import { Flag } from "lucide-react";
import { Badge } from "../ui/Badge";
import { navigationSections } from "./navigation";

export function Brand() {
  return (
    <div className="brand">
      <span className="logo" aria-hidden="true">
        <Flag size={22} strokeWidth={2.2} />
      </span>
      <div>
        <span className="brandName">FinancialMind</span>
        <span className="brandSubtitle">Personal Financial OS</span>
      </div>
    </div>
  );
}
export function Sidebar({
  activeTab,
  onNavigate,
  className = "",
}: {
  activeTab: string;
  onNavigate: (id: string) => void;
  className?: string;
}) {
  return (
    <aside className={`sidebar ${className}`}>
      <Brand />
      <nav aria-label="Navigazione principale">
        {navigationSections.map((section) => (
          <div className="navSection" key={section.label}>
            <p className="navSectionLabel">{section.label}</p>
            {section.items.map(({ id, label, icon: Icon, future }) => (
              <button
                type="button"
                key={id}
                className={`navItem ${activeTab === id ? "active" : ""}`}
                aria-current={activeTab === id ? "page" : undefined}
                disabled={future}
                onClick={() => onNavigate(id)}
              >
                <Icon size={18} aria-hidden="true" />
                <span>{label}</span>
                {future && (
                  <>
                    {" "}
                    <Badge>Presto</Badge>
                  </>
                )}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <p className="sidebarFootnote">Uno spazio per le tue finanze.</p>
    </aside>
  );
}
