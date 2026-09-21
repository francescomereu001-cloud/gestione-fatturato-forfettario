import type { Account, LedgerTransaction } from "../../types/ledger.ts";

export function accountBalance(account: Account, transactions: LedgerTransaction[]): number {
  return transactions
    .filter((transaction) => transaction.account_id === account.id
      && transaction.reconciliation_status !== "ignored"
      && (!account.balance_as_of || transaction.transaction_date > account.balance_as_of))
    .reduce((balance, transaction) => balance + Number(transaction.amount), Number(account.opening_balance));
}

export function totalLiquidity(accounts: Account[], transactions: LedgerTransaction[]): number {
  return accounts
    .filter((account) => account.is_active && account.include_in_liquidity)
    .reduce((total, account) => total + accountBalance(account, transactions), 0);
}
