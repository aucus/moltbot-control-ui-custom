# moltbot-control-ui-custom

A respectful, minimal customization fork of the upstream **Clawdbot/Moltbot Gateway Control UI**.

## Why
When a run takes a while, a chat UI can look like it froze (e.g., you only see `...`).
This fork adds a right-side **Activity** panel that behaves like a terminal log so you can always tell it's still working.

## Features
- Right-side **Activity (terminal-like) panel**
  - Default: open
  - Toggle: Hide/Show
  - Auto-follow logs; if the user scrolls, it locks ("follow" can be resumed)
- Richer progress visibility
  - Tool start/update/result lines
  - Best-effort LLM phase lines (e.g., "LLM 생각중…", "답변 생성 중…")
- Each line shows **wall-clock** (`HH:MM:SS`) + **elapsed** (`+12.3s`) time

## Development
```bash
pnpm -C ui dev
# or
pnpm -C ui build
```

## Upstream / Attribution
This project is derived from the upstream implementation in the Clawd ecosystem:
- https://github.com/clawdbot/clawdbot

We keep upstream attribution intact and try to keep changes small and upstream-friendly.

## License
MIT (see `LICENSE`).
