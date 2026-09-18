# trace-replay

AI-powered computer-use automation that turns discovered UI workflows into reusable, deterministic replays—with safety guardrails and human takeover.

The project is being built in phases. The local synthetic bank app and the capability/safety contracts are implemented. Model-driven discovery, generated artifacts, replay, and human handoff are upcoming phases. See [PLAN.md](PLAN.md), the [agreed demo scope](docs/phase-1-scope.md), and the [Phase 3 contract](docs/phase-3-contract.md).

## Run the local bank app

Requires Node.js 22 or newer.

```bash
npm install
npm run app
```

Open `http://127.0.0.1:3000/start` in a browser. Search for synthetic member `10001` or `10002`, open the result, then open the savings account. Their displayed balances are `$1250.75 USD` and `$842.10 USD`, respectively. ID `99999` has no match; a non-five-digit ID produces a validation message. All data is invented.

To reproduce an app condition, start a new browser session with one of these entry URLs:

```text
http://127.0.0.1:3000/start?scenario=slow_load
http://127.0.0.1:3000/start?scenario=permission_denied
http://127.0.0.1:3000/start?scenario=session_expired
http://127.0.0.1:3000/start?scenario=unexpected_dialog
```

The app redirects to Member Search after recording the scenario for that browser session. These URLs set up test conditions; they never perform the lookup. The **Close Account** control changes synthetic session state only after a separate confirmation screen. Future automation policy will block or escalate it before activation.

## Check the app

```bash
npm run typecheck
npm test
npx playwright install chromium
npm run test:browser
```

The browser test can use an existing Chrome installation by setting `CHROME_PATH` to its executable path instead of installing Playwright Chromium.

## Inspect the capability contract

```bash
npm run validate:example
```

This validates and summarizes the hand-authored example in `examples/hand-authored-savings-balance.json` against the versioned artifact schema and the mock-bank policy. It is a contract example, **not** evidence of an LLM discovery run.
