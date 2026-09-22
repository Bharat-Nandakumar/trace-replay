# Evidence index

All data in this project is synthetic. JSONL is newline-delimited JSON, ordered by execution time. Replay logs redact invocation values and outputs and end with `modelCalls: 0`.

## Discovery

- `discovery-gpt-5-6-terra-2026-09-20-final.jsonl` — authoritative genuine `openai/gpt-5.6-terra` discovery. It contains six unique response IDs, numeric token usage, five successful UI actions, a structured balance read, independent completion verification, and terminal success.
- `discovery-gpt-5-6-terra-2026-09-20-failed.jsonl` — retained rejected-completion evidence. The model tried to finish before the required structured read; the runner refused to compile or treat it as successful evidence.

## Deterministic replay and runtime handling

- `phase-6-normal-success.jsonl` — five saved steps, typed output, verified checkpoints and compatibility, zero model calls.
- `phase-6-invalid-input.jsonl` — `INVALID_MEMBER_ID` before browser launch.
- `phase-6-member-not-found.jsonl` — expected `MEMBER_NOT_FOUND` business outcome.
- `phase-6-slow-load.jsonl` — one declared recovery attempt, recovered true, then success.
- `phase-6-permission-denied.jsonl` — hard runtime failure at `open_savings`.
- `phase-6-session-expired.jsonl` — hard runtime failure with screenshot reference.
- `phase-6-session-expired-session_expired.png` — visually reviewed Session Expired screen without member or account details.
- `phase-6-unexpected-dialog.jsonl` — noninteractive replay routes the dialog to `intervention_required`.
- `phase-6-possible-drift.jsonl` — an intentionally altered target produces `TARGET_NOT_FOUND` with category `possible_drift`.

## Same-session handoff

- `phase-7-automated-handoff.jsonl` — automated integration operator accepts control, dismisses the dialog in the same Playwright page, resumes, revalidates, and reaches success. The operator name clearly identifies it as automated evidence.
- `phase-7-manual-handoff-success.jsonl` — authoritative genuine manual run. Operator `bharat` accepts control in the terminal, clicks **Dismiss notice** in native visible Chrome, returns control, and replay finishes successfully.

Both handoff logs record the native dismissal request and the ownership sequence automation → paused → human → automation → finished. Their artifact hashes match `capabilities/lookup-savings-balance.json`.

## Audit

Run:

```bash
npm run audit:evidence
```

The audit parses every authoritative JSONL file, verifies terminal results and zero model calls, checks the artifact's discovery provenance, validates handoff events and native dismissal evidence, checks replay logs for known sensitive literals and local paths, and confirms that the failure screenshot exists.
