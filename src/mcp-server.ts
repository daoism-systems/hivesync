/**
 * HiveSync MCP server.
 *
 * Exposes the HiveSync agent as Model Context Protocol tools over stdio, so an
 * MCP client (Claude Code, Claude Desktop) becomes a first-class member of the
 * hive — sending/reading messages and approving handshakes natively, instead of
 * shelling out to the CLI or poking the SQLite DB.
 *
 * Run via `hivesync mcp`. stdout is the JSON-RPC channel, so nothing else may
 * write to it — logs are routed to stderr by the CLI before this is called.
 *
 * `@modelcontextprotocol/sdk` and `zod` are ESM-only; this project builds to
 * CommonJS, so they're loaded with a dynamic `import()` (the same pattern used
 * for `@waku/sdk`).
 */
import { BridgeManager } from './core/bridge-manager';
import type { BridgeConfig, Message } from './types';
import { logger } from './utils/logger';
import { VERSION } from './version';

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const imp = (m: string): Promise<any> => new Function(`return import(${JSON.stringify(m)})`)();

/**
 * Slim, model-friendly projection of a stored message. For our own outbound
 * messages (`self` given) it carries the delivery receipt: the peer's last ACK
 * status, or 'none' — published is not the same as received.
 */
function slim(m: Message, self?: string): Record<string, unknown> {
  const outbound = self !== undefined && m.sender === self && m.recipient !== 'broadcast';
  return {
    id: m.id,
    from: m.sender,
    to: m.recipient,
    text: (m.content as any)?.text ?? m.content,
    at: m.timestamp instanceof Date ? m.timestamp.toISOString() : m.timestamp,
    encrypted: m.encrypted,
    // Automated message: do NOT auto-reply to this (an ACK receipt is fine).
    // Only present when true, to keep the common case uncluttered.
    ...(m.auto ? { auto: true } : {}),
    ...(outbound
      ? {
          receipt: m.ackStatus ?? 'none',
          ...(m.ackedAt ? { receipt_at: m.ackedAt.toISOString() } : {}),
          ...(m.publishedAt ? { published_at: m.publishedAt.toISOString() } : {}),
        }
      : {}),
  };
}

export async function startMcpServer(config: BridgeConfig): Promise<void> {
  const [mcpMod, stdioMod, zodMod] = await Promise.all([
    imp('@modelcontextprotocol/sdk/server/mcp.js'),
    imp('@modelcontextprotocol/sdk/server/stdio.js'),
    imp('zod'),
  ]);
  const { McpServer } = mcpMod;
  const { StdioServerTransport } = stdioMod;
  const z = zodMod.z ?? zodMod.default;

  // Bring the agent online in the BACKGROUND so the MCP server is responsive
  // immediately (the Logos Messaging connect can take ~10-30s; we don't want to stall the
  // client's initialize). Tools that need the live bridge await `ready`; the
  // `health` tool reports current status without blocking, so a client can see
  // "connecting / 0 peers" before it tries to send.
  const bridge = new BridgeManager(config);
  const ready = bridge
    .start()
    .then((ok) => {
      if (!ok) throw new Error('HiveSync bridge failed to start');
    })
    .catch((e) => {
      logger.error('MCP: bridge start error:', e);
      throw e;
    });

  const server = new McpServer({ name: 'hivesync', version: VERSION });
  const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });
  const json = (v: unknown) => text(JSON.stringify(v, null, 2));
  // Wrap handlers that need the bridge connected.
  const ready_ = <A>(fn: (a: A) => Promise<any>) => async (a: A) => {
    await ready;
    return fn(a);
  };

  // --- health: check we're actually connected before sending blind ----------
  server.registerTool(
    'health',
    {
      title: 'HiveSync health / peers',
      description:
        'Connection status of this HiveSync agent: connected, this agent id, libp2p peerId, ' +
        'number of connected Logos Messaging peers, and known-agent count. Call this BEFORE sending so ' +
        'you do not publish into a dead channel (0 peers = not connected yet).',
      inputSchema: {},
    },
    async () => json(await bridge.getStatus())
  );

  // --- contacts --------------------------------------------------------------
  server.registerTool(
    'list_contacts',
    {
      title: 'List contacts',
      description: 'List agents this node knows, with trust/handshake status. Use the returned ids with send_message / read_conversation.',
      inputSchema: {},
    },
    ready_(async () => json(await bridge.getContacts()))
  );

  // --- send ------------------------------------------------------------------
  server.registerTool(
    'send_message',
    {
      title: 'Send a message',
      description:
        'Send a text message to an agent by id. Encrypted end-to-end if the peer is a trusted contact; ' +
        'otherwise sent as signed plaintext (the recipient may quarantine it until it approves the handshake). ' +
        'Set auto:true for automated sends (auto-replies, cron/daemon traffic) — recipients MUST NOT auto-reply ' +
        'to an auto:true message, which prevents infinite reply loops. Leave it false for human-initiated sends. ' +
        'Tip: run health first to confirm you have peers.',
      inputSchema: {
        agent_id: z.string().describe('recipient agent id'),
        text: z.string().describe('message body'),
        auto: z.boolean().optional().describe('mark as an automated message (suppresses the recipient auto-reply)'),
      },
    },
    ready_(async ({ agent_id, text: body, auto }: { agent_id: string; text: string; auto?: boolean }) => {
      const { id, delivered } = await bridge.sendTextMessage(agent_id, body, auto ?? false);
      const trusted = (await bridge.getContacts()).some((c: any) => c.id === agent_id);
      const security = trusted ? 'encrypted to trusted contact' : 'sent as plaintext — peer not a confirmed contact yet';
      if (!delivered) {
        return text(
          `Message ${id} to ${agent_id} QUEUED, not yet on the network (push reached 0 peers; ` +
          `the outbox retries every few seconds). Check health for peer count before assuming delivery.`
        );
      }
      return text(
        `Sent message ${id} to ${agent_id} (${security}${auto ? ', auto' : ''}). ` +
          `Published, not yet confirmed received — check message_status for the peer's receipt.`
      );
    })
  );

  // --- broadcast -------------------------------------------------------------
  server.registerTool(
    'broadcast',
    {
      title: 'Broadcast a message',
      description: 'Broadcast an UNENCRYPTED message to every agent on the content topic. Use for discovery/announcements, not secrets.',
      inputSchema: { text: z.string().describe('message body') },
    },
    ready_(async ({ text: body }: { text: string }) => text(`Broadcast sent (id ${await bridge.broadcastMessage(body)}).`))
  );

  // --- read conversation -----------------------------------------------------
  server.registerTool(
    'read_conversation',
    {
      title: 'Read a conversation',
      description: 'Return the recent message history with one agent (most recent last).',
      inputSchema: {
        agent_id: z.string().describe('the other agent id'),
        limit: z.number().int().positive().max(500).optional().describe('max messages (default 50)'),
      },
    },
    ready_(async ({ agent_id, limit }: { agent_id: string; limit?: number }) => {
      const msgs = await bridge.getConversation(agent_id, limit ?? 50);
      return json(msgs.map((m) => slim(m, config.agentId)));
    })
  );

  // --- delivery receipt for one message --------------------------------------
  server.registerTool(
    'message_status',
    {
      title: 'Delivery status of a message',
      description:
        'Delivery receipt for a message you sent, by id (as returned by send_message). receipt is the ' +
        "peer's last ACK: queued (stored in their inbox), quarantined (held unread: you're not a confirmed " +
        'contact on their side), processed, deferred (busy, retry later), rejected (unknown ' +
        'type / refused), undecryptable (key mismatch: re-handshake), rate_limited — or none (published, ' +
        'but no receipt yet: the peer may be offline or never got it).',
      inputSchema: { message_id: z.string().describe('message id') },
    },
    ready_(async ({ message_id }: { message_id: string }) => {
      const m = await bridge.getMessage(message_id);
      if (!m) return text(`No message ${message_id} in the local store.`);
      return json(slim(m, config.agentId));
    })
  );

  // --- unread ----------------------------------------------------------------
  server.registerTool(
    'get_unread',
    {
      title: 'Get unread messages',
      description: 'Return messages received but not yet read (across all agents). Poll this to see new incoming messages.',
      inputSchema: {},
    },
    ready_(async () => json((await bridge.getUnreadMessages()).map((m) => slim(m))))
  );

  // --- handshake approval ----------------------------------------------------
  server.registerTool(
    'approve_handshake',
    {
      title: 'Approve a handshake',
      description: 'Approve a pending handshake from an agent so its messages become trusted (and decrypt-able / non-quarantined).',
      inputSchema: { agent_id: z.string().describe('agent id to approve') },
    },
    ready_(async ({ agent_id }: { agent_id: string }) => {
      const ok = await bridge.approveHandshake(agent_id);
      return text(ok ? `Approved handshake with ${agent_id}.` : `No pending handshake from ${agent_id} to approve.`);
    })
  );

  server.registerTool(
    'deny_handshake',
    {
      title: 'Deny a handshake',
      description: 'Deny/revoke trust for an agent; its messages will be quarantined.',
      inputSchema: { agent_id: z.string().describe('agent id to deny') },
    },
    ready_(async ({ agent_id }: { agent_id: string }) => {
      const ok = await bridge.denyHandshake(agent_id);
      return text(ok ? `Denied ${agent_id}.` : `Nothing to deny for ${agent_id}.`);
    })
  );

  // --- quarantine ------------------------------------------------------------
  server.registerTool(
    'list_quarantine',
    {
      title: 'List quarantined messages',
      description: 'Messages from un-approved (untrusted) agents, held aside and never executed. Review before approving a handshake.',
      inputSchema: {},
    },
    ready_(async () => json((await bridge.getQuarantine(100)).map((m: any) => slim(m))))
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('HiveSync MCP server ready on stdio (tools: health, list_contacts, send_message, broadcast, read_conversation, get_unread, approve_handshake, deny_handshake, list_quarantine, message_status)');

  const shutdown = async (): Promise<void> => {
    await bridge.stop().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  // The client closing stdio means it's gone (crashed, or killed without
  // signalling us). Without this the node lingers as an orphan still holding
  // our identity, peerId and DB — a duplicate agent racing the next session.
  process.stdin.on('end', () => void shutdown());
  process.stdin.on('close', () => void shutdown());
}
