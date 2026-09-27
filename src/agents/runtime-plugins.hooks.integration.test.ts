// Verifies hook dispatch follows configured policy and explicit agent registry scopes.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { createHookRunner } from "../plugins/hooks.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { clearActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import {
  loadAgentRuntimePluginRegistryHandle,
  withAgentPluginRegistry,
} from "./runtime-plugins.js";

afterEach(async () => {
  await clearActivePluginRegistry();
  resetPluginLoaderTestStateForTest();
});
afterAll(cleanupPluginLoaderFixturesForTest);

it("borrows a live plugin's typed hooks into a separate agent workspace exactly once", async () => {
  useNoBundledPlugins();
  const calls = path.join(makePluginLoaderTempDir(), "hook-calls");
  const plugin = writePlugin({
    id: "workspace-hook-owner",
    body: `module.exports = { id: "workspace-hook-owner", register(api) {
      if (api.registrationMode !== "full") return;
      const fs = require("node:fs");
      const log = (name) => fs.appendFileSync(${JSON.stringify(calls)}, name + "\\n");
      const context = "live-writer-context";
      api.on("before_agent_run", (event, ctx) => {
        if (ctx.agentId !== "georgia-content") return { outcome: "pass" };
        log("guard");
        return event.senderId === "owner" ? { outcome: "pass" } : { outcome: "block", reason: "not owner" };
      });
      api.on("before_prompt_build", (_event, ctx) => {
        if (ctx.agentId !== "georgia-content") return;
        log("context");
        return { prependContext: context };
      });
      api.on("llm_input", (_event, ctx) => {
        if (ctx.agentId === "georgia-content") log("llm_input");
      });
    }};`,
  });
  const config = {
    plugins: {
      allow: [plugin.id],
      load: { paths: [plugin.file] },
      entries: {
        [plugin.id]: {
          enabled: true,
          hooks: { allowConversationAccess: true, allowPromptInjection: true },
        },
      },
      slots: { memory: "none" },
    },
  } satisfies OpenClawConfig;
  const rootWorkspace = makePluginLoaderTempDir();
  const agentWorkspace = makePluginLoaderTempDir();
  const root = loadAndActivateRootPluginRegistry({
    cache: false,
    config,
    workspaceDir: rootWorkspace,
    onlyPluginIds: [plugin.id],
  });
  const metadataSnapshot = loadPluginMetadataSnapshot({ config, workspaceDir: agentWorkspace });
  const prepared = loadAgentRuntimePluginRegistryHandle({
    basePluginIds: [plugin.id],
    config,
    workspaceDir: agentWorkspace,
    metadataSnapshot,
  });
  expect(prepared).not.toBe(root);
  expect(root.typedHooks.map((hook) => hook.hookName)).toEqual([
    "before_agent_run",
    "before_prompt_build",
    "llm_input",
  ]);
  expect(
    prepared.plugins.map((record) => ({
      id: record.id,
      status: record.status,
      source: record.source,
    })),
  ).toEqual(expect.arrayContaining([expect.objectContaining({ id: plugin.id, status: "loaded" })]));
  expect(prepared.typedHooks.map((hook) => hook.hookName)).toEqual([
    "before_agent_run",
    "before_prompt_build",
    "llm_input",
  ]);
  await withPluginRuntimeGenerationScope(
    { metadataSnapshot, pluginRegistry: prepared },
    async () => {
      const runner = getGlobalHookRunner();
      if (!runner) {
        throw new Error("Expected the global hook runner to be initialized");
      }
      const ctx = { agentId: "georgia-content", sessionId: "writer-session" };
      const denied = await runner.runBeforeAgentRun(
        { senderId: "stranger", prompt: "write", messages: [] },
        ctx,
      );
      expect(denied?.decision.outcome).toBe("block");
      const allowed = await runner.runBeforeAgentRun(
        { senderId: "owner", prompt: "write", messages: [] },
        ctx,
      );
      expect(allowed?.decision.outcome).toBe("pass");
      await expect(
        runner.runBeforePromptBuild({ prompt: "write", messages: [] }, ctx),
      ).resolves.toEqual({
        prependContext: "live-writer-context",
      });
      await runner.runLlmInput(
        {
          runId: "writer-run",
          sessionId: "writer-session",
          provider: "test",
          model: "test",
          systemPrompt: "contract",
          prompt: "write",
          imagesCount: 0,
          historyMessages: [],
        },
        ctx,
      );
    },
  );
  expect(fs.readFileSync(calls, "utf8").trim().split("\n")).toEqual([
    "guard",
    "guard",
    "context",
    "llm_input",
  ]);
});

it("does not borrow hooks from a same-id plugin at a different source", () => {
  useNoBundledPlugins();
  const rootPlugin = writePlugin({
    id: "workspace-shadow-hook",
    body: `module.exports = { id: "workspace-shadow-hook", register(api) {
      if (api.registrationMode === "full") api.on("before_prompt_build", () => ({ prependContext: "root" }));
    }};`,
  });
  const shadowPlugin = writePlugin({
    id: rootPlugin.id,
    body: `module.exports = { id: "workspace-shadow-hook", register() {} };`,
  });
  const configFor = (file: string) =>
    ({
      plugins: {
        allow: [rootPlugin.id],
        load: { paths: [file] },
        entries: { [rootPlugin.id]: { enabled: true, hooks: { allowConversationAccess: true } } },
      },
    }) satisfies OpenClawConfig;
  loadAndActivateRootPluginRegistry({ cache: false, config: configFor(rootPlugin.file) });
  const prepared = loadAgentRuntimePluginRegistryHandle({
    basePluginIds: [rootPlugin.id],
    config: configFor(shadowPlugin.file),
    workspaceDir: makePluginLoaderTempDir(),
  });
  expect(prepared.typedHooks).toEqual([]);
});

it("does not borrow hooks when the prepared workspace has a different hook policy", () => {
  useNoBundledPlugins();
  const plugin = writePlugin({
    id: "workspace-policy-hook",
    body: `module.exports = { id: "workspace-policy-hook", register(api) {
      if (api.registrationMode === "full") api.on("before_prompt_build", () => ({ prependContext: "private" }));
    }};`,
  });
  const configFor = (allowPromptInjection: boolean) =>
    ({
      plugins: {
        allow: [plugin.id],
        load: { paths: [plugin.file] },
        entries: {
          [plugin.id]: {
            enabled: true,
            hooks: { allowConversationAccess: true, allowPromptInjection },
          },
        },
      },
    }) satisfies OpenClawConfig;
  const root = loadAndActivateRootPluginRegistry({
    cache: false,
    config: configFor(true),
    onlyPluginIds: [plugin.id],
  });
  expect(root.typedHooks.map((hook) => hook.hookName)).toEqual(["before_prompt_build"]);
  const prepared = loadAgentRuntimePluginRegistryHandle({
    basePluginIds: [plugin.id],
    config: configFor(false),
    workspaceDir: makePluginLoaderTempDir(),
  });
  expect(prepared.typedHooks).toEqual([]);
});

it("keeps a prepared registry alive after its temporary caller cache retires", async () => {
  useNoBundledPlugins();
  const closed = path.join(makePluginLoaderTempDir(), "closed");
  const plugin = writePlugin({
    id: "prepared-hook-owner",
    body: `module.exports = { id: "prepared-hook-owner", register(api) {
      api.on("before_prompt_build", async () => ({ prependContext: "prepared-owner" }));
      api.lifecycle.onDispose(() => require("node:fs").appendFileSync(${JSON.stringify(closed)}, "closed\\n"));
    }};`,
  });
  const config = {
    plugins: {
      allow: [plugin.id],
      load: { paths: [plugin.file] },
      entries: { [plugin.id]: { enabled: true, hooks: { allowConversationAccess: true } } },
      slots: { memory: "none" },
    },
  } satisfies OpenClawConfig;
  const workspaceDir = makePluginLoaderTempDir();
  const metadataCache = createPluginCache();
  const callerCache = createPluginCache();
  try {
    const metadataSnapshot = withPluginCache(metadataCache, () =>
      loadPluginMetadataSnapshot({ config, workspaceDir, allowCurrent: false }),
    );
    const registry = withPluginCache(callerCache, () =>
      loadAgentRuntimePluginRegistryHandle({ config, workspaceDir, metadataSnapshot }),
    );
    const record = registry.plugins.find(({ id }) => id === plugin.id);
    expect(record?.status).toBe("loaded");
    const instance = record && getPluginInstance(record);
    expect(instance).toBeDefined();
    const hooks = createHookRunner(registry, { catchErrors: false });
    await expect(
      hooks.runBeforePromptBuild({ prompt: "before", messages: [] }, {}),
    ).resolves.toEqual({
      prependContext: "prepared-owner",
    });

    await retirePluginCache(callerCache);
    expect(instance!.lifecycle.signal.aborted).toBe(false);
    expect(fs.existsSync(closed)).toBe(false);
    await expect(
      hooks.runBeforePromptBuild({ prompt: "after", messages: [] }, {}),
    ).resolves.toEqual({
      prependContext: "prepared-owner",
    });
    await retirePluginCache(metadataCache);
    expect(instance!.lifecycle.signal.aborted).toBe(true);
    expect(fs.readFileSync(closed, "utf8")).toBe("closed\n");
    await expect(
      hooks.runBeforePromptBuild({ prompt: "retired", messages: [] }, {}),
    ).rejects.toThrow("Plugin prepared-hook-owner was reloaded or disabled");
  } finally {
    await Promise.all([retirePluginCache(callerCache), retirePluginCache(metadataCache)]);
  }
});

it.each([
  "configured",
  "globally disabled",
  "disabled plugin",
  "not allowlisted",
  "denied plugin",
  "empty base",
  "empty request",
])("dispatches configured hooks while preserving %s scope", async (scope) => {
  useNoBundledPlugins();
  const pluginId = "prompt-hook-probe";
  const plugin = writePlugin({
    id: pluginId,
    body: `module.exports = {
  id: ${JSON.stringify(pluginId)},
  register(api) {
    api.on("before_prompt_build", async () => ({ prependContext: "hook-injected" }));
  },
};\n`,
  });
  const config = {
    plugins: {
      enabled: scope !== "globally disabled",
      ...(scope === "not allowlisted" ? { allow: ["other-plugin"] } : {}),
      ...(scope === "denied plugin" ? { deny: [pluginId] } : {}),
      entries: {
        [pluginId]: {
          enabled: scope !== "disabled plugin",
          hooks: { allowConversationAccess: true },
        },
      },
      load: { paths: [plugin.file] },
    },
  } satisfies OpenClawConfig;
  const workspaceDir = makePluginLoaderTempDir();
  const run = async (registry: PluginRegistry) => {
    const result = await createHookRunner(registry).runBeforePromptBuild(
      { prompt: "test", messages: [] },
      {},
    );
    expect(result?.prependContext).toBe(scope === "configured" ? "hook-injected" : undefined);
  };
  if (scope === "empty base") {
    await run(loadAgentRuntimePluginRegistryHandle({ config, workspaceDir, basePluginIds: [] }));
  } else if (scope === "empty request") {
    await withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), () =>
      withAgentPluginRegistry({ config, workspaceDir, run }),
    );
  } else {
    await withAgentPluginRegistry({ config, workspaceDir, run });
  }
});
