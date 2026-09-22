# trace-replay

`trace-replay` discovers a workflow with an LLM once, compiles the successful run into a typed capability, and replays that capability through the UI without model decisions. The demonstration uses a local synthetic credit-union servicing application with server-rendered pages, a table-driven member flow, an iframe balance panel, runtime failures, a risky account action, and same-session operator handoff.

The complete design and trade-offs are in [REPORT.md](REPORT.md). Phase decisions and implementation notes are in [PLAN.md](PLAN.md) and [docs/](docs/).

## What the demonstration proves

- A genuine `openai/gpt-5.6-terra` discovery run completed a live five-action UI goal.
- A reviewed compiler produced `capabilities/lookup-savings-balance.json` without the discovery member ID or balance.
- The saved artifact replays for a different member with `modelCalls: 0`.
- Replay distinguishes invalid input, member not found, bounded slow loading, permission denial, session expiry, unexpected dialog, and possible UI drift.
- A person can take control of the exact live Chrome session, dismiss the dialog, return control, and let deterministic replay finish.
- The same origin, route, action, risk, request, redaction, and ownership guardrails apply across discovery, replay, and handoff.

All application data is invented.

## Requirements and setup

- Node.js 22 or newer
- npm
- Chromium installed by Playwright, or local Google Chrome through `CHROME_PATH`
- An OpenAI API key only when running a new discovery

```bash
npm install
npx playwright install chromium
```

For local Google Chrome on macOS, commands may instead use:

```bash
export CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
```

Create a local `.env` only if you want to run discovery:

```bash
cp .env.example .env
```

Set the key inside `.env`:

```text
OPENAI_API_KEY='your-key'
```

`.env` is ignored by Git. The program does not automatically load it, so load it into the current terminal before discovery:

```bash
set -a
source .env
set +a
```

The key is not needed to inspect evidence, compile the saved discovery, or replay a capability.

## Quick demo without an API key

In Terminal 1, start the synthetic bank:

```bash
npm run app
```

In Terminal 2, replay the saved capability for a member different from the discovery input:

```bash
env -u OPENAI_API_KEY npm run replay -- \
  --artifact capabilities/lookup-savings-balance.json \
  --input member_id=10002 \
  --log evidence/reviewer-normal-replay.jsonl
```

Replay returns a typed USD balance. Its JSONL redacts the member ID and amount and records `decisionSource: "artifact"` and `modelCalls: 0`. Evidence paths are create-only; choose a new `--log` filename when repeating a command.

## End-to-end discovery and compilation

With the app running and `OPENAI_API_KEY` loaded, run genuine model-driven discovery:

```bash
npm run discover -- \
  --goal 'Look up member {member_id} and return the current balance of their savings account.' \
  --entry http://127.0.0.1:3000/start \
  --input member_id=10001 \
  --model gpt-5.6-terra \
  --log evidence/reviewer-discovery.jsonl
```

Discovery sends the current screenshot and a compact accessibility/text observation to the model, accepts one strict action proposal per turn, policy-checks it, and acts through Playwright. The authoritative committed genuine run is `evidence/discovery-gpt-5-6-terra-2026-09-20-final.jsonl`.

Compile a reviewed artifact from that saved run:

```bash
npm run compile:capability -- \
  --log evidence/discovery-gpt-5-6-terra-2026-09-20-final.jsonl \
  --profile config/lookup-savings-balance.compile.json \
  --output /tmp/lookup-savings-balance-review.json \
  --input member_id=10001
```

Replay the freshly compiled artifact without an OpenAI key:

```bash
env -u OPENAI_API_KEY npm run replay -- \
  --artifact /tmp/lookup-savings-balance-review.json \
  --input member_id=10002 \
  --log evidence/reviewer-compiled-replay.jsonl
```

The compiler accepts only verified successful actions with allowed policy and unique-target evidence. It combines those mechanics with the reviewed profile's public contract, checkpoints, typed output, business outcomes, and runtime rules.

## Runtime outcomes and failures

Scenario setup occurs on `/start`; replay still performs the complete browser workflow.

```bash
# Recover once from a transient loading page, then succeed.
env -u OPENAI_API_KEY npm run replay -- \
  --artifact capabilities/lookup-savings-balance.json \
  --input member_id=10002 \
  --entry-url 'http://127.0.0.1:3000/start?scenario=slow_load' \
  --log evidence/reviewer-slow-load.jsonl

# Stop with a structured SESSION_EXPIRED runtime failure and safe screenshot.
env -u OPENAI_API_KEY npm run replay -- \
  --artifact capabilities/lookup-savings-balance.json \
  --input member_id=10002 \
  --entry-url 'http://127.0.0.1:3000/start?scenario=session_expired' \
  --log evidence/reviewer-session-expired.jsonl
```

Other supported scenarios are `permission_denied` and `unexpected_dialog`. Input `abc` returns `INVALID_MEMBER_ID` before Chrome starts; member `99999` returns `MEMBER_NOT_FOUND`. The reviewed matrix is explained in [docs/phase-6-runtime.md](docs/phase-6-runtime.md).

## Same-session human handoff

Run replay in interactive mode:

```bash
env -u OPENAI_API_KEY npm run replay -- \
  --artifact capabilities/lookup-savings-balance.json \
  --input member_id=10002 \
  --entry-url 'http://127.0.0.1:3000/start?scenario=unexpected_dialog' \
  --handoff interactive \
  --operator-id reviewer \
  --log evidence/reviewer-manual-handoff.jsonl
```

Visible Chrome pauses on the Account Notice. Type `take` in the terminal, click **Dismiss notice** in that same Chrome window, then type `resume`. Replay checks that policy still allows the current page and that the dialog disappeared, completes the interrupted checkpoint, reads the balance, and succeeds. `abort` stops explicitly. The default timeout is ten minutes; `--handoff-timeout-ms` can override it.

The request policy stays active during human control. The dismissal route is allowed; account-closing routes remain denied. The authoritative genuine manual run is `evidence/phase-7-manual-handoff-success.jsonl`.

## Verification

```bash
npm run typecheck
npm test
npm run test:browser
npm run validate:example
npm run audit:evidence
```

`npm run test:browser` uses Playwright Chromium by default. To use an existing Chrome installation:

```bash
CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:browser
```

The final suite contains 18 unit/contract tests and 18 real-browser tests. The evidence audit checks the discovery identity and response evidence, artifact provenance, terminal results, zero-model-call replay, redaction, handoff events, saved-artifact hashes, and failure screenshot presence.

## Evidence guide

See [evidence/README.md](evidence/README.md) for the authoritative file list. The central items are:

- `discovery-gpt-5-6-terra-2026-09-20-final.jsonl` — genuine successful LLM discovery.
- `phase-6-normal-success.jsonl` — deterministic replay success.
- `phase-6-slow-load.jsonl` — bounded recovery and success.
- `phase-6-session-expired.jsonl` and its PNG — structured hard failure plus richer evidence.
- `phase-7-manual-handoff-success.jsonl` — genuine same-session human takeover and resume.

## Project layout

- `src/discovery/` — constrained OpenAI decision loop.
- `src/compiler/` — verified trace plus reviewed profile to capability.
- `src/replay/` — deterministic artifact executor.
- `src/handoff/` — operator coordinator, terminal UI, and browser audit.
- `src/core/` — artifact, result, policy, control, redaction, and surface contracts.
- `src/surfaces/` — Playwright surface adapter.
- `src/mock-bank/` — local synthetic target application.
- `capabilities/` — generated reusable capability.
- `config/` — reviewed compilation profile and safety policy.
- `evidence/` — redacted discovery, replay, failure, and handoff evidence.
- `tests/` — contract, route, discovery, replay, and real-browser tests.

## Scope

This repository implements one complete browser capability. Desktop adapters, multi-tenant override storage, a remote operator console, artifact approval workflows, and the optional stretch goals are deliberately left out. Their extension seams and trade-offs are described in [REPORT.md](REPORT.md).
