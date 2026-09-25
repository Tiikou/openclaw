const params = JSON.parse(process.argv[2]);
const { register } = await import(params.sourceLoaderUrl);
register();

if (params.mode === "lifecycle") {
  const { acquireStateDatabaseCoordinator, withStateDatabaseCoordinatorRuntimeDirectory } =
    await import("../../infra/state-database-coordinator.ts");
  const result = await withStateDatabaseCoordinatorRuntimeDirectory(
    { ...params.runtime, keepAlive: false },
    () => {
      try {
        const lease = acquireStateDatabaseCoordinator({
          databasePath: params.statePath,
          busyTimeoutMs: 0,
        });
        lease.release();
        return { acquired: true };
      } catch (error) {
        return { acquired: false, family: error.family };
      }
    },
  );
  process.stdout.write(JSON.stringify(result));
} else if (params.mode === "agent-write") {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(params.agentPath);
  try {
    database.exec("PRAGMA busy_timeout = 0");
    database.exec("BEGIN IMMEDIATE");
    database.exec("ROLLBACK");
    process.stdout.write(JSON.stringify({ acquired: true }));
  } catch (error) {
    if (database.isTransaction) {
      database.exec("ROLLBACK");
    }
    process.stdout.write(
      JSON.stringify({ acquired: false, code: error.code, message: error.message }),
    );
  } finally {
    database.close();
  }
} else {
  throw new Error("Unknown foreign admission probe mode");
}
