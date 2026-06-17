import readline from 'readline';
import chalk from 'chalk';
import { BridgeManager } from '../core/bridge-manager';

export async function setupInteractiveMode(bridge: BridgeManager): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(chalk.cyan('\n=== Interactive Mode ===\n'));
  console.log(chalk.white('Type "help" for available commands\n'));

  rl.on('line', async (input) => {
    const [command, ...args] = input.trim().split(' ');

    switch (command.toLowerCase()) {
      case 'help':
        showHelp();
        break;

      case 'status': {
        const status = await bridge.getStatus();
        console.log(chalk.cyan('\n=== Bridge Status ===\n'));
        console.log(chalk.white(`Agent: ${status.agentName} (${status.agentId})`));
        console.log(chalk.white(`Running: ${status.running ? 'yes' : 'no'}`));
        console.log(chalk.white(`Waku Connected: ${status.hivesync.connected ? 'yes' : 'no'}`));
        console.log(chalk.white(`Peer ID: ${status.hivesync.peerId || 'N/A'}`));
        console.log(chalk.white(`Active peers: ${status.hivesync.peers}`));
        console.log(chalk.white(`Known agents: ${status.hivesync.knownAgents}`));
        console.log(chalk.white(`Real-time Sync: ${status.realTimeSync ? 'yes' : 'no'}`));
        console.log(chalk.white(`File Watching: ${status.fileWatching ? 'yes' : 'no'}`));
        break;
      }

      case 'send': {
        if (args.length < 2) {
          console.log(chalk.red('Usage: send <recipient> <message>'));
          break;
        }
        const recipient = args[0];
        const message = args.slice(1).join(' ');
        try {
          const msgId = await bridge.sendTextMessage(recipient, message);
          console.log(chalk.green(`✓ Message sent! ID: ${msgId}`));
        } catch (error) {
          console.log(chalk.red(`✗ Failed to send message: ${(error as Error).message}`));
        }
        break;
      }

      case 'broadcast': {
        if (args.length === 0) {
          console.log(chalk.red('Usage: broadcast <message>'));
          break;
        }
        const broadcastMsg = args.join(' ');
        try {
          const msgId = await bridge.broadcastMessage(broadcastMsg);
          console.log(chalk.green(`✓ Broadcast sent! ID: ${msgId}`));
        } catch (error) {
          console.log(chalk.red(`✗ Failed to broadcast: ${(error as Error).message}`));
        }
        break;
      }

      case 'messages':
        try {
          const messages = await bridge.getUnreadMessages();
          if (messages.length === 0) {
            console.log(chalk.yellow('No unread messages'));
          } else {
            console.log(chalk.cyan(`\n=== Unread Messages (${messages.length}) ===\n`));
            messages.forEach((msg, i) => {
              console.log(chalk.white(`${i + 1}. From: ${msg.sender}`));
              console.log(chalk.gray(`   Type: ${msg.type}`));
              console.log(chalk.gray(`   Time: ${msg.timestamp.toLocaleString()}`));
              if (msg.type === 'text') {
                console.log(chalk.white(`   Content: ${msg.content.text}`));
              }
              console.log();
            });
          }
        } catch (error) {
          console.log(chalk.red(`✗ Failed to get messages: ${(error as Error).message}`));
        }
        break;

      case 'agents': {
        const agents = bridge.getKnownAgents();
        if (agents.length === 0) {
          console.log(chalk.yellow('No agents discovered yet.'));
        } else {
          console.log(chalk.cyan(`\n=== Known Agents (${agents.length}) ===\n`));
          agents.forEach((a, i) => {
            console.log(chalk.white(`${i + 1}. ${a.name} (${a.id})  key:${a.keyId}`));
          });
        }
        break;
      }

      case 'sync':
        try {
          await bridge.sendCommand('broadcast', 'sync');
          console.log(chalk.green('✓ Sync command sent to all agents'));
        } catch (error) {
          console.log(chalk.red(`✗ Failed to sync: ${(error as Error).message}`));
        }
        break;

      case 'clear':
        console.clear();
        console.log(chalk.cyan('=== Waku Bridge ===\n'));
        break;

      case 'exit':
      case 'quit':
        console.log(chalk.yellow('\nShutting down...'));
        await bridge.stop();
        rl.close();
        process.exit(0);
        break;

      default:
        console.log(chalk.red(`Unknown command: ${command}`));
        console.log(chalk.white('Type "help" for available commands'));
    }

    rl.prompt();
  });

  rl.setPrompt(chalk.blue('waku> '));
  rl.prompt();

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log(chalk.yellow('\n\nShutting down...'));
    await bridge.stop();
    rl.close();
    process.exit(0);
  });
}

function showHelp(): void {
  console.log(chalk.cyan('\n=== Available Commands ===\n'));
  console.log(chalk.white('help                    - Show this help'));
  console.log(chalk.white('status                  - Show bridge status'));
  console.log(chalk.white('send <recipient> <msg>  - Send a text message'));
  console.log(chalk.white('broadcast <msg>         - Broadcast to all agents'));
  console.log(chalk.white('agents                  - List discovered agents'));
  console.log(chalk.white('messages                - Show unread messages'));
  console.log(chalk.white('sync                    - Initiate manual sync'));
  console.log(chalk.white('clear                   - Clear screen'));
  console.log(chalk.white('exit/quit              - Exit the bridge'));
  console.log();
}
