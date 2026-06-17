import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import yaml from 'yaml';
import { loadConfig, saveConfig, validateConfig } from '../../src/utils/config';
import { BridgeConfig } from '../../src/types';

function validConfig(): BridgeConfig {
  return {
    agentId: 'cfg-agent',
    agentName: 'Cfg Agent',
    storagePath: '/tmp/cfg.db',
    syncInterval: 30,
    waku: {
      listenAddresses: [],
      bootstrapNodes: [],
      clusterId: 1,
      numShardsInCluster: 8,
      contentTopic: '/hivesync/1/agents/proto',
      keepAlive: false,
      maxPeers: 1,
    },
  };
}

describe('config', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-config-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('round-trips through YAML', async () => {
    const p = path.join(dir, 'config.yaml');
    fs.writeFileSync(p, yaml.stringify(validConfig()), 'utf-8');
    const loaded = await loadConfig(p);
    expect(loaded.agentId).toBe('cfg-agent');
    expect(loaded.waku.contentTopic).toBe('/hivesync/1/agents/proto');
  });

  test('falls back to defaults for a missing file', async () => {
    const cfg = await loadConfig(path.join(dir, 'nope.yaml'));
    expect(cfg.agentId).toBeDefined();
    expect(cfg.waku.clusterId).toBe(1);
  });

  test('handles invalid YAML gracefully', async () => {
    const p = path.join(dir, 'bad.yaml');
    fs.writeFileSync(p, 'invalid: yaml: [', 'utf-8');
    const cfg = await loadConfig(p);
    expect(cfg).toBeDefined();
  });

  test('saveConfig writes a readable file', async () => {
    const p = path.join(dir, 'out.yaml');
    await saveConfig(validConfig(), p);
    expect(fs.existsSync(p)).toBe(true);
    expect(yaml.parse(fs.readFileSync(p, 'utf-8')).agentId).toBe('cfg-agent');
  });

  describe('validateConfig', () => {
    test('accepts a valid config', () => {
      expect(validateConfig(validConfig())).toHaveLength(0);
    });

    test('reports each missing field', () => {
      const bad: BridgeConfig = {
        agentId: '',
        agentName: '',
        storagePath: '',
        syncInterval: -1,
        waku: {
          listenAddresses: [],
          bootstrapNodes: [],
          clusterId: undefined as any,
          numShardsInCluster: 8,
          contentTopic: 'not-a-topic',
          keepAlive: false,
          maxPeers: 0,
        },
      };
      const errors = validateConfig(bad);
      expect(errors).toContain('Agent ID is required');
      expect(errors).toContain('Agent name is required');
      expect(errors).toContain('Storage path is required');
      expect(errors).toContain('Sync interval must be positive');
      expect(errors.some((e) => e.includes('content topic'))).toBe(true);
      expect(errors.some((e) => e.includes('clusterId'))).toBe(true);
    });
  });
});
