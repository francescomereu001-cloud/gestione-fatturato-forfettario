export type SessionGateState = "loading" | "authenticated" | "anonymous";

export function sessionGateState(isRestoring: boolean, userId?: string): SessionGateState {
  if (isRestoring) return "loading";
  return userId ? "authenticated" : "anonymous";
}

export function ownedBy<T extends object>(record: T, userId: string): T & { user_id: string } {
  if (!userId) throw new Error("Una sessione autenticata è necessaria per salvare dati.");
  return { ...record, user_id: userId };
}
