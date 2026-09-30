import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { MessageChannel, Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  runWithSqliteCoordinator,
  tryAcquireExclusiveSqliteCoordinator,
} from "./sqlite-coordinator.js";
import { captureCoordinatorDatabase } from "./sqlite-coordinator.test-support.js";
import { acquireSqliteWorkerLifecycle } from "./sqlite-worker-lifecycle-preparation.js";
import { acquireStateDatabaseCoordinatorWithWait } from "./state-database-coordinator-acquisition.js";
import { startStateLifecycleDiagnostic } from "./state-database-coordinator-diagnostics.js";
import {
  acquireStateDatabaseCoordinator,
  attachStateLifecycleDelegate,
  resolveStateDatabaseCoordinatorPath,
  StateDatabaseCoordinatorContentionError,
  tryCreateStateLifecycleDelegate,
  withStateDatabaseCoordinatorRuntimeDirectory,
} from "./state-database-coordinator.js";

const { records, info, warn } = vi.hoisted(() => {
  const observations: Record<string, unknown>[] = [];
  return {
    records: observations,
    info: vi.fn((message: string, fields: Record<string, unknown>) => {
      if (message === "state lifecycle lock") {
        observations.push(fields);
      }
    }),
    warn: vi.fn(),
  };
});
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ isEnabled: () => true, info, warn, debug: vi.fn() }),
}));
const dirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  vi.stubEnv("OPENCLAW_DIAGNOSTICS", "sqlite.lifecycle");
  records.length = 0;
  info.mockClear();
  warn.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
function fixture() {
  const root = dirs.make("state-lock-diagnostics-");
  return { databasePath: path.join(root, "private-state.sqlite"), runtimeDirectory: root };
}

function observation(index: number): Record<string, unknown> {
  const record = records.at(index);
  if (!record) {
    throw new Error(`Missing lifecycle fixture observation ${index}`);
  }
  return record;
}

function phaseRecord(rows: Record<string, unknown>[], phase: string): Record<string, unknown> {
  const record = rows.find((row) => row.phase === phase);
  if (!record) {
    throw new Error(`Missing lifecycle fixture phase ${phase}`);
  }
  return record;
}

it("records normal native ownership, operation outcome and final release without warnings", () => {
  const params = fixture();
  const lease = acquireStateDatabaseCoordinator({ ...params, operation: "state-write" });
  expect(runWithSqliteCoordinator(lease, "fixture", () => 17)).toBe(17);
  expect(records.map((r) => r.phase)).toEqual([
    "acquired",
    "operation_settled",
    "reference_released",
    "released",
  ]);
  const acquired = observation(0);
  const settled = observation(1);
  const released = observation(3);
  expect(acquired).toMatchObject({ mode: "native", operation: "state-write", references: 1 });
  expect(settled.outcome).toBe("returned");
  expect(released).toMatchObject({
    ownerId: acquired.referenceId,
    closed: true,
    outcome: "closed",
  });
  expect(released.holdMs).toBeGreaterThanOrEqual(0);
  expect(acquired.acquiredAt).toEqual(expect.any(Number));
  expect(warn).not.toHaveBeenCalled();
});

it("distinguishes a relinquished reference from the final native owner", () => {
  const params = fixture();
  const first = acquireStateDatabaseCoordinator({ ...params, operation: "state-write" });
  const nested = acquireStateDatabaseCoordinator({ ...params, operation: "worker-retain" });
  const owner = observation(0).referenceId;
  expect(records[1]).toMatchObject({ mode: "reentrant", ownerId: owner, references: 2 });
  first.release();
  expect(records.filter((r) => r.phase === "released")).toHaveLength(0);
  nested.release();
  expect(records.filter((r) => r.phase === "released")).toHaveLength(1);
  expect(records.at(-1)).toMatchObject({ ownerId: owner, operation: "state-write", references: 0 });
});

it("preserves the original operation exception and still releases custody", () => {
  const lease = acquireStateDatabaseCoordinator({ ...fixture(), operation: "ownership" });
  const failure = new Error("fixture failure with private content");
  expect(() =>
    runWithSqliteCoordinator(lease, "fixture", () => {
      throw failure;
    }),
  ).toThrow(failure);
  expect(records.find((r) => r.phase === "operation_settled")?.outcome).toBe("threw");
  expect(lease.closed).toBe(true);
  expect(JSON.stringify(records)).not.toContain(failure.message);
});

it("joins a borrowed delegate to native custody without treating its release as an unlock", async () => {
  const params = { ...fixture(), actorId: "fixture-worker-binding" };
  await withStateDatabaseCoordinatorRuntimeDirectory(params.runtimeDirectory, async () => {
    const owner = acquireStateDatabaseCoordinator({ ...params, operation: "state-write" });
    const ownerId = observation(0).referenceId;
    const delegation = tryCreateStateLifecycleDelegate(params)!;
    const attached = await attachStateLifecycleDelegate(delegation.port, params);
    try {
      attached.run(() => {
        const borrowed = acquireStateDatabaseCoordinator({ ...params, operation: "ownership" });
        expect(records.at(-1)).toMatchObject({ mode: "delegated", ownerId });
        runWithSqliteCoordinator(borrowed, "fixture", () => 1);
      });
      expect(owner.closed).toBe(false);
      expect(records.filter((r) => r.phase === "released" && r.mode !== "delegated")).toEqual([]);
    } finally {
      attached.close();
      delegation.release();
      owner.release();
    }
    expect(records.at(-1)).toMatchObject({ ownerId, phase: "released", closed: true });
  });
});

it("records pending cleanup and recovery without reacquiring or double releasing a reference", () => {
  const params = fixture();
  const { result: lease, database } = captureCoordinatorDatabase(() =>
    acquireStateDatabaseCoordinator(params),
  );
  const close = vi.spyOn(database, "close").mockImplementationOnce(() => {
    throw new Error("fixture close");
  });
  try {
    expect(() => lease.release()).toThrow("failed to release state-lifecycle coordinator");
    expect(records.at(-1)).toMatchObject({
      phase: "release_failed",
      closed: false,
      references: 0,
      outcome: "custody-pending",
    });
    expect(database.isTransaction).toBe(false);
    expect(() => acquireStateDatabaseCoordinator(params)).toThrow("cleanup is pending");
    lease.release();
    expect(records.filter((r) => r.phase === "reference_released")).toHaveLength(1);
    expect(records.at(-1)).toMatchObject({ phase: "released", closed: true });
  } finally {
    close.mockRestore();
    lease.release();
  }
});

it("keeps tracing off by default and refuses arbitrary operation labels or raw identities", () => {
  const params = fixture();
  vi.stubEnv("OPENCLAW_DIAGNOSTICS", "off");
  acquireStateDatabaseCoordinator(params).release();
  expect(records).toEqual([]);
  vi.stubEnv("OPENCLAW_DIAGNOSTICS", "sqlite.lifecycle");
  const lease = acquireStateDatabaseCoordinator({
    ...params,
    // Deliberately exercise the runtime guard as well as the static type contract.
    operation: "private-session-key" as "state-write",
    diagnosticContext: { actor: "private-actor", command: "private-command", requestId: 7 },
  });
  lease.release();
  expect(observation(0).operation).toBe("unspecified");
  expect(observation(0).actorHash).toMatch(/^[a-f0-9]{16}$/);
  expect(observation(0).commandHash).toMatch(/^[a-f0-9]{16}$/);
  const text = JSON.stringify(records);
  for (const value of [
    params.databasePath,
    params.runtimeDirectory,
    "private-session-key",
    "private-actor",
    "private-command",
  ]) {
    expect(text).not.toContain(value);
  }
});

it("reports diagnostic sink loss later while preserving the original error and native release", () => {
  const params = fixture();
  info.mockImplementationOnce(() => {
    throw new Error("fixture sink");
  });
  const lease = acquireStateDatabaseCoordinator(params);
  const failure = new Error("original operation error");
  expect(() =>
    runWithSqliteCoordinator(lease, "fixture", () => {
      throw failure;
    }),
  ).toThrow(failure);
  expect(lease.closed).toBe(true);
  expect(records.some((r) => Number(r.omittedObservations) > 0)).toBe(true);
});

it("uses monotonic hold duration even when wall clock goes backwards", () => {
  let wall = 10_000;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => wall);
  try {
    const diagnostic = startStateLifecycleDiagnostic("fixture-lock", "ownership");
    diagnostic?.acquired("native");
    wall = 1;
    diagnostic?.emit("released", { closed: true });
    expect(records.at(-1)?.holdMs).toBeGreaterThanOrEqual(0);
    expect(records.at(-1)?.acquiredAt).toBe(10_000);
  } finally {
    clock.mockRestore();
  }
});

it("records cancellation after native acquisition and releases the unadmitted worker lease", async () => {
  const params = fixture();
  const { port1, port2 } = new MessageChannel();
  port1.on("message", (request) => {
    if (request.type === "check") {
      port1.postMessage({ type: "accepted" });
    } else if (request.type === "acquired") {
      port1.postMessage({ type: "cancel" });
    }
  });
  try {
    await expect(
      acquireSqliteWorkerLifecycle({
        port: port2,
        databasePath: params.databasePath,
        runtime: { directory: params.runtimeDirectory, keepAlive: false },
        deadlineNs: process.hrtime.bigint() + 5_000_000_000n,
        onUnsettled: vi.fn(),
      }),
    ).rejects.toThrow("SQLite lifecycle preparation was canceled");
    expect(records.find((r) => r.phase === "operation_settled")).toMatchObject({
      outcome: "cancelled",
    });
    expect(records.at(-1)).toMatchObject({ phase: "released", closed: true });
    acquireStateDatabaseCoordinator(params).release();
  } finally {
    port1.close();
    port2.close();
  }
});

it("links a same-PID native worker holder to an idle waiter and cancels another waiter without unlocking", async () => {
  const params = fixture();
  const logFile = path.join(params.runtimeDirectory, "fixture-worker.log");
  const worker = new Worker(
    new URL("./state-database-coordinator.diagnostics.worker.test-support.mjs", import.meta.url),
    {
      execArgv: [],
      workerData: {
        params,
        logFile,
        sourceLoaderUrl: import.meta.resolve("tsx/esm/api"),
        coordinatorUrl: new URL("./state-database-coordinator.ts", import.meta.url).href,
        loggerUrl: new URL("../logging/logger.ts", import.meta.url).href,
      },
    },
  );
  try {
    expect(await once(worker, "message")).toEqual(["held"]);
    let contention: unknown;
    try {
      acquireStateDatabaseCoordinator({
        ...params,
        operation: "idle-retirement",
        busyTimeoutMs: 0,
      });
    } catch (error) {
      contention = error;
    }
    expect(contention).toBeInstanceOf(StateDatabaseCoordinatorContentionError);
    const failed = records.find((r) => r.phase === "acquire_failed");
    expect(failed).toMatchObject({ operation: "idle-retirement", outcome: "contention" });
    expect((contention as StateDatabaseCoordinatorContentionError).diagnosticId).toBe(
      failed?.referenceId,
    );
    expect((contention as Error).message).toContain(`diagnosticId=${failed?.referenceId}`);
    const controller = new AbortController();
    const waiting = acquireStateDatabaseCoordinatorWithWait({
      databasePath: params.databasePath,
      operation: "session-admission",
      runtime: { directory: params.runtimeDirectory, keepAlive: false },
      deadlineMs: performance.now() + 5_000,
      signal: controller.signal,
    });
    controller.abort(new Error("private cancellation reason"));
    await expect(waiting).rejects.toThrow("private cancellation reason");
    const filename = resolveStateDatabaseCoordinatorPath({
      databasePath: params.databasePath,
      runtimeDirectory: params.runtimeDirectory,
      uid: process.getuid?.(),
    });
    expect(tryAcquireExclusiveSqliteCoordinator(filename)).toBeNull();
    const exited = once(worker, "exit");
    worker.postMessage("release", []);
    expect(await exited).toEqual([0]);
    const raw = fs.readFileSync(logFile, "utf8");
    const holderRecords = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const row: unknown = JSON.parse(line);
        return isRecord(row) && isRecord(row["1"]) ? row["1"] : undefined;
      })
      .filter((r): r is Record<string, unknown> => r?.lock === "state-lifecycle");
    const held = phaseRecord(holderRecords, "acquired");
    const released = phaseRecord(holderRecords, "released");
    expect(held).toMatchObject({
      lockId: failed?.lockId,
      operation: "wal-maintenance",
      pid: process.pid,
      isMainThread: false,
    });
    expect(held.threadId).not.toBe(failed?.threadId);
    expect(released).toMatchObject({ ownerId: held.referenceId, closed: true });
    expect(BigInt(String(held.acquiredMonoNs))).toBeLessThanOrEqual(
      BigInt(String(failed?.observedMonoNs)),
    );
    expect(BigInt(String(failed?.observedMonoNs))).toBeLessThan(
      BigInt(String(released.observedMonoNs)),
    );
    if (process.platform === "linux") {
      expect(failed?.blockingPid).toBe(process.pid);
    }
    expect(phaseRecord(holderRecords, "operation_settled").outcome).toBe("returned");
    expect(raw).not.toContain("fixture-actor");
    console.info(
      "synthetic state lifecycle evidence",
      JSON.stringify({ holder: held, waiter: failed, release: released }),
    );
    acquireStateDatabaseCoordinator({
      ...params,
      operation: "idle-retirement",
      busyTimeoutMs: 0,
    }).release();
  } finally {
    await worker.terminate();
  }
});
