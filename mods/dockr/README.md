# Dockr

A side panel for Herdr that lists Docker containers and sets which checkout each compose service runs from: its repo's Main checkout or one of its git worktrees.

## Install

1. Copy `mods/dockr/` to `~/.config/herdr-app/mods/dockr/`.
2. In your own layout, add a block beside the work area and keep its id `dockr`:
   `{ "id": "dockr", "type": "block", "content": { "mod": "dockr" }, "size": { "px": 400 }, "min": 300, "hidden": true }`
3. Merge `keys.json` into `~/.config/herdr-app/keys.json`. It binds `ctrl-shift-d` to `layout.toggle:dockr`.
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

Each row is one service: a status mark, its program's icon, its name and the branch it runs from.

- **Status.** A green dot is up, a turning ring is starting or being worked on, red is unhealthy or exited with an error, a hollow ring is stopped. Text appears only when something needs saying.
- **Hover a row** for its actions: Stop or Start, Restart, Rebuild, Logs, Shell.
- **Click the branch** to open the Source picker. Type to filter, arrow keys to move, Enter to switch. Each checkout says what it costs: `recreate` takes seconds, `rebuild` builds the image first.
- **Moving several services.** When other services' repos have a worktree on the picked branch, the picker offers "also move <service>", ticked by default. Services you do not move keep their checkout.
- **Start if stopped.** Unticked, a Switch leaves a stopped service stopped.
- **Progress.** A Switch or build shows its step in the row: checking, building, recreating, waiting for healthy. The eye icon opens the output. A failed one turns into a red chip that opens the output, and posts one toast.
- **Back to <branch>.** After a Switch, one button in the note line puts the old checkout back.
- **Use <ticket>?** When the pane you are in is on a branch that a service has a worktree for, the row offers it. Nothing switches without your click.
- **drift.** The service runs from a different checkout than the Stack is set to, because compose was run by hand. Click the chip to bring it back.
- **When a container fails.** The row says why (`exited 137, out of memory`, `health check: connection refused`) and shows its last three log lines. Three exits inside a minute show as `restart loop`, with one toast.
- **Diagnose.** On a failed row. It shows the exact text an agent will get: what Docker reports and the last 100 log lines, with no environment values. Read the log lines first, since a program can print a secret. `Send` starts the agent you pick in a new tab, in the space on that branch when there is one.
- **Logs.** The log icon on a row opens a window for that service. The one in the Stack header opens every service in one stream, in time order, with a toggle per service. Type to search (`/regex/` works), Enter or F3 for the next match, `Time` for timestamps, `Follow` or End to stay at the newest line. Errors are red and warnings amber. The window keeps the last 5,000 lines, and `Open in terminal` gives the raw tail.
- **CPU and memory.** Each running row shows them while the panel is visible, the Stack header shows the totals, and an opened row shows the last 60 samples. A sample arrives about every two seconds.
- **rebuild needed.** The dependency files in the checkout differ from the ones in the image. Click the chip to rebuild. It is checked when the panel shows, on Reload and when containers change.
- **Disk.** The disk icon in the Stack header lists the Stack's images and volumes and what the whole engine holds. `Clean up` removes the images the Stack's rebuilds left behind and, when ticked, other untagged images and unused build cache. It shows what it will remove first and never removes a volume.
- **Click a row** for its image, state, paths, ports, mounts, networks, labels and the names of its environment variables. Dockr never reads their values. Port numbers and link chips open in the browser.
- **Stack header.** One bar segment per service, `Up` when something is not running, and a power icon for Down, which asks first and never removes volumes.
- Builds, log tails and shells run in background terminals. Closing the view leaves them running. `Keep as tab` gives one a tab.

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
