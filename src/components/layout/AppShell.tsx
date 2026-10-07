import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type KeyboardEvent,
} from "react";
import { X } from "lucide-react";
import { Sidebar } from "./Sidebar";
import { pageTitles } from "./navigation";
import { TopBar } from "./TopBar";
import { Button } from "../ui/Button";
export function AppShell({
  activeTab,
  onNavigate,
  email,
  loading,
  onRefresh,
  onLogout,
  children,
}: {
  activeTab: string;
  onNavigate: (id: string) => void;
  email?: string;
  loading: boolean;
  onRefresh: () => void;
  onLogout: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = () => {
    dialog.current?.close();
    setMenuOpen(false);
  };
  const containFocus = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== "Tab") return;
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        "button:not(:disabled)",
      ),
    );
    const first = buttons[0],
      last = buttons[buttons.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };
  useEffect(() => {
    if (!window.matchMedia) return;
    const desktop = window.matchMedia("(min-width: 1200px)");
    const closeOnDesktop = () => {
      if (desktop.matches && dialog.current?.open) {
        dialog.current.close();
        setMenuOpen(false);
      }
    };
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);
  return (
    <div className="app">
      <a href="#main-content" className="skipLink">
        Vai al contenuto
      </a>
      <Sidebar
        activeTab={activeTab}
        onNavigate={onNavigate}
        className="sidebar--desktop"
      />
      <dialog
        ref={dialog}
        id="mobile-navigation"
        className="mobileDrawer"
        aria-label="Navigazione mobile"
        onClose={() => setMenuOpen(false)}
        onKeyDown={containFocus}
        onClick={(event) => {
          if (event.target === event.currentTarget) closeMenu();
        }}
      >
        <Button
          variant="icon"
          className="drawerClose"
          onClick={closeMenu}
          aria-label="Chiudi navigazione"
        >
          <X size={22} />
        </Button>
        <Sidebar
          activeTab={activeTab}
          onNavigate={(id) => {
            onNavigate(id);
            closeMenu();
          }}
        />
      </dialog>
      <div className="appWorkspace">
        <TopBar
          title={pageTitles[activeTab] || "Overview"}
          email={email}
          loading={loading}
          onRefresh={onRefresh}
          onLogout={onLogout}
          menuOpen={menuOpen}
          onOpenMenu={() => {
            dialog.current?.showModal();
            setMenuOpen(true);
          }}
        />
        <main className="main" id="main-content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
