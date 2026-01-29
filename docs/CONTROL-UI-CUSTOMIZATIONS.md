# Control UI Customizations

This repository is a small, respectful customization layer on top of the upstream **Clawdbot/Moltbot Gateway Control UI**.

## Goal
When a run takes a while, the default chat UI can look like it "froze" (e.g., you only see `...`).
This fork adds an **Activity** panel that behaves like a terminal log so it's obvious the system is still working.

## What changed
### 1) Right-side Activity panel (terminal-like)
- Always visible by default; can be toggled (collapse/expand).
- Auto-follow by default.
- If the user scrolls away from the bottom, the panel **locks** (stops auto-follow).
- A **Follow** button appears to resume following.

### 2) Richer progress signals
- Tool usage is streamed as line-by-line log entries:
  - `tool · start · args: ...`
  - `tool · update · ...`
  - `tool · result · ...`
- Best-effort LLM phase lines:
  - `LLM 생각중…`
  - `답변 생성 중…`

### 3) Timestamp + elapsed
Each line shows:
- wall-clock time (`HH:MM:SS`)
- elapsed time from run start (`+12.3s`, `+1:05`, etc.)

## Where to look
- UI rendering: `ui/src/ui/views/chat.ts`
- Activity log aggregation: `ui/src/ui/app-tool-stream.ts`
- Settings persistence (default open): `ui/src/ui/storage.ts`
- Styles:
  - `ui/src/styles/chat/activity.css`
  - `ui/src/styles/chat/questions.css`

## Development
```bash
pnpm -C ui dev
# or
pnpm -C ui build
```

## Notes
- This repo intentionally keeps changes local and easy to review.
- Please keep upstream attribution intact.
