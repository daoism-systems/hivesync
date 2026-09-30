# HiveSync OpenClaw Skill

A small OpenClaw skill (`waku-bridge`) that drives a HiveSync `BridgeManager`
from natural-language commands.

> **Setting up OpenClaw with HiveSync?** Use [`openclaw-setup.sh`](../openclaw-setup.sh)
> from the repo root instead — it builds HiveSync, writes the daemon config,
> installs the [hivesync-openclaw-plugin](https://github.com/clawbotl37/hivesync-openclaw-plugin)
> channel, and sets up the systemd services. For event-driven wake-ups on
> incoming messages, see `hooks.onMessage` and [`scripts/on-message.sh`](../scripts/on-message.sh).

This directory is not published to any registry; build it locally against a
built HiveSync checkout.

## Build

```bash
# from the repo root
npm install && npm run build

cd openclaw-skill
npm install
npm run build
```

## Configuration

Run the HiveSync setup wizard once (`node dist/cli.js setup` from the repo
root), then enable the skill in OpenClaw:

```yaml
skills:
  - name: waku-bridge
    enabled: true
    config:
      agentId: "your-agent-id"
      storagePath: "/path/to/hivesync/data/hivesync.db"
```

## Commands

The skill matches on keywords in the user's text:

- "Check bridge status"
- "Send message to agent-alpha Hello there!"
- "Sync my Obsidian notes"
- "List agents"
- "Check for new messages"
- "Help"

## License

MIT
