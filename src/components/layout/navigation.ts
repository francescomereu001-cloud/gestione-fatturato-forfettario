import {
  ArrowLeftRight,
  ChartNoAxesCombined,
  CircleHelp,
  FileSpreadsheet,
  Folder,
  Landmark,
  LayoutDashboard,
  ReceiptText,
  Settings,
  Target,
  Upload,
  Wallet,
  Building2,
  HandCoins,
  ChartColumn,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

type NavItem = {
  id: string;
  label: string;
  icon: LucideIcon;
  future?: boolean;
};
export const navigationSections: Array<{ label: string; items: NavItem[] }> = [
  {
    label: "Overview",
    items: [{ id: "dashboard", label: "Overview", icon: LayoutDashboard }],
  },
  {
    label: "Money",
    items: [
      { id: "accounts", label: "Conti", icon: Landmark },
      { id: "transactions", label: "Transazioni", icon: ArrowLeftRight },
      { id: "residual-review", label: "Da verificare", icon: CircleHelp },
      { id: "bank-import", label: "Import", icon: Upload },
    ],
  },
  {
    label: "Income & Taxes",
    items: [
      { id: "fatture", label: "Income", icon: ReceiptText },
      { id: "import", label: "Import Income", icon: FileSpreadsheet },
      { id: "fiscale", label: "Taxes", icon: Landmark },
      { id: "pagamenti", label: "Tax Payments / F24", icon: Wallet },
    ],
  },
  {
    label: "Planning",
    items: [
      { id: "funds", label: "Fondi", icon: Wallet },
      { id: "goals", label: "Obiettivi", icon: Target },
      {
        id: "investments",
        label: "Investimenti",
        icon: ChartNoAxesCombined,
        future: true,
      },
    ],
  },
  {
    label: "Wealth",
    items: [
      { id: "assets", label: "Patrimonio", icon: Building2, future: true },
      { id: "liabilities", label: "Debiti", icon: HandCoins, future: true },
      { id: "reports", label: "Report", icon: ChartColumn, future: true },
    ],
  },
  {
    label: "System",
    items: [
      { id: "documents", label: "Documenti", icon: Folder, future: true },
      { id: "settings", label: "Impostazioni", icon: Settings, future: true },
    ],
  },
];
export const pageTitles = Object.fromEntries(
  navigationSections.flatMap((section) =>
    section.items.map((item) => [item.id, item.label]),
  ),
);
