import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { performance } from "node:perf_hooks";
import { withOpenClawAgentDatabaseWrite } from "../../state/openclaw-agent-db-write.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import {
  appendSqliteTrajectoryRuntimeEvents,
  loadSqliteTrajectoryRuntimeEvents,
} from "../../trajectory/runtime-store.sqlite.js";
import * as archiveWorkers from "./session-accessor.sqlite-archive.js";
import { loadTranscriptEventsSync } from "./session-accessor.sqlite-read.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";
import { runSessionColdStorageMaintenance } from "./session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  currentId,
  historicalId,
  maintenanceConfig,
} from "./session-cold-storage.test-support.js";
import { waitForSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";

const tempDirs = createTempDirTracker();
const databasePaths: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const databasePath of databasePaths.splice(0)) {
    await waitForSessionTranscriptIndexReconcile({ agentId: "main", path: databasePath });
  }
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  tempDirs.cleanup();
});

async function createFixture() {
  const root = tempDirs.make("openclaw-cold-admission-");
  const storePath = path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite");
  databasePaths.push(storePath);
  return createSessionColdStorageFixture(storePath);
}

describe("cold transcript storage write admission", () => {
  it("queues a borrowed foreground write while a cold Worker owns admission", async () => {
    const fixture = await createFixture();
    const writerScope = { ...fixture.scope, sessionId: currentId };
    const currentBefore = loadTranscriptEventsSync(writerScope);
    const expectedDatabase = fixture.database();
    const writes: Promise<void>[] = [];
    let foregroundEntered = false;
    let enteredBeforeAuthorization: boolean | undefined;
    const originalWorker = archiveWorkers.runSqliteTranscriptArchiveWorkerOperation;
    vi.spyOn(archiveWorkers, "runSqliteTranscriptArchiveWorkerOperation").mockImplementation(
      (params) => {
        if (params.expectedMessageType !== "reclaimed") {
          return originalWorker(params);
        }
        let inWriteAdmission: ReturnType<typeof AsyncLocalStorage.snapshot> | undefined;
        return originalWorker({
          ...params,
          withWriteAdmission: (run, diagnostics) =>
            params.withWriteAdmission((refusal) => {
              inWriteAdmission = AsyncLocalStorage.snapshot();
              return run(refusal);
            }, diagnostics),
          onCommitRequest: () => {
            if (!inWriteAdmission) {
              throw new Error("Cold Worker requested commit without writer admission");
            }
            // Model a foreground callback created inside the Worker's actual writer section.
            inWriteAdmission(() => {
              const write = withOpenClawAgentDatabaseWrite(
                fixture.options,
                () => {
                  foregroundEntered = true;
                  appendSqliteTrajectoryRuntimeEvents(writerScope, [
                    {
                      traceSchema: "openclaw-trajectory",
                      schemaVersion: 1,
                      traceId: "cold-trajectory-writer",
                      source: "runtime",
                      type: "cold-admission-proof",
                      ts: new Date().toISOString(),
                      seq: 0,
                      sessionId: currentId,
                      sessionKey: writerScope.sessionKey,
                    },
                  ]);
                },
                expectedDatabase,
              );
              void write.catch(() => {});
              writes.push(write);
              enteredBeforeAuthorization = foregroundEntered;
            });
            params.onCommitRequest();
          },
        });
      },
    );
    const maintenance = await runSessionColdStorageMaintenance({
      config: maintenanceConfig(fixture.scope.storePath),
    }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    const outcomes = await Promise.allSettled(writes);
    expect(maintenance).toEqual({ result: { archivedTranscripts: 1, externalizedTranscripts: 0 } });
    expect(enteredBeforeAuthorization).toBe(false);
    expect(foregroundEntered).toBe(true);
    expect(writes).toHaveLength(1);
    expect(outcomes).toEqual(writes.map(() => ({ status: "fulfilled", value: undefined })));
    expect(
      (await loadSqliteTrajectoryRuntimeEvents(writerScope)).map((event) => event.type),
    ).toEqual(["cold-admission-proof"]);
    expect(readSessionColdTranscript(fixture.database(), historicalId)).toBeDefined();
    expect(loadTranscriptEventsSync(writerScope)).toEqual(currentBefore);
  });

  it("keeps main-thread shared-state writes admitted while a cold Worker is inside its native phase", async () => {
    const fixture = await createFixture();
    const writes: { elapsedMs: number; error?: unknown }[] = [];
    const originalWorker = archiveWorkers.runSqliteTranscriptArchiveWorkerOperation;
    vi.spyOn(archiveWorkers, "runSqliteTranscriptArchiveWorkerOperation").mockImplementation(
      (params) => {
        if (params.expectedMessageType !== "reclaimed") {
          return originalWorker(params);
        }
        return originalWorker({
          ...params,
          onCommitRequest: () => {
            // The Worker is blocked inside its native write phase awaiting this approval.
            // Gateway timers write shared state here (for example the cron session reaper);
            // lifecycle custody must stay with this realm so the write is not a foreign waiter.
            const startedAt = performance.now();
            try {
              runOpenClawStateWriteTransaction(({ db }) => db.prepare("SELECT 1").get());
              writes.push({ elapsedMs: performance.now() - startedAt });
            } catch (error) {
              writes.push({ elapsedMs: performance.now() - startedAt, error });
            }
            params.onCommitRequest();
          },
        });
      },
    );
    let lastTick = performance.now();
    let maxEventLoopGapMs = 0;
    const probe = setInterval(() => {
      const now = performance.now();
      maxEventLoopGapMs = Math.max(maxEventLoopGapMs, now - lastTick);
      lastTick = now;
    }, 25);
    let maintenance: { result: unknown } | { error: unknown };
    try {
      maintenance = await runSessionColdStorageMaintenance({
        config: maintenanceConfig(fixture.scope.storePath),
      }).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
    } finally {
      clearInterval(probe);
    }

    expect(writes).toHaveLength(1);
    expect(writes[0]?.error).toBeUndefined();
    // A foreign-realm holder turns this into a synchronous busy wait of the full budget.
    expect(writes[0]?.elapsedMs).toBeLessThan(1_000);
    expect(maxEventLoopGapMs).toBeLessThan(2_000);
    expect(maintenance).toEqual({ result: { archivedTranscripts: 1, externalizedTranscripts: 0 } });
    expect(readSessionColdTranscript(fixture.database(), historicalId)).toBeDefined();
  });
});
