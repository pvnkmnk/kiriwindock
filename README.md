# Dockr

A side panel that lists Docker containers and sets which checkout each compose service runs from: the main checkout or a git worktree.

![Dockr](preview.png)

## Features

- Containers grouped by compose project, as Docker Desktop groups them, with live CPU and memory. This part needs no config.
- Start, stop, restart, rebuild, logs, terminal, inspect and stats for each container, by mouse or vim-style keys.
- A checkout picker moves a service to a worktree's branch, says whether that is a recreate or a rebuild, and offers Undo.
- A failed container says why on its row. Diagnose hands an agent Docker's report and the last 100 log lines.
- It flags a service running a different checkout than the one set, and an image older than its dependency files.
- A Disk view with a clean-up that never removes volumes.

## Needs

- Docker with compose, git, `sh` and `bash`. On Windows, point it at a WSL Machine.
- A block in your own layout, and `ctrl-shift-d`.
- It runs docker and git, opens links in your browser, reads `~/.config/herdr-app/dockr.json` and writes `.dockr.env` beside the compose file. It never opens `.env` or reads the value of an environment variable.

## Install

Tell your agent:

```text
Read ~/.config/herdr-app/AGENTS.md, then add this mod: https://github.com/jbped/herdr-mods/tree/main/dockr
```

Or by hand:

1. Copy `mods/dockr/` to `~/.config/herdr-app/mods/`.
2. In your own layout, add this block beside the work area:
   `{ "id": "dockr", "type": "block", "content": { "mod": "dockr" }, "size": { "px": 400 }, "min": 300, "hidden": true }`
3. Merge `keys.json` into `~/.config/herdr-app/keys.json`.
4. Run `herdr-app check ~/.config/herdr-app/mods/dockr`, then press `ctrl-shift-d`.

The checkout picker needs `dockr.json`. The config file, every key and limits: [`mods/dockr/README.md`](mods/dockr/README.md).
