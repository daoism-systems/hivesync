import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import yaml from 'yaml';
import { BridgeConfig } from './types';
import { logger } from './utils/logger';

export async function runSetupWizard(): Promise<void> {
  console.log(chalk.cyan('\n=== HiveSync Setup Wizard ===\n'));
  console.log(chalk.gray('This wizard will help you configure HiveSync with real-time Obsidian sync.\n'));

  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'agentName',
      message: 'What is your agent name?',
      default: 'My Agent',
    },
    {
      type: 'input',
      name: 'agentId',
      message: 'Agent ID (leave blank to generate):',
      default: `agent-${uuidv4().substring(0, 8)}`,
    },
    {
      type: 'input',
      name: 'storagePath',
      message: 'Where should data be stored?',
      default: path.join(process.cwd(), 'data', 'hivesync.db'),
    },
    {
      type: 'confirm',
      name: 'enableRealtimeSync',
      message: 'Enable real-time Obsidian vault sync?',
      default: true,
    },
    {
      type: 'input',
      name: 'obsidianPath',
      message: 'Path to your Obsidian vault:',
      when: (answers) => answers.enableRealtimeSync,
      default: path.join(process.cwd(), 'obsidian-vault'),
      validate: (input: string) => {
        if (!input.trim()) {
          return 'Obsidian vault path is required';
        }
        return true;
      },
    },
    {
      type: 'confirm',
      name: 'createVaultIfMissing',
      message: 'Create Obsidian vault if it doesn\'t exist?',
      when: (answers) => answers.enableRealtimeSync,
      default: true,
    },
    {
      type: 'number',
      name: 'syncDebounceDelay',
      message: 'Sync debounce delay (milliseconds):',
      when: (answers) => answers.enableRealtimeSync,
      default: 1000,
      validate: (input: number) => {
        if (input < 100) {
          return 'Delay must be at least 100ms';
        }
        if (input > 10000) {
          return 'Delay must be at most 10000ms';
        }
        return true;
      },
    },
    {
      type: 'confirm',
      name: 'useCustomNodes',
      message: 'Use custom Waku bootstrap nodes?',
      default: false,
    },
    {
      type: 'editor',
      name: 'customNodes',
      message: 'Enter custom bootstrap nodes (one per line):',
      when: (answers) => answers.useCustomNodes,
      default: `/dns4/node-01.do-ams3.wakuv2.test.status.im/tcp/443/wss/p2p/16Uiu2HAmPLe7Mzm8TsYUubgCAW1aJoeFScxrLj8ppHFivPo97bUZ
/dns4/node-01.gc-us-central1-a.wakuv2.test.status.im/tcp/443/wss/p2p/16Uiu2HAmJb2e28qLXxT5kZxVUUoJt72EMzNGXB47Rxx5hw3q4YjS`,
    },
  ]);

  const spinner = ora('Creating configuration...').start();

  try {
    // Create config object
    const config: BridgeConfig = {
      agentId: answers.agentId,
      agentName: answers.agentName,
      storagePath: answers.storagePath,
      syncInterval: 30, // presence announce interval (seconds)
      waku: {
        listenAddresses: ['/ip4/0.0.0.0/tcp/0/ws'],
        bootstrapNodes: answers.useCustomNodes
          ? answers.customNodes.split('\n').filter((n: string) => n.trim())
          : [],
        directPeers: [],
        clusterId: 1,
        numShardsInCluster: 8,
        contentTopic: '/hivesync/1/agents/proto',
        keepAlive: true,
        maxPeers: 10,
      },
    };

    // Add Obsidian configuration if enabled
    if (answers.enableRealtimeSync) {
      config.obsidian = {
        vaultPath: answers.obsidianPath,
        enabled: true,
      };
    }

    // Create directories
    const configDir = path.join(process.cwd(), 'config');
    const dataDir = path.dirname(answers.storagePath);
    
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Save config
    const configPath = path.join(configDir, 'hivesync.yaml');
    const yamlStr = yaml.stringify(config);

    fs.writeFileSync(configPath, yamlStr, 'utf-8');

    // Create .env file if needed
    const envPath = path.join(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) {
      const envContent = `# HiveSync Configuration
AGENT_ID=${answers.agentId}
AGENT_NAME="${answers.agentName}"
STORAGE_PATH=${answers.storagePath}
OBSIDIAN_PATH=${answers.enableRealtimeSync ? answers.obsidianPath : ''}
SYNC_DEBOUNCE_DELAY=${answers.enableRealtimeSync ? answers.syncDebounceDelay : 1000}
LOG_LEVEL=info
`;
      fs.writeFileSync(envPath, envContent, 'utf-8');
    }

    // Create Obsidian vault if enabled and doesn't exist
    if (answers.enableRealtimeSync && answers.createVaultIfMissing && !fs.existsSync(answers.obsidianPath)) {
      fs.mkdirSync(answers.obsidianPath, { recursive: true });
      
      // Create .obsidian directory with basic config
      const obsidianDir = path.join(answers.obsidianPath, '.obsidian');
      fs.mkdirSync(obsidianDir, { recursive: true });
      
      // Create basic Obsidian config
      const obsidianConfig = {
        "attachmentFolderPath": "./attachments",
        "useMarkdownLinks": true,
        "newLinkFormat": "relative",
        "showUnsupportedFiles": true,
        "strictLineBreaks": false,
        "readableLineLength": true,
        "showLineNumber": false,
        "showIndentGuide": true,
        "trashOption": "local",
        "alwaysUpdateLinks": true,
        "newFileLocation": "current",
        "showFrontmatter": true,
        "livePreview": true
      };
      
      fs.writeFileSync(
        path.join(obsidianDir, 'app.json'),
        JSON.stringify(obsidianConfig, null, 2),
        'utf-8'
      );
      
      // Create a sample note
      const sampleNote = `# Welcome to HiveSync Obsidian

This vault is automatically synchronized with your other agents using HiveSync.

## Features
- **Real-time synchronization**: Changes are synced immediately
- **End-to-end encryption**: All data is encrypted in transit
- **Conflict resolution**: Automatic handling of merge conflicts
- **Version history**: Track changes over time

## Getting Started
1. Add more notes to this vault
2. Connect another agent with HiveSync
3. Watch changes sync automatically in real-time!

## Tips
- Use \`.trash/\` folder for notes you want to delete
- The \`.obsidian/\` folder contains app settings
- All \`.md\` files are automatically synced

## Support
For help, visit: https://github.com/clawbotl37/hivesync`;
      
      fs.writeFileSync(
        path.join(answers.obsidianPath, 'Welcome to HiveSync.md'),
        sampleNote,
        'utf-8'
      );
    }

    spinner.succeed('Configuration created successfully!');

    console.log(chalk.green('\n=== Setup Complete ===\n'));
    console.log(chalk.white(`Configuration saved to: ${configPath}`));
    console.log(chalk.white(`Agent ID: ${answers.agentId}`));
    console.log(chalk.white(`Agent Name: ${answers.agentName}`));
    console.log(chalk.white(`Storage: ${answers.storagePath}`));
    console.log(
      chalk.white('Access control: handshake approval (you approve each new agent before chatting)')
    );

    if (answers.enableRealtimeSync) {
      console.log(chalk.white(`Obsidian Vault: ${answers.obsidianPath}`));
      console.log(chalk.white(`Real-time Sync: Enabled`));
      console.log(chalk.white(`Sync Debounce: ${answers.syncDebounceDelay}ms`));
      
      if (answers.createVaultIfMissing && !fs.existsSync(answers.obsidianPath)) {
        console.log(chalk.green(`✓ Created Obsidian vault at: ${answers.obsidianPath}`));
      }
    }
    
    console.log(chalk.white(`Waku Nodes: ${config.waku.bootstrapNodes.length}`));
    
    console.log(chalk.cyan('\n=== Next Steps ===\n'));
    console.log(chalk.white('1. Start HiveSync with real-time sync:'));
    console.log(chalk.yellow('   hivesync start\n'));
    
    console.log(chalk.white('2. Check sync status:'));
    console.log(chalk.yellow('   hivesync sync-status\n'));
    
    console.log(chalk.white('3. Test real-time sync:'));
    console.log(chalk.yellow('   Create/edit a note in your Obsidian vault\n'));
    
    console.log(chalk.white('4. Connect another agent:'));
    console.log(chalk.yellow('   Run setup on another machine and use the same Waku topic\n'));
    
    console.log(chalk.white('5. For help:'));
    console.log(chalk.yellow('   hivesync --help\n'));

    // Create setup completion marker
    const setupCompletePath = path.join(process.cwd(), '.setup-complete');
    fs.writeFileSync(setupCompletePath, new Date().toISOString(), 'utf-8');

  } catch (error) {
    spinner.fail('Failed to create configuration');
    logger.error('Setup error:', error);
    process.exit(1);
  }
}
