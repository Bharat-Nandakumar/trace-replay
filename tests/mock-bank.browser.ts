import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "playwright";
import { app } from "../src/mock-bank/app.js";

let server: Server;
let browser: Browser;
let baseUrl: string;

before(async () => {
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || undefined,
  });
});

after(async () => {
  await browser?.close();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test("a person or browser agent can complete the four-screen savings flow", async () => {
  const page = await browser.newPage();
  await page.goto(`${baseUrl}/start?scenario=normal`);
  await page.getByRole("textbox", { name: "Member ID" }).fill("10001");
  await page.getByRole("button", { name: "Search" }).click();
  await page.getByRole("link", { name: "Open member" }).click();
  await page.getByRole("link", { name: "Open savings account" }).click();

  assert.match(await page.getByRole("heading", { name: "Savings Account" }).textContent() ?? "", /Savings Account/);
  const balance = page.frameLocator('iframe[title="Savings account details"]').getByText("$1250.75 USD");
  await balance.waitFor();
  assert.equal(await balance.textContent(), "$1250.75 USD");
  assert.equal(await page.getByRole("button", { name: "Close Account" }).count(), 1);
  if (process.env.SCREENSHOT_PATH) {
    await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: true });
  }
  await page.close();
});

test("the unexpected dialog must be dismissed before account details appear", async () => {
  const page = await browser.newPage();
  await page.goto(`${baseUrl}/start?scenario=unexpected_dialog`);
  await page.getByRole("textbox", { name: "Member ID" }).fill("10002");
  await page.getByRole("button", { name: "Search" }).click();
  await page.getByRole("link", { name: "Open member" }).click();
  await page.getByRole("link", { name: "Open savings account" }).click();

  assert.equal(await page.getByRole("dialog", { name: "Account notice" }).count(), 1);
  assert.equal(await page.locator("iframe").count(), 0);
  await page.getByRole("button", { name: "Dismiss notice" }).click();
  const balance = page.frameLocator('iframe[title="Savings account details"]').getByText("$842.10 USD");
  await balance.waitFor();
  assert.equal(await balance.textContent(), "$842.10 USD");
  await page.close();
});
