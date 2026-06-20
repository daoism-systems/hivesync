# HiveSync Setup Guide

## Prerequisites

### System Requirements

- **Node.js**: Version 18.0.0 or higher
- **npm**: Version 8.0.0 or higher
- **Operating System**: Linux, macOS, or Windows (WSL2 recommended for Windows)
- **Disk Space**: Minimum 100MB free space
- **Memory**: Minimum 512MB RAM
- **Network**: Internet connection for Waku network access

### Optional Dependencies

- **Obsidian**: For vault synchronization features
- **Docker**: For containerized deployment
- **OpenClaw**: For voice command integration
- **Hermes**: For AI assistant integration

## Installation Methods

### Method 1: Single-Command Setup (Recommended)

```bash
# Complete installation with one command
npx hivesync setup

# This will:
# 1. Download and install HiveSync
# 2. Run interactive configuration wizard
# 3. Generate encryption keys
# 4. Test connectivity
# 5. Start the service
```

### Method 2: Global Installation

```bash
# Install globally
npm install -g hivesync

# Run setup wizard
hivesync setup

# Start the service
hivesync start
```

### Method 3: Local Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/hivesync.git
cd hivesync

# Install dependencies
npm install

# Build the project
npm run build

# Run setup
npm run setup

# Start in development mode
npm run dev
```

### Method 4: Docker Installation

```bash
# Pull the Docker image
docker pull hivesync/hivesync:latest

# Run with Docker
docker run -v ./data:/data hivesync/hivesync:latest setup

# Or use Docker Compose
docker-compose up
```

## Configuration Wizard

When you run `hivesync setup`, you'll be guided through:

### Step 1: Agent Identity
```
? What is your agent name? My Agent
? Agent ID (leave blank to generate): [auto-generated]
```

### Step 2: Storage Configuration
```
? Where should data be stored? ./data/hivesync.db
```

### Step 3: Obsidian Integration (Optional)
```
? Enable Obsidian vault sync? Yes
? Path to your Obsidian vault: ~/Documents/Obsidian
? Sync interval (minutes): 5
```

### Step 4: Network Configuration
```
? Use custom Waku bootstrap nodes? No
```

### Step 5: Security Settings
```
? Generate new encryption keys? Yes
```

## Manual Configuration

### Configuration Files

HiveSync uses YAML configuration files. The main configuration file is typically at:
- `~/.hivesync/config.yaml` (global)
- `./config/hivesync.yaml` (project-local)

### Example Configuration

```yaml
# config/hivesync.yaml
agentId: "my-agent-001"
agentName: "My Agent"
storagePath: "./data/hivesync.db"
syncInterval: 5

waku:
  listenAddresses:
    - "/ip4/0.0.0.0/tcp/0/ws"
  bootstrapNodes:
    - "/dns4/node-01.do-ams3.wakuv2.test.status.im/tcp/443/wss/p2p/16Uiu2HAmPLe7Mzm8TsYUubgCAW1aJoeFScxrLj8ppHFivPo97bUZ"
    - "/dns4/node-01.gc-us-central1-a.wakuv2.test.status.im/tcp/443/wss/p2p/16Uiu2HAmJb2e28qLXxT5kZxVUUoJt72EMzNGXB47Rxx5hw3q4YjS"
  pubsubTopic: "/waku/2/hivesync/proto"
  keepAlive: true
  maxPeers: 10

obsidian:
  vaultPath: "~/Documents/Obsidian"
  autoSync: true
  ignorePatterns:
    - ".trash/**"
    - ".obsidian/**"

logging:
  level: "info"
  file: "./logs/hivesync.log"
  maxSize: "10m"
  maxFiles: 5
```

### Environment Variables

You can also configure HiveSync using environment variables:

```bash
export AGENT_ID="my-agent-001"
export AGENT_NAME="My Agent"
export STORAGE_PATH="./data/hivesync.db"
export SYNC_INTERVAL=5
export OBSIDIAN_PATH="~/Documents/Obsidian"
export LOG_LEVEL="info"
```

## First-Time Setup

### 1. Initialize the Database

```bash
# This happens automatically during setup
hivesync init
```

### 2. Generate Encryption Keys

```bash
# Generate new key pair
hivesync keys generate

# View public key
hivesync keys show
```

### 3. Test Connectivity

```bash
# Test Waku network connection
hivesync test

# Expected output:
# ✅ Connected to Waku network
# ✅ Local storage working
# ✅ Encryption working
```

### 4. Start the Service

```bash
# Start in foreground
hivesync start

# Start as daemon
hivesync start --daemon

# Start with verbose logging
hivesync start --verbose
```

## Multi-Agent Setup

### Setting Up Multiple Agents

To set up communication between multiple agents:

```bash
# On Machine 1
hivesync setup --name "Agent-Alpha"

# On Machine 2
hivesync setup --name "Agent-Beta"

# Get Agent-Alpha's ID
hivesync status
# Note the Agent ID from output

# On Agent-Beta, add Agent-Alpha as contact
hivesync contacts add agent-alpha-id "Agent Alpha"
```

### Network Configuration for Multiple Agents

Ensure both agents can connect to the Waku network:

```bash
# Check network connectivity
hivesync test

# If having connectivity issues, try custom bootstrap nodes
hivesync config set waku.bootstrapNodes '["/dns4/custom.node/tcp/443/wss/p2p/..."]'
```

## Obsidian Integration Setup

### 1. Configure Vault Path

```bash
# Set Obsidian vault path
hivesync config set obsidian.vaultPath "~/Documents/Obsidian"

# Enable auto-sync
hivesync config set obsidian.autoSync true
```

### 2. Initial Vault Scan

```bash
# Scan vault and create initial sync state
hivesync sync scan

# Expected output:
# 📁 Scanning vault...
# ✅ Found 42 notes
# ✅ Initial sync state created
```

### 3. Sync with Another Agent

```bash
# Initiate sync with specific agent
hivesync sync with agent-beta

# Or sync with all known agents
hivesync sync all
```

## OpenClaw Integration

### 1. Install OpenClaw Skill

```bash
# Install from npm
openclaw install openclaw-hivesync

# Or install from local development
cd openclaw-skill
npm install
npm run build
```

### 2. Configure OpenClaw

Add to OpenClaw configuration:

```yaml
# openclaw.config.yaml
skills:
  - name: hivesync
    enabled: true
    config:
      agentId: "my-agent-001"
      storagePath: "./data/hivesync.db"
```

### 3. Test Voice Commands

```bash
# Start OpenClaw with HiveSync skill
openclaw start

# Try voice commands:
# "Check HiveSync status"
# "Send message to agent-alpha Hello there!"
# "Sync my Obsidian notes"
```

## Hermes Integration

### 1. Install Hermes Module

```bash
# Install as Hermes dependency
cd /path/to/hermes
npm install hivesync
```

### 2. Configure Hermes

Add HiveSync module to Hermes configuration:

```javascript
// hermes.config.js
module.exports = {
  modules: {
    hivesync: {
      enabled: true,
      config: {
        agentId: 'hermes-main',
        agentName: 'Hermes Main Instance',
        storagePath: './data/hivesync.db',
      },
    },
  },
};
```

### 3. Use in Hermes

```javascript
// In your Hermes skills
const hivesync = hermes.modules.hivesync;

// Send a message
await hivesync.sendMessage('other-agent', 'Hello from My Agent!');

// Check for messages
const messages = await hivesync.getUnreadMessages();
```

## Docker Deployment

### 1. Create Docker Configuration

```dockerfile
# Dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["npm", "start"]
```

### 2. Docker Compose Setup

```yaml
# docker-compose.yml
version: '3.8'
services:
  hivesync:
    build: .
    container_name: hivesync
    restart: unless-stopped
    volumes:
      - ./data:/app/data
      - ./logs:/app/logs
      - ./config:/app/config
    environment:
      - NODE_ENV=production
      - AGENT_ID=${AGENT_ID}
      - AGENT_NAME=${AGENT_NAME}
    ports:
      - "3000:3000"
    healthcheck:
      test: ["CMD", "node", "dist/cli.js", "status", "--quiet"]
      interval: 30s
      timeout: 10s
      retries: 3
```

### 3. Run with Docker Compose

```bash
# Set environment variables
export AGENT_ID="docker-agent"
export AGENT_NAME="Docker Agent"

# Start services
docker-compose up -d

# View logs
docker-compose logs -f

# Check health
docker-compose ps
```

## Production Deployment

### 1. Systemd Service (Linux)

```bash
# Create systemd service file
sudo nano /etc/systemd/system/hivesync.service
```

```ini
[Unit]
Description=HiveSync Agent
After=network.target

[Service]
Type=simple
User=hivesync
WorkingDirectory=/opt/hivesync
Environment="NODE_ENV=production"
ExecStart=/usr/bin/hivesync start --daemon
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
# Enable and start service
sudo systemctl daemon-reload
sudo systemctl enable hivesync
sudo systemctl start hivesync
sudo systemctl status hivesync
```

### 2. PM2 Process Manager

```bash
# Install PM2 globally
npm install -g pm2

# Start HiveSync with PM2
pm2 start hivesync --name "hivesync" -- start

# Save PM2 configuration
pm2 save
pm2 startup

# Monitor with PM2
pm2 monit
pm2 logs hivesync
```

### 3. Reverse Proxy (Optional)

```nginx
# nginx configuration
server {
    listen 80;
    server_name hivesync.example.com;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

## Verification

### 1. Verify Installation

```bash
# Check version
hivesync --version

# Check if service is running
hivesync status

# Expected output:
# ✅ HiveSync is running
# Agent: My Agent (my-agent-001)
# Waku: Connected (3 peers)
# Obsidian: Enabled (42 notes)
```

### 2. Test Communication

```bash
# Send test message to yourself
hivesync send my-agent-001 "Test message"

# Check for messages
hivesync messages

# Expected output:
# 📨 Unread messages (1):
# 1. From: my-agent-001
#    Content: Test message
```

### 3. Test Obsidian Sync

```bash
# Create a test note in Obsidian
echo "# Test Sync\n\nThis is a test." > ~/Documents/Obsidian/Test.md

# Trigger sync
hivesync sync

# Check sync status
hivesync sync status
```

## Troubleshooting Setup Issues

### Common Issues

1. **Waku Connection Failed**
   ```bash
   # Check firewall settings
   sudo ufw allow 443/tcp
   
   # Try different bootstrap nodes
   hivesync config set waku.bootstrapNodes '["/dns4/alternate.node/tcp/443/wss/p2p/..."]'
   ```

2. **Database Permission Errors**
   ```bash
   # Fix permissions
   sudo chown -R $USER:$USER ./data
   
   # Or use different storage path
   hivesync config set storagePath "~/.hivesync/data.db"
   ```

3. **Obsidian Vault Not Found**
   ```bash
   # Verify vault path
   ls ~/Documents/Obsidian
   
   # Update configuration
   hivesync config set obsidian.vaultPath "/correct/path/to/Obsidian"
   ```

### Getting Help

- **Check Logs**: `tail -f logs/hivesync.log`
- **Debug Mode**: `LOG_LEVEL=debug hivesync start`
- **Community Support**: [GitHub Discussions](https://github.com/yourusername/hivesync/discussions)
- **Issue Tracker**: [GitHub Issues](https://github.com/yourusername/hivesync/issues)

## Next Steps

After successful setup:

1. **Add More Agents**: Set up HiveSync on other machines
2. **Configure Auto-Sync**: Enable automatic Obsidian synchronization
3. **Integrate with Workflows**: Connect HiveSync to your existing tools
4. **Explore Advanced Features**: Try group messaging, file sharing, etc.
5. **Join Community**: Share your setup and learn from others

Congratulations! You've successfully set up HiveSync. Your AI agents can now communicate securely and synchronize Obsidian vaults. 🎉
