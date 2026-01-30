import { Type } from "@sinclair/typebox";

import { NonEmptyString } from "./primitives.js";

export const ModelChoiceSchema = Type.Object(
  {
    id: NonEmptyString,
    name: NonEmptyString,
    provider: NonEmptyString,
    contextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
    reasoning: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const AgentSummarySchema = Type.Object(
  {
    id: NonEmptyString,
    name: Type.Optional(NonEmptyString),
    identity: Type.Optional(
      Type.Object(
        {
          name: Type.Optional(NonEmptyString),
          theme: Type.Optional(NonEmptyString),
          emoji: Type.Optional(NonEmptyString),
          avatar: Type.Optional(NonEmptyString),
          avatarUrl: Type.Optional(NonEmptyString),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const AgentsListParamsSchema = Type.Object({}, { additionalProperties: false });

export const AgentsListResultSchema = Type.Object(
  {
    defaultId: NonEmptyString,
    mainKey: NonEmptyString,
    scope: Type.Union([Type.Literal("per-sender"), Type.Literal("global")]),
    agents: Type.Array(AgentSummarySchema),
  },
  { additionalProperties: false },
);

export const ModelsListParamsSchema = Type.Object({}, { additionalProperties: false });

export const ModelsListResultSchema = Type.Object(
  {
    models: Type.Array(ModelChoiceSchema),
  },
  { additionalProperties: false },
);

export const SkillsStatusParamsSchema = Type.Object({}, { additionalProperties: false });

export const SkillsBinsParamsSchema = Type.Object({}, { additionalProperties: false });

export const SkillsBinsResultSchema = Type.Object(
  {
    bins: Type.Array(NonEmptyString),
  },
  { additionalProperties: false },
);

export const SkillsInstallParamsSchema = Type.Object(
  {
    name: NonEmptyString,
    installId: NonEmptyString,
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1000 })),
  },
  { additionalProperties: false },
);

export const SkillsUpdateParamsSchema = Type.Object(
  {
    skillKey: NonEmptyString,
    enabled: Type.Optional(Type.Boolean()),
    apiKey: Type.Optional(Type.String()),
    env: Type.Optional(Type.Record(NonEmptyString, Type.String())),
  },
  { additionalProperties: false },
);

// ---------------------------------------------------------------------------
// models.auth.list / models.auth.oauthStart (provider auth for Control UI)
// ---------------------------------------------------------------------------

export const ModelsAuthListParamsSchema = Type.Object({}, { additionalProperties: false });

export const ProviderAuthMethodListSchema = Type.Object(
  {
    id: NonEmptyString,
    label: NonEmptyString,
    hint: Type.Optional(Type.String()),
    kind: Type.String(),
  },
  { additionalProperties: false },
);

export const ProviderAuthListEntrySchema = Type.Object(
  {
    id: NonEmptyString,
    label: NonEmptyString,
    docsPath: Type.Optional(Type.String()),
    auth: Type.Array(ProviderAuthMethodListSchema),
    /** True when this provider already has API key or auth in config (for UI "Connected" badge). */
    connected: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const ModelsAuthListResultSchema = Type.Object(
  {
    providers: Type.Array(ProviderAuthListEntrySchema),
  },
  { additionalProperties: false },
);

export const ModelsAuthOAuthStartParamsSchema = Type.Object(
  {
    providerId: NonEmptyString,
    methodId: Type.Optional(Type.String()),
    /** Base URL for OAuth callback (e.g. https://gateway.example.com). Callback will be {redirectUri}/auth/callback */
    redirectUri: Type.Optional(Type.String()),
    /** Base URL for success redirect (e.g. Control UI origin + /providers). Callback will redirect to {successRedirectBase}?oauth=success */
    successRedirectBase: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ModelsAuthOAuthStartResultSchema = Type.Object(
  {
    url: NonEmptyString,
    state: NonEmptyString,
  },
  { additionalProperties: false },
);

// models.auth.apiKeySet (API key / token for Control UI)
export const ModelsAuthApiKeySetParamsSchema = Type.Object(
  {
    providerId: NonEmptyString,
    methodId: Type.Optional(Type.String()),
    apiKey: Type.String(),
  },
  { additionalProperties: false },
);

export const ModelsAuthApiKeySetResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
  },
  { additionalProperties: false },
);
