/**
 * Smoke-test the HiveSync MCP server end to end, without needing a GUI MCP
 * client. Spawns `node dist/cli.js mcp`, speaks JSON-RPC over stdio, and checks:
 *   1. stdout is PURE JSON-RPC (no banner / log leakage — that corrupts MCP)
 *   2. initialize succeeds
 *   3. tools/list returns the expected tools
 *   4. health returns status
 *   5. (optional) if a recipient agent id is passed, waits for the node to
 *      connect, then send_message to it.
 *
 * Usage:
 *   node scripts/mcp-smoke.js                 # local checks (no network send)
 *   node scripts/mcp-smoke.js <recipientId>   # also send a test message
 *
 * Requires `npm run build` first.
 */
const { spawn } = require('child_process');
const path = require('path');

const recipient = process.argv[2];
const root = path.join(__dirname, '..');
const child = spawn('node', ['dist/cli.js', 'mcp'], { cwd: root });

let stdout = '';
const responses = new Map(); // id -> result
let badLines = 0;
let nextId = 1;
const pending = new Map();

child.stdout.on('data', (chunk) => {
  stdout += chunk.toString();
  let idx;
  while ((idx = stdout.indexOf('\n')) >= 0) {
    const line = stdout.slice(0, idx).trim();
    stdout = stdout.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null) {
        responses.set(msg.id, msg);
        const r = pending.get(msg.id);
        if (r) { pending.delete(msg.id); r(msg); }
      }
    } catch {
      badLines++;
      console.error('  ⚠️  NON-JSON on stdout (would corrupt MCP):', line.slice(0, 100));
    }
  }
});
child.stderr.on('data', () => {}); // logs live here; ignore

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
  });
}
function notify(method) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (m) => (m.result && m.result.content && m.result.content[0] && m.result.content[0].text) || '';

(async () => {
  let fail = 0;
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mcp-smoke', version: '1.0' },
  });
  notify('notifications/initialized');
  console.log(init.result ? `✓ initialize — server ${JSON.stringify(init.result.serverInfo)}` : (fail++, '✗ initialize failed'));

  const tools = await rpc('tools/list');
  const names = (tools.result && tools.result.tools || []).map((t) => t.name);
  const expected = ['health', 'list_contacts', 'send_message', 'broadcast', 'read_conversation', 'get_unread', 'approve_handshake', 'deny_handshake', 'list_quarantine'];
  const missing = expected.filter((e) => !names.includes(e));
  console.log(missing.length ? (fail++, `✗ tools/list missing: ${missing.join(', ')}`) : `✓ tools/list — ${names.length} tools: ${names.join(', ')}`);

  const health = await rpc('tools/call', { name: 'health', arguments: {} });
  console.log(health.result ? `✓ health → ${textOf(health).replace(/\s+/g, ' ').slice(0, 160)}` : (fail++, '✗ health failed'));

  if (recipient) {
    process.stdout.write(`… waiting for node to connect (up to 40s) before sending to ${recipient}\n`);
    let connected = false;
    for (let i = 0; i < 40 && !connected; i++) {
      const h = await rpc('tools/call', { name: 'health', arguments: {} });
      connected = /"connected":\s*true/.test(textOf(h)) && /"peers":\s*[1-9]/.test(textOf(h));
      if (!connected) await sleep(1000);
    }
    if (!connected) { console.log('✗ never connected (0 peers) — cannot test send'); fail++; }
    else {
      const sent = await rpc('tools/call', { name: 'send_message', arguments: { agent_id: recipient, text: `MCP smoke test from ${process.env.USER || 'node'} @ ${new Date().toISOString()}` } });
      console.log(sent.result ? `✓ send_message → ${textOf(sent)}` : (fail++, '✗ send_message failed'));
    }
  }

  console.log(badLines ? (fail++, `✗ ${badLines} non-JSON line(s) leaked onto stdout`) : '✓ stdout clean (pure JSON-RPC)');
  console.log(fail ? `\nRESULT: ${fail} check(s) FAILED` : '\nRESULT: ALL CHECKS PASSED ✅');
  child.kill('SIGKILL');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('smoke error:', e); child.kill('SIGKILL'); process.exit(2); });
