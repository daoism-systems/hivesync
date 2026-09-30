"""
HiveSync Platform Adapter for Hermes Agent.

Plugin-based gateway adapter that polls a local HiveSync daemon's SQLite
database and relays messages to/from the Hermes agent over the Waku P2P
network.

Configuration in config.yaml::

    gateway:
      platforms:
        hivesync:
          enabled: true
          extra:
            home: /path/to/hivesync
            agent_id: everhomie
            db_path: /path/to/hivesync/data/hivesync.db
            poll_interval: 15
            allowed_users: []
            allow_all: false

Trust is established by the HiveSync daemon via a per-peer handshake the local
user approves (`node dist/cli.js approve <agent-id>`); there is no password.

Environment variables (override config.yaml):
    HIVESYNC_HOME, HIVESYNC_AGENT_ID, HIVESYNC_DB_PATH,
    HIVESYNC_POLL_INTERVAL, HIVESYNC_ALLOWED_USERS, HIVESYNC_ALLOW_ALL_USERS
"""

import asyncio
import json
import logging
import os
import sqlite3
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

logger = logging.getLogger(__name__)

from gateway.platforms.base import (
    BasePlatformAdapter,
    SendResult,
    MessageEvent,
    MessageType,
)
from gateway.config import Platform


def _read_db(db_path, last_ts, our_agent):
    """Query HiveSync SQLite DB for messages since last_ts (ISO timestamp).

    last_ts may be empty for initial fetch (returns the single most recent
    message).  Uses a *timestamp-based* cursor so UUID-ordering skew can
    never cause missed messages.
    """
    if not os.path.exists(db_path):
        return []
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        if last_ts:
            cur.execute(
                "SELECT id, sender, recipient, content, timestamp "
                "FROM messages WHERE timestamp > ? AND sender != ? "
                "ORDER BY timestamp ASC",
                (last_ts, our_agent),
            )
        else:
            cur.execute(
                "SELECT id, sender, recipient, content, timestamp "
                "FROM messages WHERE sender != ? "
                "ORDER BY timestamp DESC LIMIT 1",
                (our_agent,),
            )
        rows = [dict(r) for r in cur.fetchall()]
        conn.close()
        if not last_ts and rows:
            rows.reverse()
        return rows
    except Exception as e:
        logger.debug("HiveSync DB poll error: %s", e)
        return []


async def _send_hivesync(cli_path, recipient, message):
    """Send a message via the HiveSync CLI."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "node", cli_path, "send", "--no-sync", recipient, message,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(Path(cli_path).parent.parent),
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=60)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            return {"success": False, "error": "CLI timeout (60s)"}

        if proc.returncode == 0:
            output = stdout.decode().strip()
            for line in output.splitlines():
                if "Message sent! ID:" in line:
                    msg_id = line.split("ID:")[-1].strip()
                    return {"success": True, "message_id": msg_id}
            return {"success": True, "message_id": str(int(time.time() * 1000))}
        else:
            err = stderr.decode().strip() or stdout.decode().strip()
            return {"success": False, "error": err}
    except FileNotFoundError:
        return {"success": False, "error": "node not found"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def check_requirements():
    home = os.getenv("HIVESYNC_HOME", "/root/hivesync")
    cli = os.path.join(home, "dist", "cli.js")
    if not os.path.exists(cli):
        logger.warning("HiveSync: CLI not found at %s", cli)
        return False
    return True


def validate_config(config):
    try:
        extra = getattr(config, "extra", {}) or {}
        if isinstance(extra, dict):
            home = os.getenv("HIVESYNC_HOME") or extra.get("home", "/root/hivesync")
            agent_id = os.getenv("HIVESYNC_AGENT_ID") or extra.get("agent_id", "")
            if not home or not agent_id:
                return False
            cli = os.path.join(home, "dist", "cli.js")
            if not os.path.exists(cli):
                return False
            return True
        return False
    except Exception:
        return False


def is_connected(config):
    extra = getattr(config, "extra", {}) or {}
    if not isinstance(extra, dict):
        extra = {}
    home = os.getenv("HIVESYNC_HOME") or extra.get("home", "/root/hivesync")
    db = os.getenv("HIVESYNC_DB_PATH") or extra.get("db_path",
               os.path.join(home, "data", "hivesync.db"))
    return os.path.exists(db)


async def interactive_setup():
    return {
        "home": "/root/hivesync",
        "agent_id": "everhomie",
        "poll_interval": 30,
        "allow_all": False,
    }


def _env_enablement():
    home = os.getenv("HIVESYNC_HOME")
    agent_id = os.getenv("HIVESYNC_AGENT_ID")
    if not home or not agent_id:
        return None
    db_path = os.getenv("HIVESYNC_DB_PATH") or os.path.join(home, "data", "hivesync.db")
    extra = {"home": home, "agent_id": agent_id, "db_path": db_path}
    poll = os.getenv("HIVESYNC_POLL_INTERVAL")
    if poll:
        try:
            extra["poll_interval"] = int(poll)
        except ValueError:
            pass
    allow_all = os.getenv("HIVESYNC_ALLOW_ALL_USERS", "").lower() in {"1", "true", "yes"}
    extra["allow_all"] = allow_all
    allowed = os.getenv("HIVESYNC_ALLOWED_USERS", "")
    if allowed:
        extra["allowed_users"] = [u.strip() for u in allowed.split(",") if u.strip()]
    home_channel = os.getenv("HIVESYNC_HOME_CHANNEL")
    if not home_channel and allowed:
        home_channel = allowed.split(",")[0].strip()
    if home_channel:
        extra["home_channel"] = home_channel
    return {"extra": extra, "home_channel": home_channel or None}


class HiveSyncAdapter(BasePlatformAdapter):
    """Polling adapter for HiveSync P2P messaging."""

    MAX_MESSAGE_LENGTH = 4096

    def __init__(self, config, **kwargs):
        platform = Platform("hivesync")
        super().__init__(config=config, platform=platform)
        extra = getattr(config, "extra", {}) or {}
        self.home = os.getenv("HIVESYNC_HOME") or extra.get("home", "/root/hivesync")
        self.agent_id = os.getenv("HIVESYNC_AGENT_ID") or extra.get("agent_id", "everhomie")
        self.db_path = os.getenv("HIVESYNC_DB_PATH") or extra.get("db_path",
                        os.path.join(self.home, "data", "hivesync.db"))
        try:
            self.poll_interval = int(
                os.getenv("HIVESYNC_POLL_INTERVAL") or extra.get("poll_interval", 30)
            )
        except (ValueError, TypeError):
            self.poll_interval = 30
        self.cli_path = os.path.join(self.home, "dist", "cli.js")
        self.allow_all = (
            os.getenv("HIVESYNC_ALLOW_ALL_USERS", "").lower() in {"1", "true", "yes"}
            if os.getenv("HIVESYNC_ALLOW_ALL_USERS")
            else extra.get("allow_all", False)
        )
        self.allowed_users = extra.get("allowed_users", [])
        self._allowed_set = {u.lower() for u in self.allowed_users if isinstance(u, str)}
        self._last_seen_ts = ""
        self._poll_task = None
        self._last_poll_ts = 0.0
        self._known_agents = {}
        # Message ids already relayed to Hermes/Telegram. Guarantees we never
        # send a duplicate notification even if a poll batch is replayed (e.g.
        # after a transient handle_message failure or a cursor that didn't
        # advance). Bounded so it can't grow without limit.
        self._relayed_ids: Set[str] = set()
        self._relayed_order: List[str] = []

    @property
    def name(self):
        return "hivesync"

    def _is_authorized(self, sender):
        if self.allow_all:
            return True
        if not self._allowed_set:
            return True
        return sender.lower() in self._allowed_set

    def _extract_text(self, content):
        if isinstance(content, dict):
            return content.get("text", str(content))
        if isinstance(content, str):
            try:
                return json.loads(content).get("text", content)
            except (json.JSONDecodeError, TypeError):
                return content
        return str(content)

    def _watermark(self, sender, recipient, text):
        """Tag a relayed message so the user can tell HiveSync agent traffic
        apart from messages addressed directly to them (see issues #24 / #10).

        Renders a `[HiveSync]` watermark plus from/to routing, e.g.::

            🐝 [HiveSync] claw → you
            <message text>
        """
        target = "everyone" if recipient == "broadcast" else "you"
        return f"🐝 [HiveSync] {sender} → {target}\n{text}"

    def _remember_relayed(self, msg_id):
        """Record a relayed message id, bounding the dedup set's size."""
        self._relayed_ids.add(msg_id)
        self._relayed_order.append(msg_id)
        if len(self._relayed_order) > 5000:
            old = self._relayed_order.pop(0)
            self._relayed_ids.discard(old)

    async def connect(self, is_reconnect=False, **kwargs):
        if not os.path.exists(self.db_path):
            logger.warning("HiveSync: DB not found at %s", self.db_path)
            return False
        if not os.path.exists(self.cli_path):
            logger.warning("HiveSync: CLI not found at %s", self.cli_path)
            return False
        logger.info("HiveSync: starting poll loop for agent '%s' (interval=%ss)",
                     self.agent_id, self.poll_interval)
        state_file = Path(self.home) / "data" / ".hermes-last-ts"
        if state_file.exists():
            self._last_seen_ts = state_file.read_text().strip()
        self._poll_task = asyncio.create_task(self._poll_loop())
        return True

    async def disconnect(self):
        if self._poll_task:
            self._poll_task.cancel()
            try:
                await self._poll_task
            except asyncio.CancelledError:
                pass
            self._poll_task = None
        logger.info("HiveSync: disconnected")

    async def _poll_loop(self):
        while True:
            try:
                await self._poll_once()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.debug("HiveSync poll error: %s", e)
            await asyncio.sleep(self.poll_interval)

    async def _poll_once(self):
        rows = _read_db(self.db_path, self._last_seen_ts, self.agent_id)
        if not rows:
            return
        for row in rows:
            msg_id = row["id"]
            sender = row["sender"]
            recipient = row["recipient"]
            content = row["content"]
            timestamp = row["timestamp"]
            if sender == self.agent_id:
                continue
            # Dedup: never relay the same message twice, even if a batch is
            # replayed after a transient failure.
            if msg_id in self._relayed_ids:
                self._advance_cursor(timestamp)
                continue
            if not self._is_authorized(sender):
                logger.info("HiveSync: unauthorized sender '%s' blocked", sender)
                self._advance_cursor(timestamp)
                continue
            self._known_agents[sender] = sender
            text = self._watermark(sender, recipient, self._extract_text(content))
            source = self.build_source(
                chat_id=sender, chat_name=sender, chat_type="dm",
                user_id=sender, user_name=sender, message_id=msg_id,
            )
            event = MessageEvent(
                text=text, message_type=MessageType.TEXT, source=source,
                message_id=msg_id,
                timestamp=datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
                    if timestamp else datetime.now(),
            )
            await self.handle_message(event)
            # Mark relayed and advance the cursor only after a successful
            # hand-off, so a failure mid-batch can't skip an undelivered message.
            self._remember_relayed(msg_id)
            self._advance_cursor(timestamp)

    def _advance_cursor(self, timestamp):
        """Move the timestamp cursor forward and persist it (best-effort)."""
        if not timestamp or timestamp <= self._last_seen_ts:
            return
        self._last_seen_ts = timestamp
        try:
            state_file = Path(self.home) / "data" / ".hermes-last-ts"
            state_file.parent.mkdir(parents=True, exist_ok=True)
            state_file.write_text(timestamp)
        except Exception:
            pass

    async def send(self, chat_id, content, reply_to=None, metadata=None):
        result = await _send_hivesync(self.cli_path, chat_id, content)
        if result.get("success"):
            return SendResult(success=True, message_id=result.get("message_id"))
        return SendResult(success=False, error=result.get("error", "Unknown error"))

    async def send_typing(self, chat_id, metadata=None):
        pass

    async def send_image(self, chat_id, image_url, caption=None, metadata=None):
        msg = f"[📸]({image_url})"
        if caption:
            msg += f" {caption}"
        return await self.send(chat_id, msg, metadata=metadata)

    async def get_chat_info(self, chat_id):
        return {"name": self._known_agents.get(chat_id, chat_id), "type": "dm", "chat_id": chat_id}

    def format_message(self, content):
        return content


def register(ctx):
    ctx.register_platform(
        name="hivesync",
        label="HiveSync",
        adapter_factory=lambda cfg: HiveSyncAdapter(cfg),
        check_fn=check_requirements,
        validate_config=validate_config,
        is_connected=is_connected,
        required_env=["HIVESYNC_HOME", "HIVESYNC_AGENT_ID"],
        install_hint="Requires Node.js and a running HiveSync daemon",
        setup_fn=interactive_setup,
        env_enablement_fn=_env_enablement,
        cron_deliver_env_var="HIVESYNC_HOME_CHANNEL",
        allowed_users_env="HIVESYNC_ALLOWED_USERS",
        allow_all_env="HIVESYNC_ALLOW_ALL_USERS",
        max_message_length=4096,
        emoji="🐝",
        pii_safe=True,
        allow_update_command=True,
        platform_hint=(
            "You are chatting over HiveSync, a P2P messaging protocol built on "
            "the Waku network. Messages are end-to-end encrypted and delivered "
            "through a local daemon. You can use markdown formatting in your "
            "responses. Each chat is a DM with a specific agent identified by "
            "their agent ID. Messages may be delayed by up to 30 seconds "
            "depending on the polling interval."
        ),
    )