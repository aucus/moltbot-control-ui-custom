import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";

import type { AssistantIdentity } from "../assistant-identity";
import { toSanitizedMarkdownHtml } from "../markdown";
import type { MessageGroup } from "../types/chat-types";
import { renderCopyAsMarkdownButton } from "./copy-as-markdown";
import { isToolResultMessage, normalizeRoleForGrouping } from "./message-normalizer";
import {
  extractTextCached,
  extractThinkingCached,
  formatReasoningMarkdown,
} from "./message-extract";
import { extractToolCards, renderToolCardSidebar } from "./tool-cards";

type ImageBlock = {
  url: string;
  alt?: string;
};

function extractImages(message: unknown): ImageBlock[] {
  const m = message as Record<string, unknown>;
  const content = m.content;
  const images: ImageBlock[] = [];

  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as Record<string, unknown>;

      if (b.type === "image") {
        // Handle source object format (from sendChatMessage)
        const source = b.source as Record<string, unknown> | undefined;
        if (source?.type === "base64" && typeof source.data === "string") {
          const data = source.data as string;
          const mediaType = (source.media_type as string) || "image/png";
          // If data is already a data URL, use it directly
          const url = data.startsWith("data:")
            ? data
            : `data:${mediaType};base64,${data}`;
          images.push({ url });
        } else if (typeof b.url === "string") {
          images.push({ url: b.url });
        }
      } else if (b.type === "image_url") {
        // OpenAI format
        const imageUrl = b.image_url as Record<string, unknown> | undefined;
        if (typeof imageUrl?.url === "string") {
          images.push({ url: imageUrl.url });
        }
      }
    }
  }

  return images;
}

export function renderReadingIndicatorGroup(assistant?: AssistantIdentity) {
  return html`
    <div class="chat-group assistant">
      ${renderAvatar("assistant", assistant)}
      <div class="chat-group-messages">
        <div class="chat-bubble chat-reading-indicator" aria-hidden="true">
          <span class="chat-reading-indicator__dots">
            <span></span><span></span><span></span>
          </span>
        </div>
      </div>
    </div>
  `;
}

export function renderStreamingGroup(
  text: string,
  startedAt: number,
  onOpenSidebar?: (content: string) => void,
  assistant?: AssistantIdentity,
) {
  const timestamp = new Date(startedAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const name = assistant?.name ?? "Assistant";

  return html`
    <div class="chat-group assistant">
      ${renderAvatar("assistant", assistant)}
      <div class="chat-group-messages">
        ${renderGroupedMessage(
          {
            role: "assistant",
            content: [{ type: "text", text }],
            timestamp: startedAt,
          },
          { isStreaming: true, showReasoning: false },
          onOpenSidebar,
        )}
        <div class="chat-group-footer">
          <span class="chat-sender-name">${name}</span>
          <span class="chat-group-timestamp">${timestamp}</span>
        </div>
      </div>
    </div>
  `;
}

export function renderMessageGroup(
  group: MessageGroup,
  opts: {
    onOpenSidebar?: (content: string) => void;
    showReasoning: boolean;
    assistantName?: string;
    assistantAvatar?: string | null;
  },
) {
  const normalizedRole = normalizeRoleForGrouping(group.role);
  const assistantName = opts.assistantName ?? "Assistant";
  const who =
    normalizedRole === "user"
      ? "You"
      : normalizedRole === "assistant"
        ? assistantName
        : normalizedRole;
  const roleClass =
    normalizedRole === "user"
      ? "user"
      : normalizedRole === "assistant"
        ? "assistant"
        : "other";
  const timestamp = new Date(group.timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  const focusClass = group.isFocus && roleClass === "assistant" ? "focus" : "";

  const renderedMessages = group.messages.map((item, index) =>
    renderGroupedMessage(
      item.message,
      {
        isStreaming: group.isStreaming && index === group.messages.length - 1,
        showReasoning: false,
        suppressInternals: true,
      },
      opts.onOpenSidebar,
    ),
  );

  // If a group contains only internal/tool messages (fully suppressed), hide the entire group.
  const hasVisibleMessage = renderedMessages.some((m) => m !== nothing);
  if (!hasVisibleMessage) return nothing;

  return html`
    <div class="chat-group ${roleClass} ${focusClass}" id="chat-${group.key}">
      ${renderAvatar(group.role, {
        name: assistantName,
        avatar: opts.assistantAvatar ?? null,
      })}
      <div class="chat-group-messages">
        ${renderedMessages}
        <div class="chat-group-footer">
          <span class="chat-sender-name">${who}</span>
          <span class="chat-group-timestamp">${timestamp}</span>
        </div>
      </div>
    </div>
  `;
}

function renderAvatar(
  role: string,
  assistant?: Pick<AssistantIdentity, "name" | "avatar">,
) {
  const normalized = normalizeRoleForGrouping(role);
  const assistantName = assistant?.name?.trim() || "Assistant";
  const assistantAvatar = assistant?.avatar?.trim() || "";
  const initial =
    normalized === "user"
      ? "U"
      : normalized === "assistant"
        ? assistantName.charAt(0).toUpperCase() || "A"
        : normalized === "tool"
          ? "⚙"
          : "?";
  const className =
    normalized === "user"
      ? "user"
      : normalized === "assistant"
        ? "assistant"
      : normalized === "tool"
          ? "tool"
          : "other";

  if (assistantAvatar && normalized === "assistant") {
    if (isAvatarUrl(assistantAvatar)) {
      return html`<img
        class="chat-avatar ${className}"
        src="${assistantAvatar}"
        alt="${assistantName}"
      />`;
    }
    return html`<div class="chat-avatar ${className}">${assistantAvatar}</div>`;
  }

  return html`<div class="chat-avatar ${className}">${initial}</div>`;
}

function isAvatarUrl(value: string): boolean {
  return (
    /^https?:\/\//i.test(value) ||
    /^data:image\//i.test(value) ||
    /^\//.test(value) // Relative paths from avatar endpoint
  );
}

function renderMessageImages(images: ImageBlock[]) {
  if (images.length === 0) return nothing;

  return html`
    <div class="chat-message-images">
      ${images.map(
        (img) => html`
          <img
            src=${img.url}
            alt=${img.alt ?? "Attached image"}
            class="chat-message-image"
            @click=${() => window.open(img.url, "_blank")}
          />
        `,
      )}
    </div>
  `;
}

function renderGroupedMessage(
  message: unknown,
  opts: { isStreaming: boolean; showReasoning: boolean; suppressInternals?: boolean },
  onOpenSidebar?: (content: string) => void,
) {
  const m = message as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role : "unknown";
  const isToolResult =
    isToolResultMessage(message) ||
    role.toLowerCase() === "toolresult" ||
    role.toLowerCase() === "tool_result" ||
    typeof m.toolCallId === "string" ||
    typeof m.tool_call_id === "string";

  const toolCards = extractToolCards(message);
  const hasToolCards = toolCards.length > 0;
  const images = extractImages(message);
  const hasImages = images.length > 0;

  const extractedText = extractTextCached(message);
  const extractedThinking =
    opts.showReasoning && role === "assistant"
      ? extractThinkingCached(message)
      : null;
  const markdownBase = extractedText?.trim() ? extractedText : null;
  const reasoningMarkdown = extractedThinking
    ? formatReasoningMarkdown(extractedThinking)
    : null;
  const markdown = markdownBase;
  const canCopyMarkdown = role === "assistant" && Boolean(markdown?.trim());

  const bubbleClasses = [
    "chat-bubble",
    canCopyMarkdown ? "has-copy" : "",
    opts.isStreaming ? "streaming" : "",
    "fade-in",
  ]
    .filter(Boolean)
    .join(" ");

  if (!markdown && hasToolCards && isToolResult) {
    return html`${toolCards.map((card) =>
      renderToolCardSidebar(card, onOpenSidebar),
    )}`;
  }

  // If internals are suppressed (session-wide internals mode), and there's no user-visible
  // text/images to show, don't render anything for this message.
  if (opts.suppressInternals && !markdown && !hasImages) return nothing;

  if (!markdown && !hasToolCards && !hasImages) return nothing;

  // Collapse internal/tool messages by default.
  const isInternal =
    role === "tool" ||
    isToolResult ||
    role.toLowerCase() === "toolresult" ||
    role.toLowerCase() === "tool_result";

  // When the parent group wants to show a single global "⋯" internals, suppress per-message internals.
  if (opts.suppressInternals && isInternal) return nothing;

  const internalSections = html`
    ${reasoningMarkdown
      ? html`
          <div class="chat-internal-section">
            <div class="chat-internal-section__title">Reasoning</div>
            <div class="chat-thinking">${unsafeHTML(
              toSanitizedMarkdownHtml(reasoningMarkdown),
            )}</div>
          </div>
        `
      : nothing}
    ${toolCards.length
      ? html`
          <div class="chat-internal-section">
            <div class="chat-internal-section__title">Tool (${toolCards.length})</div>
            <div class="chat-internal-section__body">
              ${toolCards.map((card) => renderToolCardSidebar(card, onOpenSidebar))}
            </div>
          </div>
        `
      : nothing}
  `;

  // Per-message internals: disabled when suppressInternals=true (we'll render a single group-level ⋯).
  const internalBlock =
    !opts.suppressInternals && !isInternal && (reasoningMarkdown || toolCards.length)
      ? html`
          <details class="chat-internal-details">
            <summary
              class="chat-internal-details__summary"
              aria-label="Show internals"
              title="Show internals"
            >
              ⋯
            </summary>
            <div class="chat-internal-details__content">${internalSections}</div>
          </details>
        `
      : nothing;

  const content = html`
    ${canCopyMarkdown ? renderCopyAsMarkdownButton(markdown!) : nothing}
    ${renderMessageImages(images)}
    ${internalBlock}
    ${markdown
      ? html`<div class="chat-text">${unsafeHTML(
          toSanitizedMarkdownHtml(markdown),
        )}</div>`
      : nothing}
  `;

  // Tool-only / internal messages: fully collapsed container (single ⋯).
  if (isInternal) {
    return html`
      <details class="chat-internal-message">
        <summary
          class="chat-internal-message__summary"
          aria-label="Show internal message"
          title="Show internal message"
        >
          ⋯
        </summary>
        <div class="chat-internal-message__content ${bubbleClasses}">
          ${renderMessageImages(images)}
          ${internalSections}
          ${markdown
            ? html`<div class="chat-text">${unsafeHTML(
                toSanitizedMarkdownHtml(markdown),
              )}</div>`
            : nothing}
        </div>
      </details>
    `;
  }

  return html`
    <div class="${bubbleClasses}">
      ${content}
    </div>
  `;
}
