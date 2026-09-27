# Georgia Comments / OpenClaw production evidence (2026-09-27 UTC)

This is a sanitized record of the completed cutover, fixed to the source revision below. Private logs, databases, customer payloads, credentials, and runtime artifacts are not in Git. The source artifact digests at the end identify the private records used to prepare this summary.

## Source and scope

| Field | Value |
| --- | --- |
| Repository / PR | `Tiikou/openclaw` [PR #1](https://github.com/Tiikou/openclaw/pull/1), Draft, open, unmerged at evidence preparation |
| Branch | `fix/gateway-model-cli-startup-20260926` |
| Production base / rollback source | `a93e25dddbe26bced9baf1b314455279bb45a9c4` |
| Initial CLI-only candidate | `1678bd8daf87a0f171c428f3c9bb16be9dab5f06` |
| Final source and installed production SHA | `7dad1d50821330ffd4858d4edfdbf39f18b431b2` |
| Final source diff | SHA256 of `git diff --binary a93e25dddbe26bced9baf1b314455279bb45a9c4 7dad1d50821330ffd4858d4edfdbf39f18b431b2`: `7b9c45b73f8b9e56ebe70a2503633b00ea197cec60cccb345f9158a072eadeba` |

`MERGE_PERFORMED=no` · `HMAC_TOUCHED=no` · `PRICING_TOUCHED=no` · `DIRECT_CHANGED=no`.

## Three distinct latency and state issues

1. **CLI preparation:** an explicit `infer model run --gateway` (also reachable through `capability`) entered the stateful local Doctor/migration startup path before contacting the already-running Gateway. In one approved, deliberately invalid-thinking, no-inference diagnostic, total CLI time was 49,856 ms and the `config-ready` stage was 40,775 ms. The final CLI policy uses the existing validation-only RPC-client path for an explicitly selected Gateway transport. It retains core configuration validation and the prior local/default startup path.
2. **Closed-actor lifecycle leak:** the SQLite worker acquired state-lifecycle custody before looking up the requested actor. For a closed actor, the error could escape before the releasing `finally`, leaving the worker alive while later workers saw coordinator contention until Gateway restart. The final worker code rejects a missing/closed actor before lifecycle acquisition. The regression exercises the real worker error followed by immediate coordinator acquisition.
3. **Historical large `main` database:** an organic Comments call before dedicated-agent routing spent 72,763 ms in an integrity check of the approximately 2.1 GB `main` agent database; its model-call path took 87,699 ms. Earlier Gateway cold-start status/health RPCs of 80.4/57.2 s were not fully attributed to one producer. The CLI and closed-actor changes do not claim to eliminate all `main` database scans or every Gateway stall. Georgia PR #87 separately routes Comments to its small existing agent database.

## Exact production code delta

| File | Purpose |
| --- | --- |
| `src/cli/program/preaction.ts` | Choose the lightweight, config-validating startup policy for parsed explicit Gateway model-run commands. |
| `src/cli/program/preaction.test.ts` | Exercise real Commander routes, alias, local/default behavior, conflicting flags, and prompt-text negative control. |
| `src/cli/program/preaction.test-helpers.ts` | Support those command-boundary tests. |
| `src/infra/sqlite-store.worker.ts` | Check actor availability before acquiring state-lifecycle custody. |
| `src/infra/sqlite-worker-closed-actor.test.ts` | Real-worker closed-actor and subsequent coordinator-acquisition regression. |
| `test/vitest/vitest.database-worker-core-paths.mjs` | Register the regression in the canonical database-worker test lane. |

## Executed verification

Commands below were executed against the final candidate. `EVIDENCE_EXIT_CODE=0` is supported by the recorded `PASS_*` sequence markers and the test/output logs; the on-host build is recorded separately as unsuccessful. Test counts are the reporter counts, not an estimate from file names.

- Focused CLI:
  - `EVIDENCE_COMMAND=OPENCLAW_VITEST_MAX_WORKERS=2 node scripts/run-vitest.mjs run --config test/vitest/vitest.cli.config.ts src/cli/program/preaction.test.ts src/cli/program/config-guard.test.ts src/cli/command-startup-policy.test.ts`
  - `EVIDENCE_EXIT_CODE=0`
  - `EVIDENCE_OUTPUT_SUMMARY=Test Files 3 passed; Tests 182 passed; sequence PASS_cli-tests`
- SQLite/infra lane:
  - `EVIDENCE_COMMAND=OPENCLAW_VITEST_MAX_WORKERS=1 node scripts/run-vitest.mjs run --config test/vitest/vitest.infra.config.ts src/infra/sqlite-worker-closed-actor.test.ts src/infra/sqlite-worker-broker.test.ts src/infra/sqlite-worker-preparation.test.ts src/infra/sqlite-worker-open-refusal.test.ts src/infra/sqlite-worker-shared-state.test.ts src/infra/sqlite-worker-lifecycle-path.test.ts src/infra/sqlite-worker-operation-admission.test.ts src/infra/sqlite-wal-checkpoint.test.ts`
  - `EVIDENCE_EXIT_CODE=0`
  - `EVIDENCE_OUTPUT_SUMMARY=Test Files 7 passed; Tests 80 passed; sequence PASS_infra-tests; uses 2 worker threads for 1 available CPUs PASS; uses 3 worker threads for 24 available CPUs PASS`
  - The private final summary separately records an installed closed-actor regression PASS; its individual command transcript is not retained here.
- Core typecheck:
  - `EVIDENCE_COMMAND=pnpm tsgo:core`
  - `EVIDENCE_EXIT_CODE=0`
  - `EVIDENCE_OUTPUT_SUMMARY=sequence PASS_typecheck; run-tsgo.mjs -p tsconfig.core.json completed without diagnostics`
- Source formatting:
  - `EVIDENCE_COMMAND=pnpm exec oxfmt --check src/infra/sqlite-store.worker.ts src/infra/sqlite-worker-closed-actor.test.ts src/cli/program/preaction.ts src/cli/program/preaction.test.ts src/cli/program/preaction.test-helpers.ts`
  - `EVIDENCE_EXIT_CODE=0`
  - `EVIDENCE_OUTPUT_SUMMARY=All matched files use the correct format; sequence PASS_format`
- Patch whitespace:
  - `EVIDENCE_COMMAND=git diff --check`
  - `EVIDENCE_EXIT_CODE=0`
  - `EVIDENCE_OUTPUT_SUMMARY=recorded PASS for final source patch`

The on-host `OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB=4352 pnpm build` did **not** pass: the unified bundle exceeded safe host headroom and was stopped (`sequence.log` ends `rc=143`). The prior `a93e25d` Gateway passed two subsequent readiness checks and health RPC, and its watchdog was restored before the hosted build and later install. Earlier bounded on-host attempts hit memory cgroup OOM at about 4.8 and 5.65 GiB. These are resource limits, not a claim that the final source failed hosted build.

## Hosted build and artifact

- **Built source:** `7dad1d50821330ffd4858d4edfdbf39f18b431b2`. [Job 108517943532](https://github.com/Tiikou/openclaw/actions/runs/36282662333/job/108517943532), run `36282662333`, attempt 2, used a CI harness workflow SHA `2487e2cdc3a6cde0bfb0328ddb4615d0fa5f6076`; its log explicitly checked out `7dad1d5` as the build target. The workflow commit is not the product source SHA.
- **Command:** `NODE_OPTIONS=--max-old-space-size=8192 pnpm build:ci-artifacts`. Job result `success`; `Build dist`, built-artifact checks, exact PR1 runtime packaging, and artifact upload all reported `success`. The overall broader workflow was cancelled after the needed job to avoid unrelated matrix work.
- `EVIDENCE_COMMAND=NODE_OPTIONS=--max-old-space-size=8192 pnpm build:ci-artifacts`; `EVIDENCE_EXIT_CODE=0`; `EVIDENCE_OUTPUT_SUMMARY=hosted Build dist, built-artifact checks, exact runtime packaging, and upload succeeded in job 108517943532`.
- **Artifact:** uploaded as `pr1-runtime-7dad1d50821330ffd4858d4edfdbf39f18b431b2`, artifact ID `10919780659`. Downloaded runtime tarball SHA256 `6fed8da2fd68ad5c4f3841f7a07d95a099a8fc0a277883d88fb95f236878c4db`; embedded build info identifies `7dad1d5`; the scoped installer verified 17 expected build roots and the digest before install.
- **Rollback artifact:** previous `a93e25d` runtime tarball SHA256 `bcd760fde57e2acf1003a2ce9939ccc4dda7309e80692d51eebc20e187e406ef` (17 roots, 15,412 files). Hosted runner peak build RSS was **not captured**.

## Independent review boundaries

- Grok returned `PASS_WITH_NOTES` for the earlier **CLI-only** SHA `1678bd8daf87a0f171c428f3c9bb16be9dab5f06`, whose three-file binary diff SHA256 was `438c276867c4fe0a1ff5bdf2716e28cec07b1a692f84ae5ab0f5bbb5c3471a61`. The lifecycle change was added later; that Grok review did **not** cover `7dad1d5`.
- Internal Luna review of the committed CLI plus lifecycle candidate `d6d3b9fd792ea3f5fea2fd0fe097fc7d6bfd2401` returned `PASS_WITH_NOTES`. Final `7dad1d5` added the canonical test-lane registry entry, then the final focused checks above ran. Neither review substitutes for production latency evidence.

## Production install and measured outcome

The previous installed source/build was `a93e25dddbe26bced9baf1b314455279bb45a9c4` (Gateway PID `382674`). The scoped artifact install reported exit code `0`, installed source/build `7dad1d50821330ffd4858d4edfdbf39f18b431b2`, and started Gateway PID `413023`. Gateway became `ready=true`, `degraded=false`, `NRestarts=0`; watchdog timer was active. Rollback target was the verified `a93e25d` source and artifact. The OpenClaw install did not restart Direct, webhook, or relay.

An equivalent no-inference explicit-Gateway CLI diagnostic measured `config-ready=92.231 ms` after install versus `40,775 ms` before. This measures **client preparation**, not provider inference. Three earlier synthetic `main` calls took 21,814/16,971/11,477 ms; the organic large-DB outlier shows why those samples did not establish a stable `main` route. Georgia's dedicated `georgia-comments` route produced four separate Gateway timings of 18,502/10,168/8,651/10,880 ms, detailed in PR #87's evidence document. The historical database and server-side stalls remain a separate layer from the CLI improvement.

## Private source provenance

Only basenames and SHA256 digests of source evidence are published. These files are not committed. Repeated filename stems refer to the specific private run summarized above.

| SOURCE_EVIDENCE_FILE_BASENAME | SOURCE_EVIDENCE_SHA256 |
| --- | --- |
| `FINAL-PRODUCTION-EVIDENCE.md` | `07f113abb9b5e675bd2be7a68277f1ad494948ff39f96e5b4948b27f7777bde1` |
| `MAINTENANCE-RESULT.md` | `8d033de21222c0fc7d76e88ead48c5877f73c262203b6090f3f54a52924eeeb8` |
| `GROK-REVIEW-PACKET.md` | `28d0612ade2ea1da0a2a5e87278d18740bd8d8e018e13e9c764829c6f8efb451` |
| `CONTINUATION-REPORT.md` | `950fa9b9d64fffa9df9f4fc1f792135080827990f5ea5f0aae63d5335205c52e` |
| `draft-pr-body.md` | `f070c11e6a1be395a9995ef46a0068f146076328290e47d77a49e5d0ef2309ea` |
| `pr1-final-verify-build.sh` | `fe0ef656e44316fdb31e90df67dd2aa4b57c751dfa9b9db70f000e7989a6ae07` |
| `sequence.log` | `9ec9be9aea78f499f01f92c5e0fef2a87f014268558746f762b52f2d7d2a2d47` |
| `cli-tests.log` | `cf77bb47b61e941948726f3386d0a3bc0de070ff1ffea138f72b21b7b649a9d4` |
| `infra-tests.log` | `7c763a7ed4f1d46fb8e2981d3c5732a5d2a280592bb14adc739bff6066a64dc5` |
| `typecheck.log` | `ae8394de25ce29e378b86687304c64f819f619b7d275d3a59664ece1a4054336` |
| `format.log` | `8ca4f73e43a938524181cb9c68dcb7e7bea013a0676d96d4877af8f8d92e5177` |
| `build.log` | `b6350c31b7efba78f45eb95e7ca07065838529a0ac7d3a844098a1eec6f5a3d7` |
| `events.log` (OpenClaw install) | `8cd52b1d921879dfc321d1b1b37f0a581a163e0647f8a159b3310ce734179856` |
| `timeline.jsonl` (after-install CLI) | `d209d63d889fb80cc9319b27ee6e310b0e9408c163107e644b3d327413e59418` |
| `openclaw-pr1-runtime.tar.gz.sha256` | `9546a8ce371cadc28f00b9945dde0dfe63c103aede1592530acc8fdf4bab0e4a` |

This document records past production actions. Preparing and committing it performed no new deployment, model probe, service restart, retry replay, or merge.
