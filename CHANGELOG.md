# Changelog

All notable changes to HiveSync will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-04-04

### Added
- Initial release of HiveSync
- Secure end-to-end encrypted messaging using Waku protocol
- Obsidian vault synchronization
- Single-command setup: `npx hivesync setup`
- OpenClaw skill integration
- Kai assistant module support
- Comprehensive CLI interface
- SQLite storage system
- Heartbeat monitoring system
- Complete test suite (unit, integration, e2e)
- Production-ready documentation
- Docker deployment support
- Systemd service files

### Technical Features
- Waku v2 protocol for decentralized communication
- Noise Protocol for end-to-end encryption
- RSA 2048 for agent identity
- AES-256-GCM for message encryption
- TypeScript for type safety
- Jest for testing
- Commander.js for CLI interface

### Security
- End-to-end encryption by default
- Local key storage (keys never transmitted)
- No central servers or intermediaries
- Agent authentication with unique identities
- Message signing and verification

### Documentation
- Complete technical specification
- Architecture documentation
- Setup guide
- API reference
- Troubleshooting guide
- Contribution guidelines

### Deployment Options
- Local installation
- Docker containers
- Docker Compose
- Systemd services
- PM2 process manager
