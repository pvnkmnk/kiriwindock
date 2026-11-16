# Dockr

A side panel for Herdr that lists Docker containers and sets which checkout each compose service runs from: its repo's Main checkout or one of its git worktrees.

## Install

1. Copy `mods/dockr/` to `~/.config/herdr-app/mods/dockr/`.
2. In your own layout, add a block beside the work area and keep its id `dockr`:
   `{ "id": "dockr", "type": "block", "content": { "mod": "dockr" }, "size": { "px": 400 }, "min": 300, "hidden": true }`
3. Merge `keys.json` into `~/.config/herdr-app/keys.json`. It binds `ctrl-shift-d` twice: globally to `mod.open:dockr`, which shows the panel and gives it the keyboard, and in the `mod:dockr` section to `dockr.hide`, which hides the panel while it has the keyboard.
4. Write `~/.config/herdr-app/dockr.json` (below).
5. Run `herdr-app check ~/.config/herdr-app/mods/dockr`.

Dockr starts the first time its panel is shown. Toasts only arrive after that.

## The config file

`~/.config/herdr-app/dockr.json`. With no file, Dockr lists every container and manages none.

```json
{
  "stacks": [
    {
      "name": "shop-local",
      "machine": "wsl",
      "compose": "/mnt/c/dev/shop/deploy/docker-compose.local.yml",
      "services": {
        "gateway": { "var": "API_PATH", "repo": "dev.azure.com/Org/Proj/api-server", "main": "/mnt/c/dev/shop/api-server" },
        "reports": { "var": "REPORTS_PATH", "main": "/mnt/c/dev/shop/reports", "manifests": ["Reports.API/Reports.API.csproj"] }
      },
      "urls": {
        "https://app.example.test": { "label": "Review UI", "service": "web" },
        "http://localhost:3010/api/health": "Gateway health"
      }
    }
  ]
}
```

- `name`: the compose project's name.
- `machine`: the Machine that Docker and git commands run on. Leave it out for this computer. It needs `sh` and `bash`, so Windows itself is not supported: use its WSL.
- `compose`: the compose file's absolute path on that Machine.
- `services.<name>.var`: the compose variable that sets the service's checkout.
- `services.<name>.main`: the Main checkout's path. Optional when `repo` is listed in `wranglr.json` with a path for that Machine.
- `services.<name>.manifests`: the dependency files compared to decide on a rebuild, relative to the checkout and to the image's working directory. Default: `package.json` and `package-lock.json`. No wildcards.
- `urls`: links, each with a label. A link shows under the service that serves it: the one named in `service`, else the one publishing the link's `localhost` port. A link with neither shows under the Stack's name.

## Using it

The panel is a list of containers, grouped the way Docker Desktop groups them: one group per compose project, then the containers in none. No config is needed for that. A project listed in `dockr.json` also gets the checkout picker.

**The toolbar**
- **Search** filters by name, image, branch or published port. `Running` hides everything that is not running.
- The refresh icon reads Docker, the worktrees and `dockr.json` again.

**A group**
- The header says `Running (4/6)`, the Machine, and the group's CPU and memory in all.
- `Start` appears when something is not running. The stop icon stops every container and keeps them.
- The `⋯` menu, or a right-click, has the logs of every container in one stream, Disk and clean-up, and Remove containers (compose down, which asks first and never removes volumes).

**A container**
- A green dot is running, a turning ring is starting or being worked on, red is unhealthy or exited with an error, a hollow ring is stopped.
- The second line shows the checkout it runs from, or its image, then its links. A container with no configured link shows its published ports. Click one to open it in the browser.
- **Hover** for Logs, Terminal, Restart, Stop or Start, and `⋯`. **Right-click** for the same menu, which also has Rebuild image, Change checkout, Diagnose and Copy name, ID or image.
- **Click** the row to open the container: Logs, Inspect and Stats tabs, with Terminal, Restart and Stop in the title bar.

**The container window**
- **Logs.** Type to search (`/regex/` works), Enter or F3 for the next match, `Time` for timestamps, `Follow` or End to stay at the newest line. Errors are red and warnings amber. It keeps the last 5,000 lines. The eye icon opens the raw tail in a terminal.
- **Inspect.** Image, command, state, ports, mounts, networks, labels and the names of its environment variables. Dockr never reads their values.
- **Stats.** CPU and memory over the last minutes, network and disk in and out. It samples only while the tab shows.

**Keys**

The keys follow CodeyPacker's mods (`run`, `jump`, `branch`), so they are the same letters you use there. `ctrl-shift-d` shows the panel and gives it the keyboard. Letter badges and a short legend (move, open, start or stop, restart) appear while it has it. `?` lists every key that works on the selected row.

| Key | Action |
|---|---|
| `j` / `k`, arrows, `ctrl-n` / `ctrl-p` | move |
| a row's letter | jump to it |
| `enter` | open the container, or fold a group |
| `s` / `x` / `r` | start / stop / restart |
| `t` | terminal |
| `c` | change checkout |
| `b` | rebuild image |
| `d` | diagnose a failed container |
| `o` | open its first link or port in the browser |
| `y` | copy the container name |
| `u` / `X` | start all / stop all in the group |
| `D` | remove the group's containers (asks first) |
| `h` / `l` | fold / unfold the group |
| `g` / `G` | first / last |
| `/` | search (`enter` or `esc` returns to the list) |
| `m` | the `⋯` menu (`j`/`k`, `enter`) |
| `q`, `esc` | hand the keyboard back to your pane |

- **Container window:** `h`/`l` switch tabs, `j`/`k` move a line, `g`/`G` top and end, `/` search, `n`/`N` next and previous match, `f` follow, `t` timestamps, `y` copy, `s`/`x`/`r` start, stop and restart, `T` terminal, `q` close.
- **Checkout picker:** it has a filter box, so plain letters type. Arrows or `ctrl-j`/`ctrl-k` move, `enter` switches, `ctrl-r` rebuilds, `ctrl-s` toggles "Start if stopped".
- The panel is `focusable`, so Herdr's pane movement keys reach it too, and "Dockr: Keys" in the palette does what `ctrl-shift-d` does.
- Dockr reaches the panel by stepping focus to the right, and leaves to the left. A layout with the panel on the left needs those two directions swapped in `main.js`.

**Choosing a checkout** (projects in `dockr.json`)
- Click the branch on a container's second line. Type to filter, arrow keys to move, Enter to switch. Each checkout says what it costs: `recreate` takes seconds, `rebuild` builds the image first.
- When other services have a worktree on the picked branch, the picker offers "also move <service>", ticked by default. Unticked, `Start if stopped` leaves a stopped service stopped.
- A Switch or build shows its step on the row: checking, building, recreating, waiting for healthy. A failed one becomes a red chip that opens the output.
- `Undo: back to <branch>` appears after a Switch.
- `Switch to <ticket>` appears on a container when the pane you are in is on a branch it has a worktree for. Nothing switches without your click.

**When something needs you**, the row says so in a sentence, with buttons:
- **A failure:** why (`exited 137, out of memory`, `health check: connection refused`), the last three log lines, and `Diagnose`, `Logs`, `Start`. Three exits inside a minute show as `restart loop`.
- **Diagnose** shows the exact text an agent will get: what Docker reports and the last 100 log lines, with no environment values. Read the log lines first, since a program can print a secret. `Send` starts the agent you pick in a new tab, in the space on that branch when there is one.
- **A different checkout than the one set** (drift), which a compose command run outside Dockr causes: switch back, or keep what runs.
- **Dependency files changed since the image was built:** `Rebuild`.

**Disk** lists the Stack's images and volumes and what the whole engine holds. `Clean up` removes the images the Stack's rebuilds left behind and, when ticked, other untagged images and unused build cache. It shows what it will remove first and never removes a volume.

Builds, log tails and terminals run in background terminals. Closing the view leaves them running. `Keep as tab` gives one a tab.

## How it stores a Switch

Dockr writes the path variables to `.dockr.env` beside the compose file and passes `--env-file .env --env-file .dockr.env` on every compose command. It never opens `.env`. Keep `.dockr.env` out of git.

A compose command run by hand does not load `.dockr.env`, so it builds from the Main checkouts. Dockr shows that as drift.

## Limits

- `rebuild needed` covers services with a bind mount. For one without, Dockr cannot tell that its checkout changed since the build.
- On engines that drop the old image when compose rebuilds (Docker Desktop's containerd image store does), "left behind by rebuilds" stays at 0. The space is in the build cache and in untagged images.
- A service with no bind mount shows `unknown` until Dockr itself builds it, because Docker does not record which folder an image was built from.
- Differences outside `src` other than the manifests are not detected. Use Rebuild.
- Dockr waits on `docker events` for changes. If that wait cannot run on a Machine, a warning says so and Reload is the way to refresh.

## Tests

`sh dockr/tests/run.sh` runs the decision tests and, when Docker is running, every action against a small throwaway compose project (about a minute). `DOCKR_SKIP_DOCKER=1` skips that part.
