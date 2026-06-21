#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as crypto from 'crypto';
import sqlite3 from 'sqlite3';
import { BridgeManager } from './core/bridge-manager';
import { setupInteractiveMode } from './utils/interactive';
import { startTui } from './utils/tui';
import { loadConfig } from './utils/config';
import { logger } from './utils/logger';
import { runSetupWizard } from './setup-wizard';
import { printBanner } from './utils/ascii';
import { runConnectSequence } from './utils/splash';

const program = new Command();

// The interactive TUI paints its own "connecting to the hivemind" splash, so
// only show the static banner for the plain/utility commands.
const isInteractiveStart =
  process.argv[2] === 'start' &&
  process.stdout.isTTY &&
  !process.argv.includes('--plain') &&
  !process.argv.includes('-d') &&
  !process.argv.includes('--daemon');
if (!isInteractiveStart) {
  printBanner();
}

program
  .name('hivesync')
  .description('Real-time secure HiveSync communication bridge for AI agents')
  .version('2.0.0');

program
  .command('start')
  .description('Start the HiveSync bridge with real-time sync')
  .option('-c, --config <path>', 'Configuration file path', './config/hivesync.yaml')
  .option('-d, --daemon', 'Run as daemon in background')
  .option('-v, --verbose', 'Enable verbose logging')
  .option('-p, --plain', 'Use the plain line-based REPL instead of the messaging UI')
  .option('--no-sync', 'Disable real-time Obsidian sync')
  .action(async (options) => {
    try {
      const config = await loadConfig(options.config);

      // Override sync if disabled via CLI
      if (options.sync === false) {
        config.syncInterval = 0;
      }

      const bridge = new BridgeManager(config);
      const interactive = !options.daemon && !options.plain && process.stdout.isTTY;

      if (interactive) {
        // Telegram-style messaging UI, preceded by the connect-to-hivemind
        // splash (which performs the real bridge.start() under the animation).
        await runConnectSequence(bridge, config);
        await startTui(bridge);
        return;
      }

      logger.info('Starting HiveSync Bridge with real-time sync...');
      const started = await bridge.start();
      if (!started) {
        logger.error('Failed to start bridge');
        process.exit(1);
      }
      logger.success(`Bridge started successfully! Agent ID: ${config.agentId}`);

      if (options.daemon) {
        logger.info('Running in daemon mode...');
        // Keep process alive
        process.on('SIGINT', async () => {
          logger.info('Shutting down...');
          await bridge.stop();
          process.exit(0);
        });
      } else {
        // Scriptable line-based REPL (also used by non-TTY / piped sessions).
        await setupInteractiveMode(bridge);
      }
    } catch (error) {
      logger.error('Failed to start bridge:', error);
      process.exit(1);
    }
  });

program
  .command('setup')
  .description('Run setup wizard for initial configuration')
  .action(async () => {
    await runSetupWizard();
  });

program
  .command('status')
  .description('Check bridge and sync status')
  .action(async () => {
    try {
      const config = await loadConfig();
      const bridge = new BridgeManager(config);
      await bridge.start();
      
      const status = await bridge.getStatus();
      const syncStatus = await bridge.getSyncStatus();
      
      console.log(chalk.cyan('\n=== Bridge Status ===\n'));
      console.log(chalk.white(`Agent: ${status.agentName} (${status.agentId})`));
      console.log(chalk.white(`Running: ${status.running ? '✅' : '❌'}`));
      console.log(chalk.white(`HiveSync Connected: ${status.hivesync.connected ? '✅' : '❌'}`));
      console.log(chalk.white(`Peers: ${status.hivesync.peers}`));
      console.log(chalk.white(`Real-time Sync: ${status.realTimeSync ? '✅' : '❌'}`));
      console.log(chalk.white(`File Watching: ${status.fileWatching ? '✅' : '❌'}`));
      
      if (syncStatus.length > 0) {
        console.log(chalk.cyan('\n=== Sync Status ===\n'));
        syncStatus.forEach((state: any, index: number) => {
          console.log(chalk.white(`${index + 1}. Agent: ${state.agentId}`));
          console.log(chalk.gray(`   Last Sync: ${state.lastSync.toLocaleString()}`));
          console.log(chalk.gray(`   Notes Synced: ${state.notesSynced}`));
          console.log(chalk.gray(`   Conflicts: ${state.conflicts}`));
          console.log();
        });
      }
      
      await bridge.stop();
    } catch (error) {
      logger.error('Failed to get status:', error);
    }
  });

program
  .command('send <recipient> <message>')
  .description('Send a message to another agent')
  .option('-p, --password <password>', 'Access password of the recipient (for trusted/encrypted delivery)')
  .action(async (recipient, message, options) => {
    try {
      const config = await loadConfig();
      const bridge = new BridgeManager(config);
      await bridge.start();

      if (options.password) {
        bridge.setAgentPassword(recipient, options.password);
      }

      const msgId = await bridge.sendTextMessage(recipient, message);
      logger.success(`Message sent! ID: ${msgId}`);

      await bridge.stop();
    } catch (error) {
      logger.error('Failed to send message:', error);
    }
  });

program
  .command('sync')
  .description('Trigger manual sync with all agents')
  .action(async () => {
    try {
      const config = await loadConfig();
      const bridge = new BridgeManager(config);
      await bridge.start();
      
      await bridge.triggerSync();
      logger.success('Manual sync triggered with all agents');
      
      await bridge.stop();
    } catch (error) {
      logger.error('Failed to sync:', error);
    }
  });

program
  .command('sync-status')
  .description('Show detailed sync status')
  .action(async () => {
    try {
      const config = await loadConfig();
      const bridge = new BridgeManager(config);
      await bridge.start();
      
      const syncStatus = await bridge.getSyncStatus();
      
      if (syncStatus.length === 0) {
        console.log(chalk.yellow('No sync status available'));
      } else {
        console.log(chalk.cyan('\n=== Sync Status ===\n'));
        syncStatus.forEach((state: any, index: number) => {
          console.log(chalk.white(`${index + 1}. Agent: ${state.agentId}`));
          console.log(chalk.gray(`   Last Sync: ${state.lastSync.toLocaleString()}`));
          console.log(chalk.gray(`   Notes Synced: ${state.notesSynced}`));
          console.log(chalk.gray(`   Conflicts: ${state.conflicts}`));
          const timeSince = Date.now() - state.lastSync.getTime();
          const minutes = Math.floor(timeSince / 60000);
          if (minutes < 5) {
            console.log(chalk.green(`   Status: Synced ${minutes} minute${minutes === 1 ? '' : 's'} ago`));
          } else if (minutes < 60) {
            console.log(chalk.yellow(`   Status: ${minutes} minutes since last sync`));
          } else {
            console.log(chalk.red(`   Status: ${Math.floor(minutes / 60)} hours since last sync`));
          }
          console.log();
        });
      }
      
      await bridge.stop();
    } catch (error) {
      logger.error('Failed to get sync status:', error);
    }
  });

program
  .command('agents')
  .description('List known agents')
  .action(async () => {
    try {
      const config = await loadConfig();
      const bridge = new BridgeManager(config);
      await bridge.start();

      console.log(chalk.cyan('\n=== Discovering agents (listening 8s) ===\n'));
      await new Promise((r) => setTimeout(r, 8000));

      const agents = bridge.getKnownAgents();
      if (agents.length === 0) {
        console.log(chalk.yellow('No other agents discovered yet.'));
      } else {
        agents.forEach((a, i) => {
          console.log(chalk.white(`${i + 1}. ${a.name} (${a.id})`));
          console.log(chalk.gray(`   key: ${a.keyId}`));
          console.log(chalk.gray(`   last seen: ${a.lastSeen?.toLocaleString() ?? 'n/a'}`));
        });
      }

      await bridge.stop();
    } catch (error) {
      logger.error('Failed to list agents:', error);
    }
  });

program
  .command('handshake <agentId>')
  .description('Initiate a handshake (capability + trust negotiation) with an agent')
  .action(async (agentId) => {
    try {
      const config = await loadConfig();
      const bridge = new BridgeManager(config);
      await bridge.start();

      console.log(chalk.cyan(`\n=== Handshake with ${agentId} ===\n`));
      console.log(chalk.gray('Waiting for the agent to be discovered...'));
      const found = await bridge.waitForAgent(agentId, 15000);
      if (!found) {
        console.log(chalk.red('Agent not discovered on the network.'));
        await bridge.stop();
        return;
      }

      await bridge.initiateHandshake(agentId);
      console.log(chalk.gray('Handshake initiated, waiting for acknowledgement...'));
      const confirmed = await bridge.handshakeWait(agentId, 10000);

      const info = bridge.getHandshakeStatus(agentId);
      if (confirmed) {
        console.log(chalk.green(`✅ Handshake confirmed with ${info?.agentName ?? agentId}`));
        console.log(chalk.white(`   capabilities: ${(info?.capabilities ?? []).join(', ') || 'none'}`));
      } else {
        console.log(chalk.yellow(`⏳ Handshake not confirmed (status: ${info?.status ?? 'unknown'})`));
      }

      await bridge.stop();
    } catch (error) {
      logger.error('Failed to handshake:', error);
    }
  });

program
  .command('contacts')
  .description('List confirmed contacts (agents with a completed handshake)')
  .action(async () => {
    try {
      const config = await loadConfig();
      const bridge = new BridgeManager(config);
      await bridge.start();

      const contacts = await bridge.getContacts();
      console.log(chalk.cyan(`\n=== Contacts (${contacts.length}) ===\n`));
      if (contacts.length === 0) {
        console.log(chalk.yellow('No confirmed contacts yet.'));
      } else {
        contacts.forEach((c, i) => {
          console.log(chalk.white(`${i + 1}. ${c.name} (${c.id})`));
          console.log(chalk.gray(`   capabilities: ${c.capabilities.join(', ') || 'none'}`));
          console.log(chalk.gray(`   confirmed: ${c.handshakeConfirmedAt?.toLocaleString() ?? 'n/a'}`));
        });
      }

      await bridge.stop();
    } catch (error) {
      logger.error('Failed to list contacts:', error);
    }
  });

program
  .command('contact <agentId>')
  .description('Show handshake and capability details for one agent')
  .action(async (agentId) => {
    try {
      const config = await loadConfig();
      const bridge = new BridgeManager(config);
      await bridge.start();

      const contact = await bridge.getContact(agentId);
      console.log(chalk.cyan(`\n=== Contact ${agentId} ===\n`));
      if (!contact) {
        console.log(chalk.yellow('Unknown agent (never discovered).'));
      } else {
        console.log(chalk.white(`Name: ${contact.name}`));
        console.log(chalk.white(`Handshake: ${contact.handshakeStatus}`));
        console.log(chalk.white(`Capabilities: ${contact.capabilities.join(', ') || 'none'}`));
        console.log(chalk.gray(`Confirmed: ${contact.handshakeConfirmedAt?.toLocaleString() ?? 'n/a'}`));
        console.log(chalk.gray(`Last seen: ${contact.lastSeen?.toLocaleString() ?? 'n/a'}`));
      }

      await bridge.stop();
    } catch (error) {
      logger.error('Failed to read contact:', error);
    }
  });

program
  .command('quarantine')
  .description('List untrusted (quarantined) messages — never executed')
  .action(async () => {
    try {
      const config = await loadConfig();
      const bridge = new BridgeManager(config);
      const items = await bridge.getQuarantine();
      console.log(chalk.cyan(`\n=== Quarantine (${items.length}) ===`));
      console.log(chalk.gray(`folder: ${bridge.getQuarantineDir()}\n`));
      if (items.length === 0) {
        console.log(chalk.green('No quarantined messages.'));
      } else {
        items.forEach((q, i) => {
          const text = q.content && typeof q.content.text === 'string' ? q.content.text : JSON.stringify(q.content);
          console.log(chalk.white(`${i + 1}. from ${q.sender}  ${new Date(q.timestamp).toLocaleString()}`));
          console.log(chalk.red(`   reason: ${q.reason}`));
          console.log(chalk.gray(`   ${text}\n`));
        });
      }
    } catch (error) {
      logger.error('Failed to read quarantine:', error);
    }
  });

program
  .command('watch')
  .description('Start file watcher for real-time sync')
  .action(async () => {
    console.log(chalk.cyan('\n=== Starting File Watcher ===\n'));
    console.log(chalk.white('File watcher is automatically started with real-time sync.'));
    console.log(chalk.white('Use "hivesync start" to start the full bridge.'));
  });

program
  .command('test')
  .description('Run connectivity and sync test')
  .action(async () => {
    console.log(chalk.cyan('\n=== Connectivity & Sync Test ===\n'));
    
    // Test HiveSync connectivity
    console.log(chalk.white('1. Testing HiveSync network...'));
    try {
      const config = await loadConfig();
      const bridge = new BridgeManager(config);
      const started = await bridge.start();
      
      if (started) {
        const status = await bridge.getStatus();
        console.log(chalk.green(`   ✅ Connected to HiveSync network`));
        console.log(chalk.white(`   Peer ID: ${status.hivesync.peerId}`));
        console.log(chalk.white(`   Active peers: ${status.hivesync.peers}`));
        console.log(chalk.white(`   Real-time sync: ${status.realTimeSync ? 'Enabled' : 'Disabled'}`));
      } else {
        console.log(chalk.red('   ❌ Failed to connect to HiveSync network'));
      }
      
      await bridge.stop();
    } catch (error) {
      console.log(chalk.red(`   Error: ${(error as Error).message}`));
    }
    
    console.log(chalk.white('\n2. Testing local storage...'));
    try {
      // Test SQLite
      const db = new sqlite3.Database(':memory:');
      db.run('CREATE TABLE test (id INTEGER PRIMARY KEY)');
      db.close();
      console.log(chalk.green('   ✅ Local storage working'));
    } catch (error) {
      console.log(chalk.red(`   Error: ${(error as Error).message}`));
    }

    console.log(chalk.white('\n3. Testing file system monitoring...'));
    try {
      const tempFile = '/tmp/hivesync-test.txt';
      fs.writeFileSync(tempFile, 'test');
      fs.readFileSync(tempFile, 'utf-8');
      fs.unlinkSync(tempFile);
      console.log(chalk.green('   ✅ File system access working'));
    } catch (error) {
      console.log(chalk.red(`   Error: ${(error as Error).message}`));
    }

    console.log(chalk.white('\n4. Testing encryption...'));
    try {
      crypto.generateKeyPairSync('ed25519');
      console.log(chalk.green('   ✅ Encryption working'));
    } catch (error) {
      console.log(chalk.red(`   Error: ${(error as Error).message}`));
    }
    
    console.log(chalk.cyan('\n=== Test Complete ===\n'));
  });

program.parse(process.argv);

// Show help if no arguments
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
