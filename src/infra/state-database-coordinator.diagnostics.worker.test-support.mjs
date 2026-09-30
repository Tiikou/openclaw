import { parentPort, workerData } from "node:worker_threads";

const { register } = await import(workerData.sourceLoaderUrl);
register();
const { setLoggerOverride, flushLogger } = await import(workerData.loggerUrl);
setLoggerOverride({ level: "info", consoleLevel: "silent", file: workerData.logFile });
const { acquireStateDatabaseCoordinator } = await import(workerData.coordinatorUrl);
const lease = acquireStateDatabaseCoordinator({
  ...workerData.params,
  operation: "wal-maintenance",
  diagnosticContext: { actor: "fixture-actor", command: "fixture.command", requestId: 7 },
});
await flushLogger();
parentPort.postMessage("held", []);
parentPort.once("message", async () => {
  lease.recordOperationOutcome?.("returned");
  lease.release();
  await flushLogger();
  parentPort.close();
});
