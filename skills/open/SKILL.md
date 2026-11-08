---
name: open
description: Open the MotionForge studio, a local browser app for making animated ad videos with Claude
user-invocable: true
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Launch the local studio by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/launch.mjs"
```

Report the URL printed by the launcher. Everything else happens in the browser: do not collect animation prompts in the terminal, and do not generate or render videos from this skill.

If the launcher fails, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs"` and report which requirement is missing and how to install it.
