---
kind: upgrade-guide
description: Desktop plugin package writes require the application to be fully stopped.
---
# Desktop plugin updates require a stopped application

English | [中文](guide.zh.md)

## Change

Desktop package writes through `dsh plugin --profile desktop` refuse a running or uninspectable application. They install into a complete profile copy before replacing dependencies. Package queries remain available. Linked profile roots, linked dependency roots, and external virtual stores require a physical profile before package writes. CLI stdout and stderr are forwarded and retained in `pnpm.log` instead of bypassing diagnostic capture.

## Migration

1. Fully quit DeepSeek Harness Desktop, including its background shell.
2. Use the Desktop-installed `dsh plugin --profile desktop add <package>` or other package write command. Keep Desktop stopped until it returns.
3. Reopen Desktop. Launch preparation restores an interrupted directory swap before loading plugins. If recovery reports later manifest changes, retain the journal and previous directory for manual recovery instead of deleting them.
4. Check the reported diagnostic path when installation fails; the active dependency tree remains unchanged before commit.
