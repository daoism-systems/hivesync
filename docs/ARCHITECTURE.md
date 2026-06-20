# HiveSync Architecture

## Overview

HiveSync is a secure, decentralized communication system built on the Waku protocol. It enables AI agents (like Hermes) to communicate securely while synchronizing Obsidian vaults across multiple instances.

## System Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Application Layer                        │
├───────────────┬───────────────┬─────────────────────────────┤
│   CLI Tool    │  OpenClaw     │      Hermes Module            │
│               │   Skill       │                             │
└───────────────┴───────────────┴─────────────────────────────┘
                            │
┌─────────────────────────────────────────────────────────────┐
│                    Bridge Manager                           │
│  (Orchestration, Configuration, Lifecycle Management)      │
└─────────────────────────────────────────────────────────────┘
                            │
    ┌──────────────┬──────────────┬──────────────┐
    │              │              │              │
┌───▼───┐    ┌────▼────┐    ┌────▼────┐    ┌────▼────┐
│ Waku  │    │ Storage │    │  Sync   │    │Encryption│
│ Bridge│    │ Manager │    │ Engine  │    │ Engine  │
└───┬───┘    └────┬────┘    └────┬────┘    └────┬────┘
    │              │              │              │
┌───▼──────────────▼──────────────▼──────────────▼────┐
│              Waku Protocol Network                  │
│          (Decentralized P2P Messaging)              │
└─────────────────────────────────────────────────────┘
```

## Component Details

### 1. Waku Bridge

**Purpose**: Manages communication over the Waku network.

**Key Responsibilities**:
- Connect to Waku network using light nodes
- Subscribe to pubsub topics
- Send and receive encrypted messages
- Handle peer discovery and management
- Manage network connectivity and reconnection

**Technical Details**:
- Uses `js-waku` library for Waku v2 protocol
- Light node mode for resource efficiency
- Noise Protocol for transport encryption
- Libp2p for peer-to-peer networking

### 2. Storage Manager

**Purpose**: Manages local data persistence.

**Key Responsibilities**:
- Store messages (sent and received)
- Track agent identities and public keys
- Manage Obsidian note metadata
- Maintain sync state and history
- Handle database migrations

**Technical Details**:
- SQLite database for local storage
- Schema versioning and migrations
- Efficient indexing for message retrieval
- Transaction support for data consistency

### 3. Sync Engine

**Purpose**: Handles Obsidian vault synchronization.

**Key Responsibilities**:
- Monitor vault for file changes
- Detect conflicts and resolve them
- Synchronize notes between agents
- Handle file attachments and metadata
- Manage sync schedules and intervals

**Technical Details**:
- File system watcher for real-time changes
- SHA-256 hashing for change detection
- Conflict resolution (most recent wins)
- Chunked file transfer for large files

### 4. Encryption Engine

**Purpose**: Provides end-to-end encryption.

**Key Responsibilities**:
- Generate and manage RSA key pairs
- Encrypt/decrypt message payloads
- Verify message signatures
- Handle key exchange between agents
- Manage encryption keys securely

**Technical Details**:
- RSA 2048 for agent identity
- AES-256-GCM for message encryption
- SHA-256 for message integrity
- Local key storage (never transmitted)

### 5. Bridge Manager

**Purpose**: Orchestrates all components.

**Key Responsibilities**:
- Initialize and coordinate all subsystems
- Handle configuration management
- Provide unified API for external use
- Manage system lifecycle (start/stop)
- Handle error recovery and logging

**Technical Details**:
- Singleton pattern for system coordination
- Event-driven architecture
- Comprehensive error handling
- Health monitoring and reporting

## Data Flow

### Message Sending

```
1. User/Agent → Bridge Manager → Send Message Request
2. Bridge Manager → Encryption Engine → Encrypt Message
3. Encryption Engine → Storage Manager → Store Message (local)
4. Storage Manager → Waku Bridge → Send via Waku Network
5. Waku Network → Destination Agent's Waku Bridge
6. Destination Waku Bridge → Encryption Engine → Decrypt Message
7. Encryption Engine → Storage Manager → Store Message (remote)
8. Storage Manager → Bridge Manager → Deliver to User/Agent
```

### Obsidian Sync

```
1. File System → Sync Engine → Detect File Change
2. Sync Engine → Storage Manager → Check Last Sync State
3. Storage Manager → Sync Engine → Prepare Sync Package
4. Sync Engine → Encryption Engine → Encrypt File Data
5. Encryption Engine → Waku Bridge → Send Sync Request
6. Destination Agent → Reverse Process → Apply Changes
7. Both Agents → Storage Manager → Update Sync State
```

## Security Architecture

### Threat Model

HiveSync is designed to protect against:

1. **Eavesdropping**: Prevented by end-to-end encryption
2. **Message Tampering**: Prevented by cryptographic signatures
3. **Replay Attacks**: Prevented by message timestamps and nonces
4. **Impersonation**: Prevented by RSA key authentication
5. **Denial of Service**: Mitigated by rate limiting and peer management

### Security Layers

1. **Transport Security**: Noise Protocol over Waku
2. **Message Security**: AES-256-GCM encryption per message
3. **Identity Security**: RSA 2048 key pairs per agent
4. **Storage Security**: Local SQLite with optional encryption
5. **Network Security**: Decentralized P2P with no central points

## Network Architecture

### Waku Network Integration

HiveSync connects to the Waku network through:

1. **Bootstrap Nodes**: Pre-configured nodes for initial connection
2. **Peer Discovery**: Automatic discovery via Waku Discv5
3. **Topic Subscription**: Pubsub topics for message routing
4. **Store & Retrieve**: Historical message retrieval capability

### Network Topology

```
Agent A ───┐
           ├── Waku Network ─── Agent C
Agent B ───┘           │
                       │
                [Bootstrap Nodes]
                [Relay Nodes]
                [Store Nodes]
```

## Storage Architecture

### Database Schema

```
messages
├── id (PK)
├── sender
├── recipient
├── type
├── content (encrypted)
├── timestamp
├── encrypted (boolean)
└── signature

agents
├── id (PK)
├── name
├── public_key
├── created_at
├── last_seen
└── trusted (boolean)

obsidian_notes
├── id (PK)
├── path
├── content
├── last_modified
├── hash
├── synced (boolean)
└── sync_timestamp

sync_state
├── agent_id (PK, FK)
├── last_sync
├── notes_synced
└── conflicts
```

### File Storage

- **Message Attachments**: Stored in `./data/attachments/`
- **Temporary Files**: Stored in OS temp directory
- **Key Storage**: `./data/keys/` (encrypted at rest)
- **Log Files**: `./logs/` with rotation

## Performance Considerations

### Optimization Strategies

1. **Message Batching**: Group small messages for efficiency
2. **Lazy Loading**: Load message content only when needed
3. **Connection Pooling**: Reuse Waku connections
4. **Caching**: Frequently accessed data in memory
5. **Indexing**: Database indexes for common queries

### Resource Management

- **Memory**: Light node mode minimizes memory usage
- **CPU**: Async operations and worker threads
- **Network**: Compression and efficient serialization
- **Storage**: Automatic cleanup of old messages

## Scalability

### Horizontal Scaling

HiveSync supports scaling through:

1. **Multiple Agents**: Each agent is independent
2. **Topic Partitioning**: Different topics for different use cases
3. **Load Distribution**: Messages distributed across Waku network
4. **Federation**: Multiple HiveSync instances can interoperate

### Vertical Scaling

- **Database Optimization**: Query optimization and indexing
- **Memory Management**: Efficient garbage collection
- **Network Optimization**: Connection pooling and reuse

## Monitoring & Observability

### Metrics Collected

1. **System Metrics**: CPU, memory, disk usage
2. **Network Metrics**: Peers, latency, message rates
3. **Storage Metrics**: Database size, message counts
4. **Sync Metrics**: Files synced, conflicts, sync times

### Logging Strategy

- **Structured Logging**: JSON format for machine parsing
- **Log Levels**: Error, Warn, Info, Debug
- **Log Rotation**: Daily rotation with retention policy
- **Remote Logging**: Optional integration with logging services

## Deployment Architecture

### Single-Node Deployment

```
┌─────────────────────┐
│   HiveSync Agent    │
│                     │
│  ┌──────────────┐  │
│  │   All        │  │
│  │  Components  │  │
│  └──────────────┘  │
│                     │
│  Waku Network ←─────┘
└─────────────────────┘
```

### Multi-Agent Deployment

```
┌─────────────────┐    ┌─────────────────┐
│  Agent Alpha    │    │   Agent Beta    │
│                 │    │                 │
│  ┌──────────┐  │    │  ┌──────────┐  │
│  │HiveSync  │  │    │  │HiveSync  │  │
│  └──────────┘  │    │  └──────────┘  │
│                 │    │                 │
└─────────┬───────┘    └───────┬────────┘
          │                     │
          └───────┬─────┬───────┘
                  │     │
           ┌──────▼─────▼──────┐
           │   Waku Network    │
           └───────────────────┘
```

### Docker Deployment

```yaml
# docker-compose.yml
version: '3.8'
services:
  hivesync:
    image: hivesync/hivesync:latest
    volumes:
      - ./data:/app/data
      - ./logs:/app/logs
      - ./config:/app/config
    environment:
      - AGENT_ID=${AGENT_ID}
      - AGENT_NAME=${AGENT_NAME}
    ports:
      - "3000:3000" # Optional API port
```

## Future Architecture Considerations

### Planned Enhancements

1. **Plugin System**: Allow custom sync adapters and message handlers
2. **Web Interface**: Browser-based management console
3. **Mobile Support**: iOS/Android apps for mobile agents
4. **Blockchain Integration**: Optional blockchain for audit trails
5. **AI-Powered Features**: Smart message routing and prioritization

### Technical Debt Management

- **Code Quality**: Regular refactoring and code reviews
- **Testing Coverage**: Maintain high test coverage
- **Documentation**: Keep architecture docs up to date
- **Dependency Updates**: Regular security updates

## Conclusion

HiveSync's architecture is designed for security, scalability, and ease of use. By leveraging the Waku protocol for decentralized communication and providing robust encryption and synchronization capabilities, it enables secure collaboration between AI agents while maintaining user privacy and control.

The modular design allows for easy extension and integration with various AI systems, making it a versatile foundation for decentralized AI communication.
