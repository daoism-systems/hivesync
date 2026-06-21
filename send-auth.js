/**
 * Send an authenticated message to claw — waits for Waku discovery first.
 * Usage: node send-auth.js <recipient> <password> <message>
 */
const recipient = process.argv[2];
const password = process.argv[3];
const message = process.argv[4];

if (!recipient || !password || !message) {
  console.error('Usage: node send-auth.js <recipient> <password> <message>');
  process.exit(1);
}

async function main() {
  const { loadConfig } = require('./dist/utils/config');
  const { BridgeManager } = require('./dist/core/bridge-manager');

  const config = await loadConfig();
  const bridge = new BridgeManager(config);

  // Start with longer peer wait for discovery
  await bridge.start(60000);

  // Set the password for this recipient
  bridge.setAgentPassword(recipient, password);
  console.log(`Password set for ${recipient}, waiting for discovery...`);

  // Poll for agent discovery: wait until recipient is known with enc key
  for (let i = 0; i < 20; i++) {
    const matches = bridge.getKnownAgents().filter(a => a.id === recipient && !!a.encPublicKey);
    if (matches.length > 0) {
      console.log(`Discovered ${recipient} with encryption key`);
      break;
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  // Send the message
  const msgId = await bridge.sendTextMessage(recipient, message);
  console.log(`Message sent! ID: ${msgId}`);

  // Give ACK a moment
  await new Promise(r => setTimeout(r, 3000));

  await bridge.stop();
  console.log('Done.');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});