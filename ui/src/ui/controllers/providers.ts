import type { GatewayBrowserClient } from "../gateway";

export type ProviderAuthMethodList = {
  id: string;
  label: string;
  hint?: string;
  kind: string;
};

export type ProviderAuthListEntry = {
  id: string;
  label: string;
  docsPath?: string;
  auth: ProviderAuthMethodList[];
  /** True when this provider has API key or auth in config. */
  connected?: boolean;
};

export type ProvidersListResult = {
  providers: ProviderAuthListEntry[];
};

export type ProvidersState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  providersLoading: boolean;
  providersList: ProvidersListResult | null;
  providersError: string | null;
  oauthStarting: string | null;
};

function gatewayBaseUrl(wsUrl: string): string {
  try {
    const url = new URL(wsUrl);
    const protocol = url.protocol === "wss:" ? "https:" : "http:";
    return `${protocol}//${url.host}`;
  } catch {
    return "";
  }
}

export async function loadProviders(state: ProvidersState) {
  if (!state.client || !state.connected) return;
  if (state.providersLoading) return;
  state.providersLoading = true;
  state.providersError = null;
  try {
    const res = (await state.client.request("models.auth.list", {})) as
      | ProvidersListResult
      | undefined;
    if (res) state.providersList = res;
  } catch (err) {
    state.providersError = String(err);
  } finally {
    state.providersLoading = false;
  }
}

export async function startOAuth(
  state: ProvidersState,
  providerId: string,
  methodId?: string,
): Promise<{ url: string; state: string } | null> {
  if (!state.client || !state.connected) return null;
  const baseUrl = gatewayBaseUrl(state.client.opts?.url ?? "");
  if (!baseUrl) {
    state.providersError = "Could not determine gateway URL for OAuth callback.";
    return null;
  }
  state.oauthStarting = providerId;
  state.providersError = null;
  try {
    const successBase =
      typeof window !== "undefined"
        ? `${window.location.origin}${window.location.pathname.replace(/\/+$/, "")}/providers`
        : "";
    const res = (await state.client.request("models.auth.oauthStart", {
      providerId,
      methodId,
      redirectUri: baseUrl,
      successRedirectBase: successBase,
    })) as { url?: string; state?: string } | undefined;
    if (res?.url && res?.state) {
      return { url: res.url, state: res.state };
    }
    return null;
  } catch (err) {
    state.providersError = String(err);
    return null;
  } finally {
    state.oauthStarting = null;
  }
}

export async function saveApiKey(
  state: ProvidersState,
  providerId: string,
  apiKey: string,
  methodId?: string,
): Promise<boolean> {
  if (!state.client || !state.connected) return false;
  state.providersError = null;
  try {
    await state.client.request("models.auth.apiKeySet", {
      providerId,
      methodId,
      apiKey: apiKey.trim(),
    });
    return true;
  } catch (err) {
    state.providersError = String(err);
    return false;
  }
}
