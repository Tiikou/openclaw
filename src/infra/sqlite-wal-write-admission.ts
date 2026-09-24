import type { DatabaseSync } from "node:sqlite";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { assertTransactionUsable } from "./sqlite-transaction.js";

type MaintenanceAdmission = {
  admit: (operation: () => void) => Promise<void>;
  flush?: (assertCurrent: () => void) => void;
  cancel?: () => void;
};

const admissions = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteWalWriteAdmissions"),
  () => new WeakMap<DatabaseSync, MaintenanceAdmission>(),
);

export function registerSqliteWalWriteAdmission(
  database: DatabaseSync,
  admit: MaintenanceAdmission["admit"],
  cancel?: MaintenanceAdmission["cancel"],
): void {
  admissions.set(database, { admit, cancel });
}

export function cancelSqliteWalWriteAdmission(database: DatabaseSync): void {
  admissions.get(database)?.cancel?.();
}

export function createSqliteWalMaintenanceScheduler(
  database: DatabaseSync,
  operation: () => void,
  onError: (error: unknown) => void,
): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    const admission = admissions.get(database);
    if (!admission) {
      operation();
      return Promise.resolve();
    }
    // Callers may observe completion; the admitted operation still runs once per pending slot.
    pending ??= admission
      .admit(operation)
      .catch(onError)
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
}

/** Retained Workers drain timer work only while their parent grants write admission. */
export function registerDeferredSqliteWalWriteAdmission(
  database: DatabaseSync,
): (assertCurrent: () => void) => void {
  const existing = admissions.get(database)?.flush;
  if (existing) {
    return existing;
  }
  let pending:
    | { operation: () => void; resolve: () => void; reject: (error: unknown) => void }
    | undefined;
  const flush = (assertCurrent: () => void) => {
    const current = pending;
    pending = undefined;
    if (current) {
      try {
        assertCurrent();
        current.operation();
        current.resolve();
      } catch (error) {
        current.reject(error);
      }
    }
    // Maintenance can catch the primary error before returning to its admission owner.
    // Unsettled native state must still reach the caller that retains the writer.
    if (database.isOpen && database.isTransaction) {
      assertTransactionUsable(database);
    }
  };
  admissions.set(database, {
    admit: (operation) =>
      new Promise<void>((resolve, reject) => {
        pending = { operation, resolve, reject };
      }),
    flush,
    cancel: () => {
      pending?.resolve();
      pending = undefined;
    },
  });
  return flush;
}
