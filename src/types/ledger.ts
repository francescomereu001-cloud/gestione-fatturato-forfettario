export const accountTypes = ["checking", "savings", "credit_card", "broker", "cash", "technical", "other"] as const;
export const transactionTypes = ["unclassified", "income", "expense", "internal_transfer", "investment_transfer", "debt_principal", "debt_interest", "refund", "adjustment"] as const;
export const reconciliationStatuses = ["pending", "confirmed", "ignored"] as const;

export type AccountType = (typeof accountTypes)[number];
export type TransactionType = (typeof transactionTypes)[number];
export type ReconciliationStatus = (typeof reconciliationStatuses)[number];

export type Account = {
  id?: string; user_id?: string; name: string; institution?: string | null;
  account_type: AccountType; currency: string; opening_balance: number; balance_as_of?: string | null;
  is_active: boolean; include_in_liquidity: boolean; notes?: string | null;
};

export type TransactionCategory = {
  id: string; user_id?: string; name: string;
  category_type: "income" | "expense" | "transfer" | "asset" | "liability";
  parent_id?: string | null; system_key?: string | null;
};

export type LedgerTransaction = {
  id?: string; user_id?: string; account_id: string; transaction_date: string;
  booking_date?: string | null; amount: number; description: string; merchant?: string | null;
  category_id?: string | null; transaction_type: TransactionType;
  transfer_account_id?: string | null; transfer_group_id?: string | null;
  source: string; external_id?: string | null; reconciliation_status: ReconciliationStatus;
  import_batch_id?: string | null;
  notes?: string | null;
};
