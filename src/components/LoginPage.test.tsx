import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { useState } from "react";
import { LoginPage } from "./layout/LoginPage.tsx";
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
});
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
const { cleanup, fireEvent, render } = await import("@testing-library/react");
afterEach(cleanup);

test("FinancialMind login keeps email/password submission and accessible errors", () => {
  const submissions: string[][] = [];
  function LoginHarness() {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    return (
      <LoginPage
        email={email}
        password={password}
        submitting={false}
        errorMessage="Accesso non riuscito"
        onEmailChange={setEmail}
        onPasswordChange={setPassword}
        onSubmit={(e) => {
          e.preventDefault();
          submissions.push([email, password]);
        }}
      />
    );
  }
  const view = render(<LoginHarness />);
  assert.ok(view.getByText("FinancialMind"));
  assert.equal(view.queryByText("Fatturato PRO"), null);
  assert.equal(view.getByRole("alert").textContent, "Accesso non riuscito");
  // Input change callbacks are preserved; native form submission remains with the App auth handler.
  fireEvent.change(view.getByLabelText("Email"), {
    target: { value: "synthetic@example.test" },
  });
  fireEvent.change(view.getByLabelText("Password"), {
    target: { value: "synthetic-password" },
  });
  fireEvent.submit(
    view.getByRole("button", { name: "Accedi" }).closest("form")!,
  );
  assert.deepEqual(submissions, [
    ["synthetic@example.test", "synthetic-password"],
  ]);
});

test("login communicates submission and prevents a second submit while busy", () => {
  const view = render(
    <LoginPage
      email=""
      password=""
      submitting={true}
      errorMessage=""
      onEmailChange={() => {}}
      onPasswordChange={() => {}}
      onSubmit={(e) => e.preventDefault()}
    />,
  );
  assert.equal(
    (view.getByRole("button", { name: "Accesso…" }) as HTMLButtonElement)
      .disabled,
    true,
  );
  assert.equal(view.queryByRole("alert"), null);
});
