import { LogOut, Menu, RefreshCw, UserRound } from "lucide-react";
import { Button } from "../ui/Button";
export function TopBar({
  title,
  email,
  loading,
  onRefresh,
  onLogout,
  onOpenMenu,
  menuOpen,
}: {
  title: string;
  email?: string;
  loading: boolean;
  onRefresh: () => void;
  onLogout: () => void;
  onOpenMenu: () => void;
  menuOpen: boolean;
}) {
  return (
    <header className="topbar">
      <div className="topbarLocation">
        <Button
          variant="icon"
          className="mobileMenuToggle"
          aria-label="Apri navigazione"
          aria-controls="mobile-navigation"
          aria-expanded={menuOpen}
          onClick={onOpenMenu}
        >
          <Menu size={21} />
        </Button>
        <span className="breadcrumb">
          FinancialMind <span aria-hidden="true">/</span>{" "}
          <strong>{title}</strong>
        </span>
      </div>
      <div className="topbarActions">
        <Button
          variant="ghost"
          aria-label="Aggiorna dati"
          disabled={loading}
          onClick={onRefresh}
        >
          <RefreshCw size={16} className={loading ? "spin" : ""} />
          <span className="refreshLabel">
            {loading ? "Aggiornamento…" : "Aggiorna"}
          </span>
        </Button>
        <span className="userIdentity">
          <span className="userAvatar" aria-hidden="true">
            <UserRound size={16} />
          </span>
          <span className="sessionUser" title={email}>
            {email}
          </span>
        </span>
        <Button variant="ghost" onClick={onLogout} aria-label="Esci">
          <LogOut size={16} />
          <span className="logoutLabel">Esci</span>
        </Button>
      </div>
    </header>
  );
}
