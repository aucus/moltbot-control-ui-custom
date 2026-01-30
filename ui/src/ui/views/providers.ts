import { html, nothing } from "lit";

import type { ProviderAuthListEntry, ProviderAuthMethodList } from "../controllers/providers";

export type ProvidersProps = {
  loading: boolean;
  list: ProviderAuthListEntry[] | null;
  error: string | null;
  oauthStarting: string | null;
  apiKeySaving: string | null;
  oauthSuccess: boolean | null;
  oauthError: string | null;
  basePath: string;
  onRefresh: () => void;
  onOAuthStart: (providerId: string, methodId?: string) => void;
  onApiKeySave: (providerId: string, apiKey: string, methodId?: string) => void;
  onDismissOAuthResult: () => void;
};

export function renderProviders(props: ProvidersProps) {
  const providers = props.list?.providers ?? [];

  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Providers</div>
          <div class="card-sub">Connect LLM providers (OAuth or API key).</div>
        </div>
        <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${props.loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      ${props.oauthSuccess
        ? html`
            <div class="callout info" style="margin-top: 14px;">
              Provider connected. You can close the OAuth tab and use models from this provider.
              <button class="btn btn--sm" style="margin-left: 8px;" @click=${props.onDismissOAuthResult}>
                Dismiss
              </button>
            </div>
          `
        : nothing}
      ${props.oauthError
        ? html`
            <div class="callout danger" style="margin-top: 14px;">
              ${props.oauthError}
              <button class="btn btn--sm" style="margin-left: 8px;" @click=${props.onDismissOAuthResult}>
                Dismiss
              </button>
            </div>
          `
        : nothing}

      ${props.error
        ? html`<div class="callout danger" style="margin-top: 12px;">${props.error}</div>`
        : nothing}

      ${providers.length === 0 && !props.loading
        ? html`<div class="muted" style="margin-top: 16px;">No connectable providers found.</div>`
        : html`
            <div class="list" style="margin-top: 16px;">
              ${providers.map((p) => renderProvider(p, props))}
            </div>
          `}
    </section>
  `;
}

function renderProvider(
  provider: ProviderAuthListEntry,
  props: ProvidersProps,
) {
  const oauthMethods = provider.auth.filter((m) => m.kind === "oauth");
  const apiKeyMethods = provider.auth.filter(
    (m) => m.kind === "api_key" || m.kind === "token",
  );
  const otherMethods = provider.auth.filter(
    (m) => m.kind !== "oauth" && m.kind !== "api_key" && m.kind !== "token",
  );

  return html`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">
          ${provider.label}
          ${provider.connected
            ? html`<span class="chip chip-ok" style="margin-left: 8px;">Connected</span>`
            : nothing}
        </div>
        ${provider.docsPath
          ? html`<div class="list-sub"><a href="${provider.docsPath}" target="_blank" rel="noreferrer" class="session-link">Docs</a></div>`
          : nothing}
        <div class="chip-row" style="margin-top: 8px;">
          ${oauthMethods.map(
            (m) => html`
              <span class="chip">${m.label}</span>
              <button
                class="btn btn--sm"
                ?disabled=${props.oauthStarting === provider.id}
                @click=${() => props.onOAuthStart(provider.id, m.id)}
              >
                ${props.oauthStarting === provider.id ? "Opening…" : "Connect"}
              </button>
            `,
          )}
          ${apiKeyMethods.map(
            (m) => html`
              <span class="chip">${m.label}</span>
              <input
                type="password"
                class="cfg-input cfg-input--sm"
                placeholder=${m.hint ?? "API key"}
                data-provider-id=${provider.id}
                data-method-id=${m.id}
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === "Enter") {
                    const input = e.target as HTMLInputElement;
                    const providerId = input.dataset.providerId ?? "";
                    const methodId = input.dataset.methodId || undefined;
                    props.onApiKeySave(providerId, input.value, methodId);
                  }
                }}
              />
              <button
                class="btn btn--sm"
                ?disabled=${props.apiKeySaving === provider.id}
                @click=${(e: Event) => {
                  const input = (e.target as HTMLElement)
                    .previousElementSibling as HTMLInputElement | null;
                  if (input?.value?.trim()) {
                    props.onApiKeySave(
                      provider.id,
                      input.value.trim(),
                      m.id,
                    );
                  }
                }}
              >
                ${props.apiKeySaving === provider.id ? "Saving…" : "Save"}
              </button>
            `,
          )}
          ${otherMethods.length > 0
            ? html`<span class="chip muted">${otherMethods.map((m) => m.label).join(", ")}</span>`
            : nothing}
        </div>
      </div>
    </div>
  `;
}
