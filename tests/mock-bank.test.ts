import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { app, type Scenario } from "../src/mock-bank/app.js";

let server: Server;
let baseUrl: string;

before(async () => {
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

async function start(scenario: Scenario = "normal"): Promise<string> {
  const response = await fetch(`${baseUrl}/start?scenario=${scenario}`, { redirect: "manual" });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/members/search");
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  return cookie;
}

async function request(path: string, cookie: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { cookie, ...init?.headers },
    redirect: "manual",
  });
}

async function search(cookie: string, memberId: string): Promise<Response> {
  return request("/members/search", cookie, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ memberId }),
  });
}

test("normal UI flow reaches the savings balance inside a frame", async () => {
  const cookie = await start();
  assert.match(await (await request("/members/search", cookie)).text(), /Member Search/);
  assert.equal((await search(cookie, "10001")).headers.get("location"), "/members/results");
  assert.match(await (await request("/members/results", cookie)).text(), /Avery Sample/);
  assert.match(await (await request("/members/10001", cookie)).text(), /Open savings account/);
  const savings = await (await request("/members/10001/accounts/savings", cookie)).text();
  assert.match(savings, /<iframe[^>]+title="Savings account details"/);
  assert.match(savings, /Close Account/);
  const panel = await (await request("/members/10001/accounts/savings/panel", cookie)).text();
  assert.match(panel, /\$1250\.75 USD/);
});

test("invalid input and no-match are distinct visible outcomes", async () => {
  const cookie = await start();
  const invalid = await search(cookie, "abc");
  assert.equal(invalid.status, 422);
  assert.match(await invalid.text(), /Enter a valid five-digit member ID/);
  assert.equal((await search(cookie, "99999")).status, 302);
  assert.match(await (await request("/members/results", cookie)).text(), /No member found/);
});

test("slow result is a temporary state before the same session sees a result", async () => {
  const cookie = await start("slow_load");
  await search(cookie, "10002");
  const loading = await (await request("/members/results", cookie)).text();
  assert.match(loading, /Loading member records/);
  assert.match(loading, /http-equiv="refresh"/);
  const results = await (await request("/members/results", cookie)).text();
  assert.match(results, /Jordan Sample/);
});

test("permission denial and expiry appear at the savings step", async () => {
  const deniedCookie = await start("permission_denied");
  const denied = await request("/members/10002/accounts/savings", deniedCookie);
  assert.equal(denied.status, 403);
  assert.match(await denied.text(), /Access Denied/);

  const expiredCookie = await start("session_expired");
  const expired = await request("/members/10002/accounts/savings", expiredCookie);
  assert.equal(expired.status, 302);
  assert.equal(expired.headers.get("location"), "/session-expired");
  const expiredPage = await request("/session-expired", expiredCookie);
  assert.equal(expiredPage.status, 401);
  assert.match(await expiredPage.text(), /Session Expired/);
});

test("a dialog blocks account details until dismissed in the same session", async () => {
  const cookie = await start("unexpected_dialog");
  const blocked = await (await request("/members/10002/accounts/savings", cookie)).text();
  assert.match(blocked, /role="dialog"/);
  assert.doesNotMatch(blocked, /<iframe/);
  const dismissed = await request("/members/10002/accounts/savings/dismiss", cookie, { method: "POST" });
  assert.equal(dismissed.headers.get("location"), "/members/10002/accounts/savings");
  const resumed = await (await request("/members/10002/accounts/savings", cookie)).text();
  assert.match(resumed, /<iframe/);
});

test("account closure changes synthetic session state only after confirmation", async () => {
  const cookie = await start();
  const review = await request("/members/10001/accounts/savings/close/review", cookie, { method: "POST" });
  assert.match(await review.text(), /Confirm Close Account/);
  const beforeConfirmation = await (await request("/members/10001/accounts/savings/panel", cookie)).text();
  assert.match(beforeConfirmation, /Account status<\/th><td>Open/);
  const confirm = await request("/members/10001/accounts/savings/close/confirm", cookie, { method: "POST" });
  assert.match(await confirm.text(), /Account Closed/);
  const afterConfirmation = await (await request("/members/10001/accounts/savings/panel", cookie)).text();
  assert.match(afterConfirmation, /Account status<\/th><td>Closed/);

  const freshCookie = await start();
  const freshPanel = await (await request("/members/10001/accounts/savings/panel", freshCookie)).text();
  assert.match(freshPanel, /Account status<\/th><td>Open/);
});
