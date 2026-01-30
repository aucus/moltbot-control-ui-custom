import type { IncomingMessage, ServerResponse } from "node:http";

import { upsertAuthProfile } from "../agents/auth-profiles.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import {
  loadConfig,
  readConfigFileSnapshot,
  validateConfigObjectWithPlugins,
  writeConfigFile,
} from "../config/config.js";
import { applyLegacyMigrations } from "../config/legacy.js";
import { applyMergePatch } from "../config/merge-patch.js";
import { applyAuthProfileConfig } from "../commands/onboard-auth.js";
import { resolvePluginProviders } from "../plugins/providers.js";
import type { ProviderAuthMethod, ProviderPlugin } from "../plugins/types.js";
import { consumeOAuthState } from "./oauth-state-store.js";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function mergeConfigPatch<T>(base: T, patch: unknown): T {
  if (!isPlainRecord(base) || !isPlainRecord(patch)) {
    return patch as T;
  }
  const next: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const existing = next[key];
    if (isPlainRecord(existing) && isPlainRecord(value)) {
      next[key] = mergeConfigPatch(existing, value);
    } else {
      next[key] = value;
    }
  }
  return next as T;
}

function credentialMode(cred: { type: string }): "api_key" | "oauth" | "token" {
  if (cred.type === "api_key") return "api_key";
  if (cred.type === "token") return "token";
  return "oauth";
}

function resolveProviderMatch(
  providers: ProviderPlugin[],
  providerId: string,
): ProviderPlugin | null {
  const normalized = normalizeProviderId(providerId);
  return (
    providers.find((p) => normalizeProviderId(p.id) === normalized) ??
    providers.find((p) => p.aliases?.some((a) => normalizeProviderId(a) === normalized) ?? false) ??
    null
  );
}

function findOAuthMethod(provider: ProviderPlugin, methodId: string): ProviderAuthMethod | null {
  return (
    provider.auth.find(
      (m) =>
        m.kind === "oauth" &&
        (m.id === methodId || m.label.toLowerCase() === methodId.toLowerCase()),
    ) ?? null
  );
}

function buildRedirectUri(req: IncomingMessage): string {
  const host = req.headers.host ?? "localhost";
  const socket = req.socket as { encrypted?: boolean } | undefined;
  const protocol = socket?.encrypted ? "https" : "http";
  return `${protocol}://${host}/auth/callback`;
}

export type AuthCallbackOptions = {
  controlUiBasePath: string;
};

/**
 * Handles GET /auth/callback?state=...&code=... (OAuth callback from provider).
 * Consumes state, exchanges code via plugin oauthCallback, writes auth profiles and config,
 * then redirects to Control UI success or error page.
 */
export async function handleAuthCallbackRequest(
  req: IncomingMessage,
  res: ServerResponse,
  _opts: AuthCallbackOptions,
): Promise<boolean> {
  if (req.method !== "GET") return false;
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname !== "/auth/callback") return false;

  const state = url.searchParams.get("state")?.trim();
  const code = url.searchParams.get("code")?.trim();
  const errorParam = url.searchParams.get("error")?.trim();

  const redirectUri = buildRedirectUri(req);

  const redirectToSuccess = (base?: string) => {
    const to = base ? `${base.replace(/\/+$/, "")}?oauth=success` : "/?oauth=success";
    res.statusCode = 302;
    res.setHeader("Location", to);
    res.end();
  };

  const redirectToError = (message: string, base?: string) => {
    const encoded = encodeURIComponent(message);
    const to = base
      ? `${base.replace(/\/+$/, "")}?oauth=error&message=${encoded}`
      : `/?oauth=error&message=${encoded}`;
    res.statusCode = 302;
    res.setHeader("Location", to);
    res.end();
  };

  if (errorParam) {
    const msg = url.searchParams.get("error_description")?.trim() || errorParam;
    redirectToError(msg);
    return true;
  }

  if (!state || !code) {
    redirectToError("Missing state or code");
    return true;
  }

  const entry = consumeOAuthState(state);
  if (!entry) {
    redirectToError("Invalid or expired state");
    return true;
  }

  try {
    const config = loadConfig();
    const workspaceDir = entry.workspaceDir;
    const providers = resolvePluginProviders({ config, workspaceDir });
    const provider = resolveProviderMatch(providers, entry.providerId);
    const method = provider ? findOAuthMethod(provider, entry.methodId) : null;

    if (!provider || !method?.oauthCallback) {
      redirectToError("Provider or OAuth method not found", entry.successRedirectBase);
      return true;
    }

    const result = await method.oauthCallback({
      config,
      agentDir: entry.agentDir,
      workspaceDir: entry.workspaceDir,
      state,
      code,
      redirectUri,
    });

    for (const profile of result.profiles) {
      upsertAuthProfile({
        profileId: profile.profileId,
        credential: profile.credential,
        agentDir: entry.agentDir,
      });
    }

    const snapshot = await readConfigFileSnapshot();
    if (snapshot.valid) {
      let next = snapshot.config;
      if (result.configPatch) {
        next = mergeConfigPatch(next, result.configPatch);
      }
      for (const profile of result.profiles) {
        next = applyAuthProfileConfig(next, {
          profileId: profile.profileId,
          provider: profile.credential.provider,
          mode: credentialMode(profile.credential),
        });
      }
      const migrated = applyLegacyMigrations(next);
      const resolved = migrated.next ?? next;
      const validated = validateConfigObjectWithPlugins(resolved);
      if (validated.ok) {
        await writeConfigFile(validated.config);
      }
    }

    redirectToSuccess(entry.successRedirectBase);
  } catch (err) {
    redirectToError(String(err), entry.successRedirectBase);
  }

  return true;
}
