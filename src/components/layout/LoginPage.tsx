import type { FormEvent } from "react";
import { ArrowRight, LockKeyhole } from "lucide-react";
import { Brand } from "./Sidebar";
import { Button } from "../ui/Button";
export function LoginPage({
  email,
  password,
  submitting,
  errorMessage,
  onEmailChange,
  onPasswordChange,
  onSubmit,
}: {
  email: string;
  password: string;
  submitting: boolean;
  errorMessage: string;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <main className="authPage">
      <form className="authCard" onSubmit={onSubmit}>
        <Brand />
        <div className="authIntro">
          <h1>Accedi al tuo spazio</h1>
          <p>Il tuo sistema finanziario personale.</p>
        </div>
        <label className="field">
          Email
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => onEmailChange(e.target.value)}
          />
        </label>
        <label className="field">
          Password
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => onPasswordChange(e.target.value)}
          />
        </label>
        {errorMessage && (
          <div className="notice" role="alert">
            {errorMessage}
          </div>
        )}
        <Button type="submit" disabled={submitting}>
          {submitting ? "Accesso…" : "Accedi"}
          <ArrowRight size={16} aria-hidden="true" />
        </Button>
        <p className="authFootnote">
          <LockKeyhole size={12} aria-hidden="true" /> Uno spazio privato,
          dedicato a te.
        </p>
      </form>
    </main>
  );
}
