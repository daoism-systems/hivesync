import * as fs from 'fs';
import * as path from 'path';
import yaml from 'yaml';
import { BridgeConfig } from '../types';
import { logger } from './logger';

const DEFAULT_CONFIG: BridgeConfig = {
  agentId: `agent-${Date.now().toString(36)}`,
  agentName: 'HiveSync Agent',
  storagePath: path.join(process.cwd(), 'data', 'hivesync.db'),
  // Announce/presence interval, in seconds.
  syncInterval: 30,
  waku: {
    listenAddresses: ['/ip4/0.0.0.0/tcp/0/ws'],
    // Empty => use @waku/sdk's default bootstrap (The Waku Network).
    bootstrapNodes: [],
    directPeers: [],
    clusterId: 1,
    numShardsInCluster: 8,
    contentTopic: '/hivesync/1/agents/proto',
    keepAlive: true,
    maxPeers: 10,
  },
};

export async function loadConfig(configPath?: string): Promise<BridgeConfig> {
  const pathsToTry = [
    configPath,
    path.join(process.cwd(), 'config', 'hivesync.yaml'),
    path.join(process.cwd(), 'hivesync.yaml'),
    path.join(process.cwd(), 'config.yaml'),
    path.join(process.cwd(), 'config', 'config.yaml'),
  ].filter(Boolean) as string[];

  for (const tryPath of pathsToTry) {
    if (fs.existsSync(tryPath)) {
      try {
        const content = fs.readFileSync(tryPath, 'utf-8');
        const config = yaml.parse(content) as BridgeConfig;

        // Merge with defaults
        const mergedConfig = {
          ...DEFAULT_CONFIG,
          ...config,
          waku: {
            ...DEFAULT_CONFIG.waku,
            ...config.waku,
          },
        };

        logger.info(`Loaded configuration from: ${tryPath}`);
        // agentId is explicit only if the file actually pinned a non-empty one.
        const explicit = typeof config?.agentId === 'string' && config.agentId.trim() !== '';
        return ensureStableIdentity(mergedConfig, explicit);
      } catch (error) {
        logger.warn(`Failed to load config from ${tryPath}:`, error);
      }
    }
  }

  // Try environment variables
  const envConfig: Partial<BridgeConfig> = {};

  if (process.env.AGENT_ID) envConfig.agentId = process.env.AGENT_ID;
  if (process.env.AGENT_NAME) envConfig.agentName = process.env.AGENT_NAME;
  if (process.env.STORAGE_PATH) envConfig.storagePath = process.env.STORAGE_PATH;
  if (process.env.SYNC_INTERVAL) envConfig.syncInterval = parseInt(process.env.SYNC_INTERVAL);

  if (Object.keys(envConfig).length > 0) {
    logger.info('Loaded configuration from environment variables');
    return ensureStableIdentity(
      { ...DEFAULT_CONFIG, ...envConfig },
      !!process.env.AGENT_ID
    );
  }

  logger.warn('No configuration file found, using defaults');
  return ensureStableIdentity({ ...DEFAULT_CONFIG }, false);
}

/**
 * Pin an agent's identity so it survives restarts.
 *
 * When the operator doesn't pin an `agentId`, the default is a fresh random
 * `agent-<rand>` generated every process start. That id is the file key for the
 * agent's signing keys (`identity-<agentId>.json`), so a changing id means a new
 * signing key — hence a new `keyId` fingerprint — on every restart. Peers TOFU-
 * pin that keyId, so the rotation breaks their trust pin and forces a fresh
 * handshake each time; in the meantime messages are quarantined and show up as
 * `delivered=0`. To avoid that we persist the generated id once (under the
 * storage dir) and reuse it on subsequent starts.
 *
 * We also default `waku.peerKeyPath` so the libp2p peerId is likewise stable
 * across restarts (generated once, reloaded) — better connection reuse and a
 * consistent presence on the fleet.
 */
function ensureStableIdentity(config: BridgeConfig, agentIdExplicit: boolean): BridgeConfig {
  const storageDir = path.dirname(path.resolve(config.storagePath));

  if (!agentIdExplicit) {
    try {
      if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });
      const idFile = path.join(storageDir, 'agent-id');
      if (fs.existsSync(idFile)) {
        const saved = fs.readFileSync(idFile, 'utf-8').trim();
        if (saved) config.agentId = saved;
      } else {
        fs.writeFileSync(idFile, config.agentId, { mode: 0o600 });
        logger.info(
          `Persisted auto-generated agentId "${config.agentId}" to ${idFile} (stable across restarts)`
        );
      }
    } catch (error) {
      logger.warn('Could not persist a stable agentId; identity may rotate on restart:', error);
    }
  }

  if (!config.waku.peerKeyPath) {
    config.waku.peerKeyPath = path.join(storageDir, 'peer.key');
  }

  if (!config.waku.peerCachePath) {
    config.waku.peerCachePath = path.join(storageDir, 'known-peers.json');
  }

  return config;
}

export async function saveConfig(config: BridgeConfig, configPath?: string): Promise<void> {
  const savePath = configPath || path.join(process.cwd(), 'config', 'hivesync.yaml');
  
  // Ensure directory exists
  const dir = path.dirname(savePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  const yamlStr = yaml.stringify(config);
  fs.writeFileSync(savePath, yamlStr, 'utf-8');
  
  logger.info(`Configuration saved to: ${savePath}`);
}

export function validateConfig(config: BridgeConfig): string[] {
  const errors: string[] = [];
  
  if (!config.agentId || config.agentId.trim() === '') {
    errors.push('Agent ID is required');
  }
  
  if (!config.agentName || config.agentName.trim() === '') {
    errors.push('Agent name is required');
  }
  
  if (!config.storagePath || config.storagePath.trim() === '') {
    errors.push('Storage path is required');
  }
  
  if (config.syncInterval < 0) {
    errors.push('Sync interval must be positive');
  }

  // A Waku content topic must look like /{app}/{version}/{topic}/{encoding}.
  if (!config.waku?.contentTopic || !/^\/[^/]+\/[^/]+\/[^/]+\/[^/]+$/.test(config.waku.contentTopic)) {
    errors.push('A valid Waku content topic (/{app}/{version}/{topic}/{encoding}) is required');
  }

  if (!config.waku?.clusterId && config.waku?.clusterId !== 0) {
    errors.push('Waku clusterId is required');
  }

  return errors;
}

export function getDefaultConfigPath(): string {
  return path.join(process.cwd(), 'config', 'hivesync.yaml');
}
