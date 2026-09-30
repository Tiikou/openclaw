import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isMainThread, threadId } from "node:worker_threads";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isDiagnosticFlagEnabled } from "./diagnostic-flags.js";
import {
  getActiveDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "./diagnostic-trace-context.js";
import { captureSqliteReaderOwner } from "./sqlite-reader-lifecycle.js";

const operations = [
  "unspecified",
  "state-write",
  "ownership",
  "idle-retirement",
  "explicit-retirement",
  "file-exclusion",
  "lease-exclusion",
  "lease-heartbeat",
  "session-admission",
  "mutation-worker-admission",
  "wal-maintenance",
  "doctor-maintenance",
  "doctor-skill-workshop",
  "device-identity",
  "worker-delegate",
  "worker-retain",
] as const;
export type StateLifecycleOperation = (typeof operations)[number];
export type StateLifecycleDiagnosticContext = {
  actor?: string;
  command?: string;
  requestId?: number;
};
const log = createSubsystemLogger("state/coordinator");

let omittedObservations = 0;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

type Phase =
  | "acquired"
  | "acquire_failed"
  | "reference_released"
  | "operation_settled"
  | "released"
  | "release_failed";
type Observation = {
  mode?: "native" | "reentrant" | "delegated";
  ownerId?: string;
  references?: number;
  lastReferenceId?: string;
  closed?: boolean;
  blockingPid?: number;
  blockingStartTime?: number;
  outcome?:
    | "returned"
    | "threw"
    | "cancelled"
    | "retained-unsettled"
    | "contention"
    | "error"
    | "closed"
    | "closed-with-error"
    | "custody-pending";
};

/** Observations are never authority, and a failing diagnostic sink cannot change custody. */
export function startStateLifecycleDiagnostic(
  coordinatorPath: string,
  operation: StateLifecycleOperation = "unspecified",
  context?: StateLifecycleDiagnosticContext,
) {
  try {
    if (!isDiagnosticFlagEnabled("sqlite.lifecycle") || !log.isEnabled("info")) {
      return undefined;
    }
    const id = randomUUID();
    const trace = getActiveDiagnosticTraceContext();
    const readerOwner = captureSqliteReaderOwner();
    const ownerContext: StateLifecycleDiagnosticContext | undefined =
      context ??
      (readerOwner
        ? {
            actor: readerOwner.actorId === undefined ? undefined : String(readerOwner.actorId),
            command: readerOwner.operation,
          }
        : undefined);
    const fields = {
      lock: "state-lifecycle",
      lockId: digest(coordinatorPath),
      referenceId: id,
      operation: operations.includes(operation) ? operation : "unspecified",
      pid: process.pid,
      threadId,
      isMainThread,
      ...(ownerContext?.actor && ownerContext.actor.length <= 128
        ? { actorHash: digest(ownerContext.actor) }
        : {}),
      ...(ownerContext?.command && ownerContext.command.length <= 128
        ? { commandHash: digest(ownerContext.command) }
        : {}),
      ...(Number.isSafeInteger(ownerContext?.requestId)
        ? { requestHash: digest(String(ownerContext?.requestId)) }
        : {}),
    };
    let acquiredAt: number | undefined;
    let acquiredMono: number | undefined;
    let acquiredMonoNs: string | undefined;
    let operationOutcome: Observation["outcome"];
    const emit = (phase: Phase, details: Observation) => {
      try {
        if (phase === "operation_settled") {
          operationOutcome = details.outcome;
        }
        runWithDiagnosticTraceContext(trace, () =>
          log.info("state lifecycle lock", {
            ...fields,
            phase,
            observedAt: Date.now(),
            observedMonoNs: process.hrtime.bigint().toString(),
            acquiredAt,
            acquiredMonoNs,
            holdMs: acquiredMono === undefined ? undefined : performance.now() - acquiredMono,
            operationOutcome,
            omittedObservations,
            ...details,
          }),
        );
        omittedObservations = 0;
      } catch {
        // Explicitly report lost observations on the next successful record.
        omittedObservations++;
      }
    };
    return {
      id,
      emit,
      acquired(mode: "native" | "reentrant" | "delegated", ownerId?: string, references?: number) {
        try {
          acquiredAt = Date.now();
          acquiredMono = performance.now();
          acquiredMonoNs = process.hrtime.bigint().toString();
          emit("acquired", { mode, ownerId: ownerId ?? id, references });
        } catch {
          omittedObservations++;
        }
      },
    };
  } catch {
    omittedObservations++;
    return undefined;
  }
}
export type StateLifecycleDiagnostic = ReturnType<typeof startStateLifecycleDiagnostic>;
