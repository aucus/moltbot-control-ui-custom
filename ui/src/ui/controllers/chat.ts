import { extractText } from "../chat/message-extract";
import type { GatewayBrowserClient } from "../gateway";
import { generateUUID } from "../uuid";
import type { ChatAttachment } from "../ui-types";
import type { ActivityLogEntry } from "../app-tool-stream";

export type ChatState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey: string;
  chatLoading: boolean;
  chatMessages: unknown[];
  chatThinkingLevel: string | null;
  chatSending: boolean;
  chatMessage: string;
  chatAttachments: ChatAttachment[];
  chatRunId: string | null;
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  lastError: string | null;
  // Activity panel log (terminal-like)
  activityLog?: ActivityLogEntry[];
  llmLogLastAtMs?: number;
  llmFirstTokenSeen?: boolean;
};

export type ChatEventPayload = {
  runId: string;
  sessionKey: string;
  state: "delta" | "final" | "aborted" | "error";
  message?: unknown;
  errorMessage?: string;
};

export async function loadChatHistory(state: ChatState) {
  if (!state.client || !state.connected) return;
  state.chatLoading = true;
  state.lastError = null;
  try {
    const res = (await state.client.request("chat.history", {
      sessionKey: state.sessionKey,
      limit: 200,
    })) as { messages?: unknown[]; thinkingLevel?: string | null };
    state.chatMessages = Array.isArray(res.messages) ? res.messages : [];
    state.chatThinkingLevel = res.thinkingLevel ?? null;
  } catch (err) {
    state.lastError = String(err);
  } finally {
    state.chatLoading = false;
  }
}

function dataUrlToBase64(dataUrl: string): { content: string; mimeType: string } | null {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return null;
  return { mimeType: match[1], content: match[2] };
}

export async function sendChatMessage(
  state: ChatState,
  message: string,
  attachments?: ChatAttachment[],
): Promise<boolean> {
  if (!state.client || !state.connected) return false;
  const msg = message.trim();
  const hasAttachments = attachments && attachments.length > 0;
  if (!msg && !hasAttachments) return false;

  const now = Date.now();

  // Build user message content blocks
  const contentBlocks: Array<{ type: string; text?: string; source?: unknown }> = [];
  if (msg) {
    contentBlocks.push({ type: "text", text: msg });
  }
  // Add image previews to the message for display
  if (hasAttachments) {
    for (const att of attachments) {
      contentBlocks.push({
        type: "image",
        source: { type: "base64", media_type: att.mimeType, data: att.dataUrl },
      });
    }
  }

  state.chatMessages = [
    ...state.chatMessages,
    {
      role: "user",
      content: contentBlocks,
      timestamp: now,
    },
  ];

  state.chatSending = true;
  state.lastError = null;
  const runId = generateUUID();
  state.chatRunId = runId;
  state.chatStream = "";
  state.chatStreamStartedAt = now;
  state.llmLogLastAtMs = 0;
  state.llmFirstTokenSeen = false;

  // Activity log: new run header
  try {
    const log = Array.isArray(state.activityLog) ? state.activityLog : [];
    state.activityLog = [
      ...log,
      { ts: now, tag: "chat", subsystem: "chat", event: "run.start", level: "info", text: `run started (session=${state.sessionKey}, runId=${runId})`, runId, sessionKey: state.sessionKey },
      { ts: now, tag: "llm", subsystem: "llm", event: "phase", level: "info", text: "thinking (waiting for first token)", runId, sessionKey: state.sessionKey },
    ].slice(-800);
  } catch {
    // ignore
  }

  // Convert attachments to API format
  const apiAttachments = hasAttachments
    ? attachments
        .map((att) => {
          const parsed = dataUrlToBase64(att.dataUrl);
          if (!parsed) return null;
          return {
            type: "image",
            mimeType: parsed.mimeType,
            content: parsed.content,
          };
        })
        .filter((a): a is NonNullable<typeof a> => a !== null)
    : undefined;

  try {
    await state.client.request("chat.send", {
      sessionKey: state.sessionKey,
      message: msg,
      deliver: false,
      idempotencyKey: runId,
      attachments: apiAttachments,
    });
    return true;
  } catch (err) {
    const error = String(err);
    state.chatRunId = null;
    state.chatStream = null;
    state.chatStreamStartedAt = null;
    state.lastError = error;
    state.chatMessages = [
      ...state.chatMessages,
      {
        role: "assistant",
        content: [{ type: "text", text: "Error: " + error }],
        timestamp: Date.now(),
      },
    ];
    return false;
  } finally {
    state.chatSending = false;
  }
}

export async function abortChatRun(state: ChatState): Promise<boolean> {
  if (!state.client || !state.connected) return false;
  const runId = state.chatRunId;
  try {
    await state.client.request(
      "chat.abort",
      runId
        ? { sessionKey: state.sessionKey, runId }
        : { sessionKey: state.sessionKey },
    );
    return true;
  } catch (err) {
    state.lastError = String(err);
    return false;
  }
}

export function handleChatEvent(
  state: ChatState,
  payload?: ChatEventPayload,
) {
  if (!payload) return null;
  if (payload.sessionKey !== state.sessionKey) return null;

  // Final from another run (e.g. sub-agent announce): refresh history to show new message.
  // See https://github.com/clawdbot/clawdbot/issues/1909
  if (
    payload.runId &&
    state.chatRunId &&
    payload.runId !== state.chatRunId
  ) {
    if (payload.state === "final") return "final";
    return null;
  }

  if (payload.state === "delta") {
    const next = extractText(payload.message);
    if (typeof next === "string") {
      const prev = state.chatStream ?? "";
      if (!prev || next.length >= prev.length) {
        state.chatStream = next;
      }

      // Activity log: first token + periodic progress
      try {
        const now = Date.now();
        const runId = state.chatRunId ?? payload.runId;
        const sessionKey = state.sessionKey;
        const log = Array.isArray(state.activityLog) ? state.activityLog : [];

        if (!state.llmFirstTokenSeen && next.length > 0) {
          state.llmFirstTokenSeen = true;
          state.activityLog = [
            ...log,
            { ts: now, tag: "llm", subsystem: "llm", event: "phase", level: "info", text: "answering (first token received)", runId, sessionKey },
          ].slice(-800);
        }

        const lastAt = typeof state.llmLogLastAtMs === "number" ? state.llmLogLastAtMs : 0;
        if (now - lastAt >= 900) {
          state.llmLogLastAtMs = now;
          const chars = next.length;
          const words = Math.max(0, next.trim().split(/\s+/).filter(Boolean).length);
          state.activityLog = [
            ...(Array.isArray(state.activityLog) ? state.activityLog : log),
            { ts: now, tag: "llm", subsystem: "llm", event: "stream", level: "info", text: `streaming (${chars} chars, ${words} words)`, runId, sessionKey },
          ].slice(-800);
        }
      } catch {
        // ignore
      }
    }
  } else if (payload.state === "final") {
    try {
      const now = Date.now();
      const runId = payload.runId;
      const sessionKey = state.sessionKey;
      const log = Array.isArray(state.activityLog) ? state.activityLog : [];
      state.activityLog = [
        ...log,
        { ts: now, tag: "llm", subsystem: "llm", event: "phase", level: "info", text: "done (final)", runId, sessionKey },
      ].slice(-800);
    } catch {
      // ignore
    }

    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
  } else if (payload.state === "aborted") {
    try {
      const now = Date.now();
      const runId = payload.runId;
      const sessionKey = state.sessionKey;
      const log = Array.isArray(state.activityLog) ? state.activityLog : [];
      state.activityLog = [
        ...log,
        { ts: now, tag: "llm", subsystem: "llm", event: "phase", level: "warn", text: "aborted", runId, sessionKey },
      ].slice(-800);
    } catch {
      // ignore
    }

    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
  } else if (payload.state === "error") {
    try {
      const now = Date.now();
      const runId = payload.runId;
      const sessionKey = state.sessionKey;
      const log = Array.isArray(state.activityLog) ? state.activityLog : [];
      const msg = payload.errorMessage ?? "chat error";
      state.activityLog = [
        ...log,
        { ts: now, tag: "llm", subsystem: "llm", event: "phase", level: "error", text: `error (${msg})`, runId, sessionKey },
      ].slice(-800);
    } catch {
      // ignore
    }

    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
    state.lastError = payload.errorMessage ?? "chat error";
  }
  return payload.state;
}
