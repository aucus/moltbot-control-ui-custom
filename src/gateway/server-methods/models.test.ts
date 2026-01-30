import { describe, expect, it, vi } from "vitest";

import type { ProviderPlugin } from "../../plugins/types.js";
import { modelsHandlers } from "./models.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  writeConfigFile: vi.fn(),
  resolvePluginProviders: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: () => mocks.loadConfig(),
  writeConfigFile: (cfg: unknown) => mocks.writeConfigFile(cfg),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: () => "main",
  resolveAgentDir: () => "/tmp/agent",
  resolveAgentWorkspaceDir: () => "/tmp/workspace",
}));

vi.mock("../../plugins/providers.js", () => ({
  resolvePluginProviders: (opts: unknown) => mocks.resolvePluginProviders(opts),
}));

function makeProviderWithApiKey(overrides?: Partial<ProviderPlugin>): ProviderPlugin {
  return {
    id: "test-provider",
    label: "Test Provider",
    auth: [
      {
        id: "api-key",
        label: "API Key",
        kind: "api_key",
        run: async () => ({ profiles: [] }),
      },
    ],
    models: {
      baseUrl: "https://api.example.com",
      models: [
        {
          id: "gpt-1",
          name: "GPT-1",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 4e3,
          maxTokens: 4e3,
        },
      ],
    },
    ...overrides,
  };
}

describe("models.auth.apiKeySet", () => {
  it("rejects invalid params (missing apiKey)", async () => {
    const respond = vi.fn();
    await modelsHandlers["models.auth.apiKeySet"]({
      params: { providerId: "test-provider" },
      respond,
      context: {} as never,
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("invalid") }),
    );
  });

  it("rejects empty apiKey", async () => {
    mocks.loadConfig.mockReturnValue({});
    mocks.resolvePluginProviders.mockReturnValue([makeProviderWithApiKey()]);

    const respond = vi.fn();
    await modelsHandlers["models.auth.apiKeySet"]({
      params: { providerId: "test-provider", apiKey: "   " },
      respond,
      context: {} as never,
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("apiKey") }),
    );
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("rejects unknown provider", async () => {
    mocks.loadConfig.mockReturnValue({});
    mocks.resolvePluginProviders.mockReturnValue([makeProviderWithApiKey()]);

    const respond = vi.fn();
    await modelsHandlers["models.auth.apiKeySet"]({
      params: { providerId: "unknown-provider", apiKey: "sk-xxx" },
      respond,
      context: {} as never,
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("Unknown provider") }),
    );
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("rejects provider without api_key/token method", async () => {
    const provider = makeProviderWithApiKey({
      auth: [{ id: "oauth", label: "OAuth", kind: "oauth", run: async () => ({ profiles: [] }) }],
    });
    mocks.loadConfig.mockReturnValue({});
    mocks.resolvePluginProviders.mockReturnValue([provider]);

    const respond = vi.fn();
    await modelsHandlers["models.auth.apiKeySet"]({
      params: { providerId: "test-provider", apiKey: "sk-xxx" },
      respond,
      context: {} as never,
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("No API key or token") }),
    );
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("rejects provider without default config (no models)", async () => {
    const provider = makeProviderWithApiKey({ models: undefined });
    mocks.loadConfig.mockReturnValue({});
    mocks.resolvePluginProviders.mockReturnValue([provider]);

    const respond = vi.fn();
    await modelsHandlers["models.auth.apiKeySet"]({
      params: { providerId: "test-provider", apiKey: "sk-xxx" },
      respond,
      context: {} as never,
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("no default config") }),
    );
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("writes merged provider config and responds ok", async () => {
    mocks.loadConfig.mockReturnValue({});
    mocks.resolvePluginProviders.mockReturnValue([makeProviderWithApiKey()]);
    mocks.writeConfigFile.mockResolvedValue(undefined);

    const respond = vi.fn();
    await modelsHandlers["models.auth.apiKeySet"]({
      params: { providerId: "test-provider", apiKey: "sk-secret" },
      respond,
      context: {} as never,
    });

    expect(mocks.writeConfigFile).toHaveBeenCalledTimes(1);
    const written = mocks.writeConfigFile.mock.calls[0][0];
    expect(written).toHaveProperty("models.providers.test-provider");
    expect(
      (written as { models?: { providers?: Record<string, unknown> } }).models?.providers?.[
        "test-provider"
      ],
    ).toMatchObject({
      apiKey: "sk-secret",
      auth: "api-key",
      baseUrl: "https://api.example.com",
    });
    expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
  });
});
