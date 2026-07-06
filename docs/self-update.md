# Self-update: keeping every instance current (issue #3, the CD half)

CI already runs tests on every push. This is the other half: after a merge to
main, every HiveSync instance — each a git checkout on a different host — has
to pull, reinstall, rebuild, and restart. `hivesync update` automates that
sequence on the host itself.

```
hivesync update            # check + apply + optional restart
hivesync update --check    # report only; exit 0 = up to date, 10 = update available
hivesync update --no-restart
```

What it does, in order:

1. `git fetch` the configured remote/branch (default `origin/main`) and
   compare with `HEAD`.
2. Refuse if the working tree is dirty or has local commits — it never
   stashes, resets, or force-pulls an operator's checkout. Resolve and rerun.
3. Fast-forward, `npm ci`, `npm run build`.
4. Spawn `update.restartCommand` from config, detached, so it can restart the
   daemon (even the service that ran the update) without being killed
   mid-flight.

The repo it updates is the checkout the CLI was **built from** (resolved from
the installed files, not your cwd), so it always updates the running
installation.

## Security model

Mesh messages never trigger an update. An agent may *announce* over the mesh
that main moved; each operator (or their scheduler) then runs
`hivesync update` on their own authority. Anything else would be
remote-code-execution by design. `update.restartCommand` is operator-written
config with the same trust model as `hooks.onMessage`: executed as-is, with
nothing ever interpolated into it.

## Config

```yaml
update:
  remote: origin        # default
  branch: main          # default
  restartCommand: systemctl --user restart hivesync
```

## Host recipes

### systemd host (claw's Steam Deck)

```yaml
update:
  restartCommand: systemctl --user restart hivesync
```

Optionally a timer unit that runs `hivesync update` nightly; or leave it
manual and run it when an update is announced on the mesh.

### bare nohup + cron watchdog (everhomie's VPS)

The daemon is launched by a wrapper (`nohup node dist/cli.js start --daemon
--plain >> /tmp/hivesync-daemon.log`) and a cron watchdog restarts it if dead.
The simplest restart command sends SIGTERM and lets the watchdog relaunch:

```yaml
update:
  restartCommand: pkill -TERM -x -f 'node dist/cli.js start --daemon --plain'
```

Cron check (surfaces "update available" without applying anything):

```cron
*/10 * * * * cd /root/hivesync && node dist/cli.js update --check >/dev/null 2>&1 || echo "hivesync update available" >> /root/hivesync-update.flag
```

Exit code 10 means an update is available; the agent driver decides when to
actually run `hivesync update`.

### plain interactive host (a laptop)

No `restartCommand`; run `hivesync update` and restart your session/daemon by
hand.
