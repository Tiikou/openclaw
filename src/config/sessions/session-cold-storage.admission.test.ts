import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withOpenClawAgentDatabaseWrite } from "../../state/openclaw-agent-db-write.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  appendSqliteTrajectoryRuntimeEvents,
  loadSqliteTrajectoryRuntimeEvents,
} from "../../trajectory/runtime-store.sqlite.js";
import * as archiveWorkers from "./session-accessor.sqlite-archive.js";
import { loadTranscriptEventsSync } from "./session-accessor.sqlite-read.js";
import { readVerifiedSessionColdArchive } from "./session-cold-storage-codec.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";
import {
  restoreSessionColdTranscript,
  runSessionColdStorageMaintenance,
} from "./session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  currentId,
  historicalId,
  maintenanceConfig,
} from "./session-cold-storage.test-support.js";
import { waitForSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";

const execFileAsync = promisify(execFile);

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
  it("admits foreign lifecycle work before cold mutation dispatch and excludes foreign writes during commit", async () => {
    const fixture = await createFixture();
    const context = captureOpenClawStateWorkerContext();
    const historyBefore = loadTranscriptEventsSync(fixture.scope);
    const currentScope = { ...fixture.scope, sessionId: currentId };
    const currentBefore = loadTranscriptEventsSync(currentScope);
    const mutationDispatched = createDeferred<() => void>();
    const commitRequested = createDeferred<() => void>();
    const nativePostMessage = Worker.prototype.postMessage;
    const nativeEmit = EventEmitter.prototype.emit;
    const mutationWorkers = new WeakSet<Worker>();
    let mutationDispatchedOnce = false;
    const postMessage = vi
      .spyOn(Worker.prototype, "postMessage")
      .mockImplementation(function (this: Worker, message, transferList) {
        if (
          message !== null &&
          typeof message === "object" &&
          "type" in message &&
          message.type === "mutate" &&
          "coordination" in message &&
          !mutationDispatchedOnce
        ) {
          mutationWorkers.add(this);
          mutationDispatchedOnce = true;
          mutationDispatched.resolve(() => nativePostMessage.call(this, message, transferList));
          return;
        }
        return nativePostMessage.call(this, message, transferList);
      });
    const emit = vi.spyOn(Worker.prototype, "emit").mockImplementation(function (
      this: Worker,
      event: string | symbol,
      ...args: unknown[]
    ) {
      const message = args[0];
      if (
        mutationWorkers.has(this) &&
        event === "message" &&
        message !== null &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "commit-request"
      ) {
        emit.mockRestore();
        commitRequested.resolve(() => nativeEmit.call(this, event, ...args));
        return true;
      }
      return nativeEmit.call(this, event, ...args);
    });
    let maintenance: Promise<unknown> | undefined;
    let releaseMutation: (() => void) | undefined;
    let releaseCommit: (() => void) | undefined;
    try {
      maintenance = runSessionColdStorageMaintenance({
        config: maintenanceConfig(fixture.scope.storePath),
      });
      releaseMutation = await Promise.race([
        mutationDispatched.promise,
        maintenance.then(
          (result) => {
            throw new Error(
              `Cold maintenance settled before mutation dispatch: ${JSON.stringify(result)}`,
            );
          },
          (error: unknown) => {
            throw error;
          },
        ),
      ]);

      const beforeCommit = await inspectForeignAdmission({
        mode: "lifecycle",
        statePath: context.admission.databasePath,
        runtime: context.coordinatorRuntime,
      });

      releaseMutation();
      releaseMutation = undefined;
      releaseCommit = await commitRequested.promise;
      const lifecycleDuringCommit = await inspectForeignAdmission({
        mode: "lifecycle",
        statePath: context.admission.databasePath,
        runtime: context.coordinatorRuntime,
      });
      expect(lifecycleDuringCommit).toEqual({ acquired: false, family: "state-lifecycle" });
      const duringCommit = await inspectForeignAdmission({
        mode: "agent-write",
        agentPath: fixture.options.path,
      });
      expect(duringCommit.acquired).toBe(false);
      expect(duringCommit.message).toMatch(/locked|busy/iu);
      releaseCommit();

      await expect(maintenance).resolves.toEqual({
        archivedTranscripts: 1,
        externalizedTranscripts: 0,
      });
      const archive = readSessionColdTranscript(fixture.database(), historicalId);
      expect(archive).toMatchObject({ event_count: historyBefore.length });
      expect(archive).toBeDefined();
      if (!archive) {
        throw new Error("Cold archive metadata was not committed");
      }
      await readVerifiedSessionColdArchive({
        storePath: fixture.options.path,
        archive: { ...archive, archive_blob: null },
      });
      expect(loadTranscriptEventsSync(currentScope)).toEqual(currentBefore);

      await restoreSessionColdTranscript(fixture.scope);
      expect(loadTranscriptEventsSync(fixture.scope)).toEqual(historyBefore);
      const afterSettlement = await inspectForeignAdmission({
        mode: "lifecycle",
        statePath: context.admission.databasePath,
        runtime: context.coordinatorRuntime,
      });
      expect(afterSettlement).toEqual({ acquired: true });
      expect(beforeCommit).toEqual({ acquired: true });
    } finally {
      if (releaseMutation) {
        releaseMutation();
      }
      if (maintenance && !releaseCommit) {
        releaseCommit = await Promise.race([
          commitRequested.promise,
          maintenance.then(
            () => undefined,
            () => undefined,
          ),
        ]);
      }
      releaseCommit?.();
      emit.mockRestore();
      postMessage.mockRestore();
      await maintenance?.catch(() => {});
    }
  });

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
});

async function inspectForeignAdmission(params: {
  mode: "lifecycle" | "agent-write";
  statePath?: string;
  agentPath?: string;
  runtime?: ReturnType<typeof captureOpenClawStateWorkerContext>["coordinatorRuntime"];
}): Promise<{ acquired: boolean; family?: string; code?: string; message?: string }> {
  const child = await execFileAsync(
    process.execPath,
    [
      fileURLToPath(new URL("./session-cold-storage.admission.test-support.mjs", import.meta.url)),
      JSON.stringify({
        ...params,
        sourceLoaderUrl: import.meta.resolve("tsx/esm/api"),
      }),
    ],
    { timeout: 10_000, maxBuffer: 1_024 * 1_024 },
  );
  return JSON.parse(child.stdout) as {
    acquired: boolean;
    family?: string;
    code?: string;
    message?: string;
  };
}
