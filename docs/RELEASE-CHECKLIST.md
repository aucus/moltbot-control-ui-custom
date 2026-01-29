# Release / Publish Checklist

This repo is a fork/customization of the upstream Control UI. Use this checklist when you want to publish a new version.

## Before pushing
- [ ] Run `pnpm -C ui build`
- [ ] Verify Activity panel:
  - [ ] default open
  - [ ] Hide/Show toggle works
  - [ ] auto-follow works
  - [ ] scroll lock triggers when user scrolls up
  - [ ] Follow button resumes and jumps to bottom
  - [ ] both wall-clock + elapsed show

## Hygiene
- [ ] Ensure `dist/` is not tracked (should be ignored)
- [ ] Ensure local caches are ignored (`.serena/`, `.trash/`, etc.)
- [ ] Confirm no secrets committed

## GitHub
- [ ] Update README if behavior changed
- [ ] Tag a release if needed
