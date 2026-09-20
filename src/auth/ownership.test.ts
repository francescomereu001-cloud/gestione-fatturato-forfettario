import assert from "node:assert/strict";
import test from "node:test";
import { ownedBy, sessionGateState } from "./ownership.ts";

test("the session gate keeps private UI hidden while restoring and when anonymous", () => {
  assert.equal(sessionGateState(true, "user-a"), "loading");
  assert.equal(sessionGateState(false), "anonymous");
  assert.equal(sessionGateState(false, "user-a"), "authenticated");
});

test("owned records always carry the authenticated user id", () => {
  assert.deepEqual(ownedBy({ anno: 2026 }, "user-a"), { anno: 2026, user_id: "user-a" });
  assert.throws(() => ownedBy({}, ""), /sessione autenticata/);
});
