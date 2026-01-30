import { loadConfig, writeConfigFile } from "../../config/config.js";
import type { ModelProviderAuthMode, ModelProviderConfig } from "../../config/types.js";
import {
  resolveDefaultAgentId,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
} from "../../agents/agent-scope.js";
import { ensureAuthProfileStore, listProfilesForProvider } from "../../agents/auth-profiles.js";
import { normalizeProviderId } from "../../agents/model-selection.js";
import { resolvePluginProviders } from "../../plugins/providers.js";
import type { ProviderAuthMethod, ProviderPlugin } from "../../plugins/types.js";
import { createOAuthState } from "../oauth-state-store.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateModelsAuthApiKeySetParams,
  validateModelsAuthListParams,
  validateModelsAuthOAuthStartParams,
  validateModelsListParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

function resolveProviderMatch(
  providers: ProviderPlugin[],
  rawProvider: string,
): ProviderPlugin | null {
  const normalized = normalizeProviderId(rawProvider.trim());
  return (
    providers.find((p) => normalizeProviderId(p.id) === normalized) ??
    providers.find((p) => p.aliases?.some((a) => normalizeProviderId(a) === normalized) ?? false) ??
    null
  );
}

function pickOAuthMethod(provider: ProviderPlugin, rawMethod?: string): ProviderAuthMethod | null {
  const oauthMethods = provider.auth.filter((m) => m.kind === "oauth");
  if (oauthMethods.length === 0) return null;
  const raw = rawMethod?.trim();
  if (!raw) return oauthMethods[0] ?? null;
  const normalized = raw.toLowerCase();
  return (
    oauthMethods.find((m) => m.id.toLowerCase() === normalized) ??
    oauthMethods.find((m) => m.label.toLowerCase() === normalized) ??
    null
  );
}

function pickApiKeyOrTokenMethod(
  provider: ProviderPlugin,
  rawMethod?: string,
): ProviderAuthMethod | null {
  const methods = provider.auth.filter((m) => m.kind === "api_key" || m.kind === "token");
  if (methods.length === 0) return null;
  const raw = rawMethod?.trim();
  if (!raw) return methods[0] ?? null;
  const normalized = raw.toLowerCase();
  return (
    methods.find((m) => m.id.toLowerCase() === normalized) ??
    methods.find((m) => m.label.toLowerCase() === normalized) ??
    null
  );
}

export const modelsHandlers: GatewayRequestHandlers = {
  "models.list": async ({ params, respond, context }) => {
    if (!validateModelsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.list params: ${formatValidationErrors(validateModelsListParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const models = await context.loadGatewayModelCatalog();
      respond(true, { models }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "models.auth.list": async ({ params, respond }) => {
    if (!validateModelsAuthListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.auth.list params: ${formatValidationErrors(validateModelsAuthListParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const config = loadConfig();
      const defaultAgentId = resolveDefaultAgentId(config);
      const agentDir = resolveAgentDir(config, defaultAgentId);
      const workspaceDir = resolveAgentWorkspaceDir(config, defaultAgentId);
      const providers = resolvePluginProviders({ config, workspaceDir });
      let authStore: ReturnType<typeof ensureAuthProfileStore> | null = null;
      try {
        authStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
      } catch {
        // Auth store missing or unreadable; only API key connected state below.
      }
      const list = providers.map((p) => {
        const providerConfig = config.models?.providers?.[p.id];
        const hasApiKey =
          typeof providerConfig === "object" &&
          providerConfig !== null &&
          typeof (providerConfig as { apiKey?: string }).apiKey === "string" &&
          (providerConfig as { apiKey: string }).apiKey.trim().length > 0;
        const hasOAuthProfile =
          authStore !== null && listProfilesForProvider(authStore, p.id).length > 0;
        return {
          id: p.id,
          label: p.label,
          docsPath: p.docsPath,
          auth: p.auth.map((m) => ({
            id: m.id,
            label: m.label,
            hint: m.hint,
            kind: m.kind,
          })),
          connected: hasApiKey || hasOAuthProfile,
        };
      });
      respond(true, { providers: list }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "models.auth.oauthStart": async ({ params, respond }) => {
    if (!validateModelsAuthOAuthStartParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.auth.oauthStart params: ${formatValidationErrors(validateModelsAuthOAuthStartParams.errors)}`,
        ),
      );
      return;
    }
    const {
      providerId,
      methodId,
      redirectUri: baseRedirectUri,
      successRedirectBase,
    } = params as {
      providerId: string;
      methodId?: string;
      redirectUri?: string;
      successRedirectBase?: string;
    };
    try {
      const config = loadConfig();
      const defaultAgentId = resolveDefaultAgentId(config);
      const agentDir = resolveAgentDir(config, defaultAgentId);
      const workspaceDir = resolveAgentWorkspaceDir(config, defaultAgentId);
      const providers = resolvePluginProviders({ config, workspaceDir });
      const provider = resolveProviderMatch(providers, providerId);
      if (!provider) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `Unknown provider: ${providerId}`),
        );
        return;
      }
      const method = pickOAuthMethod(provider, methodId);
      if (!method) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `No OAuth auth method for provider ${providerId}`),
        );
        return;
      }
      if (!method.oauthStart) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            "OAuth from Control UI is not supported for this provider yet",
          ),
        );
        return;
      }
      const redirectUri = baseRedirectUri?.trim()
        ? `${baseRedirectUri.replace(/\/+$/, "")}/auth/callback`
        : undefined;
      if (!redirectUri) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "redirectUri is required for OAuth (gateway base URL)",
          ),
        );
        return;
      }
      const state = createOAuthState({
        providerId: provider.id,
        methodId: method.id,
        agentDir,
        workspaceDir,
        successRedirectBase: successRedirectBase?.trim() || undefined,
      });
      const { url } = await method.oauthStart({
        config,
        agentDir,
        workspaceDir,
        state,
        redirectUri,
      });
      respond(true, { url, state }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "models.auth.apiKeySet": async ({ params, respond }) => {
    if (!validateModelsAuthApiKeySetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.auth.apiKeySet params: ${formatValidationErrors(validateModelsAuthApiKeySetParams.errors)}`,
        ),
      );
      return;
    }
    const {
      providerId,
      methodId,
      apiKey: rawApiKey,
    } = params as {
      providerId: string;
      methodId?: string;
      apiKey: string;
    };
    const trimmed = typeof rawApiKey === "string" ? rawApiKey.trim() : "";
    if (!trimmed) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "apiKey is required and must be non-empty"),
      );
      return;
    }
    try {
      const config = loadConfig();
      const defaultAgentId = resolveDefaultAgentId(config);
      const workspaceDir = resolveAgentWorkspaceDir(config, defaultAgentId);
      const providers = resolvePluginProviders({ config, workspaceDir });
      const provider = resolveProviderMatch(providers, providerId);
      if (!provider) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `Unknown provider: ${providerId}`),
        );
        return;
      }
      const method = pickApiKeyOrTokenMethod(provider, methodId);
      if (!method) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `No API key or token auth method for provider ${providerId}`,
          ),
        );
        return;
      }
      const authMode = method.kind === "token" ? "token" : "api-key";
      const existing = config.models?.providers?.[provider.id];
      const defaultFromPlugin = provider.models;
      const base = existing ?? defaultFromPlugin;
      if (
        !base ||
        typeof base !== "object" ||
        typeof (base as { baseUrl?: string }).baseUrl !== "string" ||
        !Array.isArray((base as { models?: unknown[] }).models)
      ) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `Provider ${providerId} has no default config; add provider config first or use CLI.`,
          ),
        );
        return;
      }
      const baseConfig = base as ModelProviderConfig;
      const merged: ModelProviderConfig = {
        ...baseConfig,
        apiKey: trimmed,
        auth: authMode as ModelProviderAuthMode,
      };
      const nextModels = { ...config.models, providers: { ...config.models?.providers } };
      nextModels.providers[provider.id] = merged;
      await writeConfigFile({ ...config, models: nextModels });
      respond(true, { ok: true as const }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
};
