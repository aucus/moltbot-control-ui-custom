import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { createRef, ref } from "lit/directives/ref.js";
import type { SessionsListResult } from "../types";
import type { ChatAttachment, ChatQueueItem } from "../ui-types";
import type { ChatItem, MessageGroup } from "../types/chat-types";
import { icons } from "../icons";
import {
  normalizeMessage,
  normalizeRoleForGrouping,
} from "../chat/message-normalizer";
import {
  renderMessageGroup,
  renderReadingIndicatorGroup,
  renderStreamingGroup,
} from "../chat/grouped-render";
import { toSanitizedMarkdownHtml } from "../markdown";
import { extractToolCards } from "../chat/tool-cards";
import { extractTextCached, extractThinkingCached, formatReasoningMarkdown } from "../chat/message-extract";
import { resolveToolDisplay, formatToolDetail } from "../tool-display";
import { renderMarkdownSidebar } from "./markdown-sidebar";
import "../components/resizable-divider";

export type CompactionIndicatorStatus = {
  active: boolean;
  startedAt: number | null;
  completedAt: number | null;
};

export type ChatProps = {
  sessionKey: string;
  onSessionKeyChange: (next: string) => void;
  thinkingLevel: string | null;
  showThinking: boolean;
  loading: boolean;
  sending: boolean;
  canAbort?: boolean;
  compactionStatus?: CompactionIndicatorStatus | null;
  messages: unknown[];
  toolMessages: unknown[];
  activityLog?: Array<{ ts: number; tag: string; text: string }>;
  stream: string | null;
  streamStartedAt: number | null;
  assistantAvatarUrl?: string | null;
  draft: string;
  queue: ChatQueueItem[];
  connected: boolean;
  canSend: boolean;
  disabledReason: string | null;
  error: string | null;
  sessions: SessionsListResult | null;
  // Focus mode
  focusMode: boolean;
  // Sidebar state
  sidebarOpen?: boolean;
  sidebarContent?: string | null;
  sidebarError?: string | null;
  splitRatio?: number;
  assistantName: string;
  assistantAvatar: string | null;
  // Image attachments
  attachments?: ChatAttachment[];
  onAttachmentsChange?: (attachments: ChatAttachment[]) => void;
  // Activity panel (right)
  activityPanelOpen?: boolean;
  activityScrollLocked?: boolean;
  onToggleActivityPanel?: () => void;
  onActivityLockChange?: (locked: boolean) => void;
  // Event handlers
  onRefresh: () => void;
  onToggleFocusMode: () => void;
  onDraftChange: (next: string) => void;
  onSend: () => void;
  onAbort?: () => void;
  onQueueRemove: (id: string) => void;
  onNewSession: () => void;
  onOpenSidebar?: (content: string) => void;
  onCloseSidebar?: () => void;
  onSplitRatioChange?: (ratio: number) => void;
  onChatScroll?: (event: Event) => void;
};

const COMPACTION_TOAST_DURATION_MS = 5000;

function renderCompactionIndicator(status: CompactionIndicatorStatus | null | undefined) {
  if (!status) return nothing;

  // Show "compacting..." while active
  if (status.active) {
    return html`
      <div class="callout info compaction-indicator compaction-indicator--active">
        ${icons.loader} Compacting context...
      </div>
    `;
  }

  // Show "compaction complete" briefly after completion
  if (status.completedAt) {
    const elapsed = Date.now() - status.completedAt;
    if (elapsed < COMPACTION_TOAST_DURATION_MS) {
      return html`
        <div class="callout success compaction-indicator compaction-indicator--complete">
          ${icons.check} Context compacted
        </div>
      `;
    }
  }

  return nothing;
}

function formatClockTime(ts: number) {
  try {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  } catch {
    return "--:--:--";
  }
}

function formatDurationMs(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  if (mm <= 0) return `${ss}s`;
  return `${mm}m ${String(ss).padStart(2, "0")}s`;
}

function formatElapsedSince(ts: number, base: number | null | undefined) {
  if (!base || !Number.isFinite(base)) return "";
  const ms = ts - base;
  if (!Number.isFinite(ms)) return "";
  const sign = ms >= 0 ? "+" : "-";
  const abs = Math.abs(ms);
  const s = Math.floor(abs / 1000);
  const msRem = abs % 1000;
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  if (mm <= 0) return `${sign}${ss}.${String(Math.floor(msRem / 100)).padStart(1, "0")}s`;
  return `${sign}${mm}:${String(ss).padStart(2, "0")}`;
}

const activityBodyRef = createRef<HTMLElement>();

function renderActivityPanel(props: ChatProps) {
  const open = props.activityPanelOpen !== false;
  const locked = Boolean(props.activityScrollLocked);

  // Source of truth: activity log entries appended from gateway `agent` events.
  const log = Array.isArray(props.activityLog) ? props.activityLog.slice(-500) : [];

  const now = Date.now();
  const running = Boolean(props.canAbort || props.sending || props.stream);
  const startedAt = props.streamStartedAt;
  const elapsed = running && startedAt ? formatDurationMs(now - startedAt) : null;

  const phaseHead = (() => {
    if (!running) return "idle";
    const streamText = String(props.stream ?? "");
    return streamText && streamText.length > 0 ? "ANSWER" : "THINK";
  })();

  const statusText = props.connected
    ? running
      ? elapsed
        ? `${phaseHead} · running · ${elapsed}`
        : `${phaseHead} · running`
      : "idle"
    : "disconnected";

  const tagClass = running
    ? "chat-activity__tag chat-activity__tag--running"
    : "chat-activity__tag chat-activity__tag--idle";

  const lines = (() => {
    const out: Array<{ ts: number; tag: string; text: string }> = [];

    // Phase headline belongs in the header; the body should be a real, accumulated log.

    // Activity stream (already line-based; no collapsing)
    for (const entry of log) {
      const ts = typeof (entry as any).ts === "number" ? (entry as any).ts : now;
      const tag = String((entry as any).tag ?? "tool");
      const text = String((entry as any).text ?? "");

      // Nicer tool display when we can map it
      if (tag === "tool") {
        // entry.text begins with tool name, like "web_search · start …"
        const toolName = text.split("·")[0]?.trim();
        if (toolName) {
          const display = resolveToolDisplay({ name: toolName, args: undefined });
          const mapped = text.replace(toolName, display.label);
          out.push({ ts, tag, text: mapped });
          continue;
        }
      }

      out.push({ ts, tag, text });
    }

    // Fallback when nothing else exists
    if (out.length === 0) {
      out.push({ ts: now, tag: "chat", text: running ? "Working…" : "No active work" });
    }

    return out.slice(-200);
  })();

  const maybeAutoScroll = () => {
    if (!open || locked) return;
    const el = activityBodyRef.value;
    if (!el) return;
    // Schedule after paint (avoid measuring during render)
    requestAnimationFrame(() => {
      try {
        el.scrollTop = el.scrollHeight;
      } catch {
        // ignore
      }
    });
  };
  maybeAutoScroll();

  const onScroll = (e: Event) => {
    const el = e.currentTarget as HTMLElement | null;
    if (!el) return;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 6;
    props.onActivityLockChange?.(!atBottom);
  };

  return html`
    <aside
      class="chat-activity"
      aria-label="Activity"
      data-open=${open ? "1" : "0"}
    >
      <div class="chat-activity__header">
        <div class="chat-activity__title">Activity</div>
        <div class="chat-activity__status">
          ${statusText}
          <button
            class="btn btn--xs"
            type="button"
            style="margin-left: 8px"
            @click=${() => props.onToggleActivityPanel?.()}
            aria-label=${open ? "Collapse activity" : "Expand activity"}
            title=${open ? "Collapse" : "Expand"}
          >
            ${open ? "Hide" : "Show"}
          </button>
          ${locked && open
            ? html`
                <button
                  class="btn btn--xs"
                  type="button"
                  style="margin-left: 6px"
                  @click=${() => {
                    props.onActivityLockChange?.(false);
                    requestAnimationFrame(() => {
                      const el = activityBodyRef.value;
                      if (el) el.scrollTop = el.scrollHeight;
                    });
                  }}
                  aria-label="Follow logs"
                  title="Follow logs"
                >
                  Follow
                </button>
              `
            : nothing}
        </div>
      </div>

      ${open
        ? html`
            <div
              class="chat-activity__body"
              ${ref(activityBodyRef)}
              @scroll=${onScroll}
              role="log"
              aria-live="polite"
            >
              ${lines.map(
                (l) => html`
                  <div class="chat-activity__line">
                    <span class="chat-activity__ts">${formatClockTime(l.ts)}</span>
                    <span class="chat-activity__elapsed">${formatElapsedSince(l.ts, props.streamStartedAt)}</span>
                    <span class=${tagClass}>${l.tag}</span>
                    <span>${l.text}</span>
                  </div>
                `,
              )}
            </div>
          `
        : html`
            <div class="muted" style="font-size: 12px">(hidden)</div>
          `}
    </aside>
  `;
}

function generateAttachmentId(): string {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function handlePaste(
  e: ClipboardEvent,
  props: ChatProps,
) {
  const items = e.clipboardData?.items;
  if (!items || !props.onAttachmentsChange) return;

  const imageItems: DataTransferItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type.startsWith("image/")) {
      imageItems.push(item);
    }
  }

  if (imageItems.length === 0) return;

  e.preventDefault();

  for (const item of imageItems) {
    const file = item.getAsFile();
    if (!file) continue;

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const newAttachment: ChatAttachment = {
        id: generateAttachmentId(),
        dataUrl,
        mimeType: file.type,
      };
      const current = props.attachments ?? [];
      props.onAttachmentsChange?.([...current, newAttachment]);
    };
    reader.readAsDataURL(file);
  }
}

function handleDrop(e: DragEvent, props: ChatProps) {
  const dt = e.dataTransfer;
  if (!dt || !props.onAttachmentsChange) return;

  const files = Array.from(dt.files ?? []).filter((f) => f.type.startsWith("image/"));
  if (files.length === 0) return;

  e.preventDefault();

  for (const file of files) {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const newAttachment: ChatAttachment = {
        id: generateAttachmentId(),
        dataUrl,
        mimeType: file.type,
      };
      const current = props.attachments ?? [];
      props.onAttachmentsChange?.([...current, newAttachment]);
    };
    reader.readAsDataURL(file);
  }
}

function renderAttachmentPreview(props: ChatProps) {
  const attachments = props.attachments ?? [];
  if (attachments.length === 0) return nothing;

  return html`
    <div class="chat-attachments">
      ${attachments.map(
        (att) => html`
          <div class="chat-attachment">
            <img
              src=${att.dataUrl}
              alt="Attachment preview"
              class="chat-attachment__img"
            />
            <button
              class="chat-attachment__remove"
              type="button"
              aria-label="Remove attachment"
              @click=${() => {
                const next = (props.attachments ?? []).filter(
                  (a) => a.id !== att.id,
                );
                props.onAttachmentsChange?.(next);
              }}
            >
              ${icons.x}
            </button>
          </div>
        `,
      )}
    </div>
  `;
}

type Snippet = { id: string; text: string };

const SNIPPETS_KEY = "clawdbot.webchat.snippets.v1";
const SNIPPETS_STATS_KEY = "clawdbot.webchat.snippets.stats.v1";
const SNIPPETS_PENDING_KEY = "clawdbot.webchat.snippets.pending.v1";
const SNIPPETS_SNOOZE_KEY = "clawdbot.webchat.snippets.snooze.v1";

// Simple UI state (module-level): selected snippet index in the popup.
let snippetSelectedIndex = 0;
let snippetLastQuery = "";

const DEFAULT_SNIPPETS: Snippet[] = [
  { id: "progress-please", text: "진행 부탁해" },
  { id: "progress-do", text: "진행 해줘" },
  { id: "check-please", text: "확인 부탁해" },
  { id: "summarize", text: "요약해줘" },
  { id: "organize", text: "정리해줘" },
];

function safeJsonParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function loadSnippets(): Snippet[] {
  try {
    const v = safeJsonParse<Snippet[]>(localStorage.getItem(SNIPPETS_KEY));
    if (Array.isArray(v) && v.every((x) => x && typeof (x as any).text === "string")) {
      return v.map((x, idx) => ({ id: String((x as any).id ?? idx), text: String((x as any).text) }));
    }
  } catch {
    // ignore
  }
  return DEFAULT_SNIPPETS;
}

function saveSnippets(next: Snippet[]) {
  try {
    localStorage.setItem(SNIPPETS_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

function loadSnoozes(): Record<string, number> {
  try {
    return safeJsonParse<Record<string, number>>(localStorage.getItem(SNIPPETS_SNOOZE_KEY)) ?? {};
  } catch {
    return {};
  }
}

function saveSnoozes(next: Record<string, number>) {
  try {
    localStorage.setItem(SNIPPETS_SNOOZE_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

function isSnoozed(text: string) {
  const snoozes = loadSnoozes();
  const until = Number(snoozes[text] ?? 0);
  const now = Date.now();
  if (!until) return false;
  if (until <= now) {
    // Expired: cleanup
    delete snoozes[text];
    saveSnoozes(snoozes);
    return false;
  }
  return true;
}

function recordSnippetCandidate(text: string) {
  const t = String(text ?? "").trim();
  if (!t) return;
  if (t.length > 40) return;
  if (t.includes("\n")) return;

  // Don't re-suggest if already a snippet.
  const existing = loadSnippets();
  if (existing.some((s) => s.text === t)) return;

  // Respect snooze.
  if (isSnoozed(t)) return;

  try {
    const stats = safeJsonParse<Record<string, number>>(localStorage.getItem(SNIPPETS_STATS_KEY)) ?? {};
    stats[t] = (stats[t] ?? 0) + 1;
    localStorage.setItem(SNIPPETS_STATS_KEY, JSON.stringify(stats));

    const threshold = 3;
    if ((stats[t] ?? 0) >= threshold) {
      const pending = { text: t, count: stats[t] };
      localStorage.setItem(SNIPPETS_PENDING_KEY, JSON.stringify(pending));
    }
  } catch {
    // ignore
  }
}

function loadPendingSnippet(): { text: string; count: number } | null {
  try {
    const p = safeJsonParse<{ text: string; count: number }>(
      localStorage.getItem(SNIPPETS_PENDING_KEY),
    );
    if (!p || typeof p.text !== "string") return null;
    const text = p.text.trim();
    if (!text) return null;
    if (isSnoozed(text)) {
      // If user snoozed this phrase, drop the pending suggestion.
      clearPendingSnippet();
      return null;
    }
    return { text, count: Number(p.count ?? 0) };
  } catch {
    return null;
  }
}

function clearPendingSnippet() {
  try {
    localStorage.removeItem(SNIPPETS_PENDING_KEY);
  } catch {
    // ignore
  }
}

function computeSnippetMatches(draft: string) {
  const m = /\/(\S{0,32})$/.exec(draft);
  if (!m) return { open: false as const, query: "", matches: [] as Snippet[], replaceFrom: 0 };
  const query = String(m[1] ?? "");
  const replaceFrom = (draft.length - m[0].length);
  const snippets = loadSnippets();
  const q = query.trim();
  const matches = q
    ? snippets.filter((s) => s.text.includes(q))
    : snippets;
  return { open: true as const, query, matches: matches.slice(0, 8), replaceFrom };
}

function applySnippet(draft: string, replaceFrom: number, snippetText: string) {
  const before = draft.slice(0, Math.max(0, replaceFrom));
  const next = `${before}${snippetText}`;
  return next;
}

function updateSnippetSelectionUI(textareaEl: HTMLTextAreaElement | null) {
  if (!textareaEl) return;
  const root = textareaEl.closest(".chat-compose") as HTMLElement | null;
  if (!root) {
    // eslint-disable-next-line no-console
    console.debug("[snippets] ui: no root");
    return;
  }
  const items = Array.from(root.querySelectorAll<HTMLElement>(".chat-snippets__item"));
  // eslint-disable-next-line no-console
  console.debug("[snippets] ui:update", { items: items.length, selected: snippetSelectedIndex });
  for (let i = 0; i < items.length; i++) {
    items[i].classList.toggle("is-selected", i === snippetSelectedIndex);
  }
}

export function renderChat(props: ChatProps) {
  const canCompose = props.connected;
  const isBusy = props.sending || props.stream !== null;
  const canAbort = Boolean(props.canAbort && props.onAbort);
  const activeSession = props.sessions?.sessions?.find(
    (row) => row.key === props.sessionKey,
  );
  const reasoningLevel = activeSession?.reasoningLevel ?? "off";
  const showReasoning = props.showThinking && reasoningLevel !== "off";
  // Prefer avatar URL (including data:image/*) over a text avatar/emoji.
  const assistantIdentity = {
    name: props.assistantName,
    avatar: props.assistantAvatarUrl ?? props.assistantAvatar ?? null,
  };

  // Optional separate avatar while "thinking" (reading indicator / streaming).
  let assistantThinkingAvatar: string | null = null;
  try {
    const v = localStorage.getItem("clawdbot.control.avatar.override.thinking.v1");
    assistantThinkingAvatar = typeof v === "string" && v.trim() ? v.trim() : null;
  } catch {
    assistantThinkingAvatar = null;
  }

  const assistantThinkingIdentity = {
    name: props.assistantName,
    avatar: assistantThinkingAvatar ?? assistantIdentity.avatar,
  };

  const hasAttachments = (props.attachments?.length ?? 0) > 0;
  const composePlaceholder = props.connected
    ? hasAttachments
      ? "Add a message or paste more images..."
      : "Message (↩ to send, Shift+↩ for line breaks, paste images)"
    : "Connect to the gateway to start chatting…";

  const pendingSnippet = loadPendingSnippet();
  const snippetUI = computeSnippetMatches(props.draft);

  // Reset selection when the query changes.
  if (snippetUI.open && snippetUI.query !== snippetLastQuery) {
    snippetLastQuery = snippetUI.query;
    snippetSelectedIndex = 0;
  }
  // Clamp selection
  if (snippetUI.open && snippetUI.matches.length > 0) {
    snippetSelectedIndex = Math.max(0, Math.min(snippetSelectedIndex, snippetUI.matches.length - 1));
  } else {
    snippetSelectedIndex = 0;
  }

  const sendWithTracking = () => {
    try {
      recordSnippetCandidate(props.draft);
    } catch {
      // ignore
    }
    props.onSend();
  };

  const splitRatio = props.splitRatio ?? 0.6;
  const sidebarOpen = Boolean(props.sidebarOpen && props.onCloseSidebar);
  const chatItems = buildChatItems(props);

  const userGroups = chatItems.filter(
    (item): item is MessageGroup =>
      Boolean(item) && (item as any).kind === "group" && String((item as any).role) === "user",
  );

  // Session-wide internals (one ⋯ for everything): aggregate tool + reasoning traces.
  const sessionInternals = (() => {
    const parts: string[] = [];

    const pushSection = (title: string, body: string) => {
      const b = body.trim();
      if (!b) return;
      parts.push(`## ${title}\n\n${b}`);
    };

    const scanMessage = (msg: unknown) => {
      const m = msg as Record<string, unknown>;
      const role = String(m.role ?? "").toLowerCase();

      // Reasoning (only present if the gateway delivered it)
      const thinking = extractThinkingCached(msg);
      if (thinking?.trim()) {
        pushSection("Reasoning", formatReasoningMarkdown(thinking));
      }

      // Tool cards embedded in message content
      const cards = extractToolCards(msg);
      for (const card of cards) {
        const head = `Tool (${card.kind}): ${card.name}`;
        if (card.text?.trim()) {
          pushSection(head, `\`\`\`\n${card.text}\n\`\`\``);
        } else if (card.args != null) {
          pushSection(head, `\`\`\`json\n${JSON.stringify(card.args, null, 2)}\n\`\`\``);
        } else {
          pushSection(head, "(no output)");
        }
      }

      // Legacy tool messages
      if (role === "tool" || role === "toolresult" || role === "tool_result") {
        const text = extractTextCached(msg);
        if (text?.trim()) pushSection("Tool message", `\`\`\`\n${text}\n\`\`\``);
      }
    };

    // Scan recent history (already capped in buildChatItems) + toolMessages (when available)
    const history = Array.isArray(props.messages) ? props.messages.slice(-200) : [];
    const tools = Array.isArray(props.toolMessages) ? props.toolMessages.slice(-200) : [];
    for (const msg of history) scanMessage(msg);
    for (const msg of tools) scanMessage(msg);

    const merged = parts.join("\n\n---\n\n").trim();
    if (!merged) return nothing;

    // Cap payload to keep UI snappy.
    const MAX = 60000;
    const clipped = merged.length > MAX ? `${merged.slice(0, MAX)}\n\n…(truncated)…` : merged;

    return html`
      <details class="chat-session-internals">
        <summary class="chat-session-internals__summary" aria-label="Show session internals" title="Show session internals">⋯</summary>
        <div class="chat-session-internals__content">
          ${unsafeHTML(toSanitizedMarkdownHtml(clipped))}
        </div>
      </details>
    `;
  })();

  const activityOpen = props.activityPanelOpen !== false;

  const thread = html`
    <div class="chat-thread-wrap ${activityOpen ? "" : "chat-thread-wrap--activity-collapsed"}">
      <aside class="chat-questions" aria-label="Questions">
        <div class="chat-questions__title">Questions</div>
        <div class="chat-questions__list">
          ${userGroups.length
            ? (() => {
                // Show newest questions first so the panel opens at the most recent context.
                const recent = userGroups.slice(-200);
                const reversed = [...recent].reverse();
                return reversed.map((group, idx) => {
                  const first = group.messages[0]?.message;
                  const text = first ? normalizeMessage(first).content?.[0]?.text : "";
                  const previewRaw =
                    typeof text === "string" && text.trim() ? text.trim() : "(no text)";
                  const preview = previewRaw.length > 80 ? `${previewRaw.slice(0, 80)}…` : previewRaw;
                  const displayNum = recent.length - idx;
                  return html`
                    <button
                      class="chat-questions__item"
                      type="button"
                      title=${previewRaw}
                      @click=${(e: Event) => {
                        // IMPORTANT: Control UI renders inside a shadow root.
                        // Use the current root node for queries (document.querySelector won't see inside shadow DOM).
                        const root = (e.currentTarget as HTMLElement).getRootNode() as
                          | Document
                          | ShadowRoot;

                        const esc = (value: string) => {
                          try {
                            return (CSS as any).escape(value);
                          } catch {
                            return value.replace(/"/g, "");
                          }
                        };

                        const targetId = `chat-${group.key}`;
                        const thread = root.querySelector(
                          ".chat-thread",
                        ) as HTMLElement | null;
                        const el = root.querySelector(
                          `#${esc(targetId)}`,
                        ) as HTMLElement | null;

                        if (el && thread) {
                          // Scroll within the chat thread container (not the page).
                          const top =
                            el.getBoundingClientRect().top -
                            thread.getBoundingClientRect().top +
                            thread.scrollTop;
                          const nextTop = Math.max(0, top - 12);

                          // Prevent the global auto-sticky behavior from snapping back to bottom.
                          thread.dataset.preventStick = "1";

                          // Use immediate scrollTop assignment (more reliable than smooth scrolling across browsers).
                          thread.scrollTop = nextTop;
                          thread.focus();
                          return;
                        }

                        // Fallback: try a direct scrollIntoView (may hit page scroll).
                        el?.scrollIntoView({ block: "start", behavior: "smooth" });
                      }}
                    >
                      <span class="chat-questions__num">${displayNum}</span>
                      <span class="chat-questions__text">${preview}</span>
                    </button>
                  `;
                });
              })()
            : html`<div class="muted">No questions yet.</div>`}
        </div>
      </aside>

      <div class="chat-thread-right">
        ${sessionInternals}
        <div
          class="chat-thread"
          role="log"
          aria-live="polite"
          tabindex="0"
          @scroll=${props.onChatScroll}
        >
        ${props.loading ? html`<div class="muted">Loading chat…</div>` : nothing}
        ${repeat(chatItems, (item) => item.key, (item) => {
          if (item.kind === "reading-indicator") {
            return renderReadingIndicatorGroup(assistantThinkingIdentity);
          }

          if (item.kind === "stream") {
            return renderStreamingGroup(
              item.text,
              item.startedAt,
              props.onOpenSidebar,
              assistantThinkingIdentity,
            );
          }

          if (item.kind === "group") {
            // Hide tool-only groups entirely (internals are available via the single session-wide ⋯)
            if (String(item.role).toLowerCase() === "tool") return nothing;
            return renderMessageGroup(item, {
              onOpenSidebar: props.onOpenSidebar,
              showReasoning: false,
              assistantName: props.assistantName,
              assistantAvatar: assistantIdentity.avatar,
            });
          }

          return nothing;
        })}

        ${props.sending && props.stream === null
          ? renderReadingIndicatorGroup(assistantThinkingIdentity)
          : nothing}
        </div>
      </div>

      ${renderActivityPanel(props)}
    </div>
  `;

  return html`
    <section class="card chat">
      ${props.disabledReason
        ? html`<div class="callout">${props.disabledReason}</div>`
        : nothing}

      ${props.error
        ? html`<div class="callout danger">${props.error}</div>`
        : nothing}

      ${renderCompactionIndicator(props.compactionStatus)}

      ${props.focusMode
        ? html`
            <button
              class="chat-focus-exit"
              type="button"
              @click=${props.onToggleFocusMode}
              aria-label="Exit focus mode"
              title="Exit focus mode"
            >
              ${icons.x}
            </button>
          `
        : nothing}

      <div
        class="chat-split-container ${sidebarOpen ? "chat-split-container--open" : ""}"
      >
        <div
          class="chat-main"
          style="flex: ${sidebarOpen ? `0 0 ${splitRatio * 100}%` : "1 1 100%"}"
        >
          ${thread}
        </div>

        ${sidebarOpen
          ? html`
              <resizable-divider
                .splitRatio=${splitRatio}
                @resize=${(e: CustomEvent) =>
                  props.onSplitRatioChange?.(e.detail.splitRatio)}
              ></resizable-divider>
              <div class="chat-sidebar">
                ${renderMarkdownSidebar({
                  content: props.sidebarContent ?? null,
                  error: props.sidebarError ?? null,
                  onClose: props.onCloseSidebar!,
                  onViewRawText: () => {
                    if (!props.sidebarContent || !props.onOpenSidebar) return;
                    props.onOpenSidebar(`\`\`\`\n${props.sidebarContent}\n\`\`\``);
                  },
                })}
              </div>
            `
          : nothing}
      </div>

      ${props.queue.length
        ? html`
            <div class="chat-queue" role="status" aria-live="polite">
              <div class="chat-queue__title">Queued (${props.queue.length})</div>
              <div class="chat-queue__list">
                ${props.queue.map(
                  (item) => html`
                    <div class="chat-queue__item">
                      <div class="chat-queue__text">
                        ${item.text ||
                        (item.attachments?.length
                          ? `Image (${item.attachments.length})`
                          : "")}
                      </div>
                      <button
                        class="btn chat-queue__remove"
                        type="button"
                        aria-label="Remove queued message"
                        @click=${() => props.onQueueRemove(item.id)}
                      >
                        ${icons.x}
                      </button>
                    </div>
                  `,
                )}
              </div>
            </div>
          `
        : nothing}

      <div class="chat-compose">
        ${pendingSnippet
          ? html`
              <div class="chat-snippet-suggest">
                <div class="chat-snippet-suggest__text">
                  자주 쓰는 표현을 스니펫으로 추가할까요?
                  <span class="chat-snippet-suggest__chip">${pendingSnippet.text}</span>
                  <span class="chat-snippet-suggest__meta">(${pendingSnippet.count}회)</span>
                </div>
                <div class="chat-snippet-suggest__actions">
                  <button
                    class="btn"
                    type="button"
                    @click=${() => {
                      const next = [...loadSnippets(), { id: `user-${Date.now()}`, text: pendingSnippet.text }];
                      saveSnippets(next);
                      clearPendingSnippet();
                      // Force a re-render by re-setting draft.
                      props.onDraftChange(`${props.draft}`);
                    }}
                  >
                    추가
                  </button>
                  <button
                    class="btn"
                    type="button"
                    @click=${() => {
                      // Snooze this suggestion for 7 days.
                      const snoozes = loadSnoozes();
                      snoozes[pendingSnippet.text] = Date.now() + 7 * 24 * 60 * 60 * 1000;
                      saveSnoozes(snoozes);
                      clearPendingSnippet();
                      props.onDraftChange(`${props.draft}`);
                    }}
                  >
                    나중에
                  </button>
                </div>
              </div>
            `
          : nothing}

        ${renderAttachmentPreview(props)}
        <div class="chat-compose__row">
          <label class="field chat-compose__field">
            <span>Message</span>
            <textarea
              class="chat-compose__textarea"
              .value=${props.draft}
              ?disabled=${!props.connected}
              rows="2"
              @keydown=${(e: KeyboardEvent) => {
                if (e.isComposing || e.keyCode === 229) return;

                // Snippet autocomplete (trigger: /)
                if (snippetUI.open && snippetUI.matches.length > 0) {
                  const key = String((e as any).key ?? "");
                  const code = String((e as any).code ?? "");
                  const keyCode = Number((e as any).keyCode ?? 0);

                  // Debug (temporary): inspect what the browser emits.
                  // eslint-disable-next-line no-console
                  console.debug("[snippets] keydown", {
                    key,
                    code,
                    keyCode,
                    open: snippetUI.open,
                    matches: snippetUI.matches.length,
                    selected: snippetSelectedIndex,
                  });

                  const isDown =
                    key === "ArrowDown" ||
                    key === "Down" ||
                    code === "ArrowDown" ||
                    keyCode === 40;
                  const isUp =
                    key === "ArrowUp" || key === "Up" || code === "ArrowUp" || keyCode === 38;

                  if (isDown) {
                    e.preventDefault();
                    e.stopPropagation();
                    snippetSelectedIndex = Math.min(
                      snippetSelectedIndex + 1,
                      snippetUI.matches.length - 1,
                    );
                    updateSnippetSelectionUI(e.target as HTMLTextAreaElement);
                    // eslint-disable-next-line no-console
                    console.debug("[snippets] moved", { selected: snippetSelectedIndex });
                    return;
                  }
                  if (isUp) {
                    e.preventDefault();
                    e.stopPropagation();
                    snippetSelectedIndex = Math.max(snippetSelectedIndex - 1, 0);
                    updateSnippetSelectionUI(e.target as HTMLTextAreaElement);
                    // eslint-disable-next-line no-console
                    console.debug("[snippets] moved", { selected: snippetSelectedIndex });
                    return;
                  }

                  if (key === "Tab" || (key === "Enter" && !e.shiftKey)) {
                    e.preventDefault();
                    const chosen = snippetUI.matches[snippetSelectedIndex] ?? snippetUI.matches[0];
                    const next = applySnippet(props.draft, snippetUI.replaceFrom, chosen.text);
                    props.onDraftChange(next);
                    // Move caret to end
                    queueMicrotask(() => {
                      const el = e.target as HTMLTextAreaElement;
                      el.selectionStart = el.selectionEnd = next.length;
                    });
                    return;
                  }
                  if (key === "Escape") {
                    return;
                  }
                }

                if (e.key !== "Enter") return;
                if (e.shiftKey) return; // Allow Shift+Enter for line breaks
                if (!props.connected) return;
                e.preventDefault();
                if (canCompose) sendWithTracking();
              }}
              @input=${(e: Event) => {
                const el = e.target as HTMLTextAreaElement;
                props.onDraftChange(el.value);

                // Auto-grow up to ~8 lines, then internal scroll.
                const maxPx = 8 * 24; // approx line-height
                el.style.height = "auto";
                const next = Math.min(el.scrollHeight, maxPx);
                el.style.height = `${next}px`;
                el.style.overflowY = el.scrollHeight > maxPx ? "auto" : "hidden";
              }}
              @paste=${(e: ClipboardEvent) => handlePaste(e, props)}
              @dragover=${(e: DragEvent) => {
                // Allow dropping files by preventing the browser's default "open file" behavior.
                e.preventDefault();
              }}
              @drop=${(e: DragEvent) => handleDrop(e, props)}
              placeholder=${composePlaceholder}
            ></textarea>

            ${snippetUI.open && snippetUI.matches.length > 0
              ? html`
                  <div class="chat-snippets" role="listbox" aria-label="snippets">
                    ${snippetUI.matches.map(
                      (s, idx) => html`
                        <button
                          class=${`chat-snippets__item ${idx === snippetSelectedIndex ? "is-selected" : ""}`}
                          type="button"
                          @mouseenter=${(e: Event) => {
                            snippetSelectedIndex = idx;
                            updateSnippetSelectionUI(
                              (e.currentTarget as HTMLElement | null)?.closest(
                                ".chat-compose",
                              )?.querySelector(".chat-compose__textarea") as HTMLTextAreaElement | null,
                            );
                          }}
                          @click=${() => {
                            const next = applySnippet(props.draft, snippetUI.replaceFrom, s.text);
                            props.onDraftChange(next);
                          }}
                        >
                          ${s.text}
                        </button>
                      `,
                    )}
                    <div class="chat-snippets__hint">/ 입력 후 Tab/Enter로 자동완성</div>
                  </div>
                `
              : nothing}
          </label>
          <div class="chat-compose__actions">
            <button
              class="btn"
              ?disabled=${!props.connected || (!canAbort && props.sending)}
              @click=${canAbort ? props.onAbort : props.onNewSession}
            >
              ${canAbort ? "Stop" : "New session"}
            </button>

            <button
              class="btn"
              type="button"
              title="Set assistant avatar (answer) (local UI only)"
              @click=${async () => {
                const input = document.createElement("input");
                input.type = "file";
                input.accept = "image/*";
                input.onchange = () => {
                  const file = input.files?.[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = () => {
                    const url = String(reader.result ?? "");
                    if (!url.startsWith("data:image/")) {
                      window.alert("Avatar upload failed: unsupported image format.");
                      return;
                    }

                    try {
                      localStorage.setItem("clawdbot.control.avatar.override.v1", url);
                      const saved = localStorage.getItem(
                        "clawdbot.control.avatar.override.v1",
                      );
                      if (!saved || saved.length < 20) {
                        window.alert("Avatar upload failed: could not persist to local storage.");
                        return;
                      }
                      window.location.reload();
                    } catch (err) {
                      const msg =
                        err instanceof Error ? err.message : String(err ?? "unknown error");
                      window.alert(
                        `Avatar upload failed (likely storage quota). Try a smaller PNG/JPG.\n\n${msg}`,
                      );
                    }
                  };
                  reader.readAsDataURL(file);
                };
                input.click();
              }}
            >
              Avatar
            </button>

            <button
              class="btn"
              type="button"
              title="Set assistant avatar (thinking) (local UI only)"
              @click=${async () => {
                const input = document.createElement("input");
                input.type = "file";
                input.accept = "image/*";
                input.onchange = () => {
                  const file = input.files?.[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = () => {
                    const url = String(reader.result ?? "");
                    if (!url.startsWith("data:image/")) {
                      window.alert("Avatar upload failed: unsupported image format.");
                      return;
                    }

                    try {
                      localStorage.setItem(
                        "clawdbot.control.avatar.override.thinking.v1",
                        url,
                      );
                      const saved = localStorage.getItem(
                        "clawdbot.control.avatar.override.thinking.v1",
                      );
                      if (!saved || saved.length < 20) {
                        window.alert("Avatar upload failed: could not persist to local storage.");
                        return;
                      }
                      window.location.reload();
                    } catch (err) {
                      const msg =
                        err instanceof Error ? err.message : String(err ?? "unknown error");
                      window.alert(
                        `Avatar upload failed (likely storage quota). Try a smaller PNG/JPG.\n\n${msg}`,
                      );
                    }
                  };
                  reader.readAsDataURL(file);
                };
                input.click();
              }}
            >
              Thinking
            </button>

            <button
              class="btn primary"
              ?disabled=${!props.connected}
              @click=${sendWithTracking}
            >
              ${isBusy ? "Queue" : "Send"}<kbd class="btn-kbd">↵</kbd>
            </button>
          </div>
        </div>
      </div>
    </section>
  `;
}

const CHAT_HISTORY_RENDER_LIMIT = 200;

function groupMessages(items: ChatItem[]): Array<ChatItem | MessageGroup> {
  const result: Array<ChatItem | MessageGroup> = [];
  let currentGroup: MessageGroup | null = null;

  for (const item of items) {
    if (item.kind !== "message") {
      if (currentGroup) {
        result.push(currentGroup);
        currentGroup = null;
      }
      result.push(item);
      continue;
    }

    const normalized = normalizeMessage(item.message);
    const role = normalizeRoleForGrouping(normalized.role);
    const timestamp = normalized.timestamp || Date.now();

    if (!currentGroup || currentGroup.role !== role) {
      if (currentGroup) result.push(currentGroup);
      currentGroup = {
        kind: "group",
        key: `group:${role}:${item.key}`,
        role,
        messages: [{ message: item.message, key: item.key }],
        timestamp,
        isStreaming: false,
      };
    } else {
      currentGroup.messages.push({ message: item.message, key: item.key });
    }
  }

  if (currentGroup) result.push(currentGroup);
  return result;
}

function buildChatItems(props: ChatProps): Array<ChatItem | MessageGroup> {
  const items: ChatItem[] = [];
  const history = Array.isArray(props.messages) ? props.messages : [];
  const tools = Array.isArray(props.toolMessages) ? props.toolMessages : [];
  const historyStart = Math.max(0, history.length - CHAT_HISTORY_RENDER_LIMIT);
  if (historyStart > 0) {
    items.push({
      kind: "message",
      key: "chat:history:notice",
      message: {
        role: "system",
        content: `Showing last ${CHAT_HISTORY_RENDER_LIMIT} messages (${historyStart} hidden).`,
        timestamp: Date.now(),
      },
    });
  }
  for (let i = historyStart; i < history.length; i++) {
    const msg = history[i];
    const normalized = normalizeMessage(msg);

    if (!props.showThinking && normalized.role.toLowerCase() === "toolresult") {
      continue;
    }

    items.push({
      kind: "message",
      key: messageKey(msg, i),
      message: msg,
    });
  }
  if (props.showThinking) {
    for (let i = 0; i < tools.length; i++) {
      items.push({
        kind: "message",
        key: messageKey(tools[i], i + history.length),
        message: tools[i],
      });
    }
  }

  if (props.stream !== null) {
    const key = `stream:${props.sessionKey}:${props.streamStartedAt ?? "live"}`;
    if (props.stream.trim().length > 0) {
      items.push({
        kind: "stream",
        key,
        text: props.stream,
        startedAt: props.streamStartedAt ?? Date.now(),
      });
    } else {
      items.push({ kind: "reading-indicator", key });
    }
  }

  const grouped = groupMessages(items);

  // Mark the last assistant message group for focus styling.
  for (let i = grouped.length - 1; i >= 0; i--) {
    const item = grouped[i];
    if (item && (item as any).kind === "group") {
      const group = item as unknown as MessageGroup;
      const role = String(group.role ?? "").toLowerCase();
      if (role === "assistant") {
        group.isFocus = true;
        break;
      }
    }
  }

  return grouped;
}

function messageKey(message: unknown, index: number): string {
  const m = message as Record<string, unknown>;
  const toolCallId = typeof m.toolCallId === "string" ? m.toolCallId : "";
  if (toolCallId) return `tool:${toolCallId}`;
  const id = typeof m.id === "string" ? m.id : "";
  if (id) return `msg:${id}`;
  const messageId = typeof m.messageId === "string" ? m.messageId : "";
  if (messageId) return `msg:${messageId}`;
  const timestamp = typeof m.timestamp === "number" ? m.timestamp : null;
  const role = typeof m.role === "string" ? m.role : "unknown";
  if (timestamp != null) return `msg:${role}:${timestamp}:${index}`;
  return `msg:${role}:${index}`;
}
