import { randomBytes } from "node:crypto";

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export type OAuthStateEntry = {
  providerId: string;
  methodId: string;
  agentDir: string | undefined;
  workspaceDir: string;
  /** Base URL to redirect to on success (e.g. Control UI origin + /providers). */
  successRedirectBase?: string;
  createdAt: number;
};

const stateMap = new Map<string, OAuthStateEntry>();

function pruneExpired() {
  const now = Date.now();
  for (const [state, entry] of stateMap.entries()) {
    if (now - entry.createdAt > OAUTH_STATE_TTL_MS) {
      stateMap.delete(state);
    }
  }
}

export function createOAuthState(entry: Omit<OAuthStateEntry, "createdAt">): string {
  pruneExpired();
  const state = randomBytes(32).toString("hex");
  stateMap.set(state, {
    ...entry,
    createdAt: Date.now(),
  });
  return state;
}

export function consumeOAuthState(state: string): OAuthStateEntry | null {
  const entry = stateMap.get(state);
  stateMap.delete(state);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > OAUTH_STATE_TTL_MS) {
    return null;
  }
  return entry;
}
