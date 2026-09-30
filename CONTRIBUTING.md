# Contributing to HiveSync

Thank you for your interest in contributing to HiveSync! This document provides guidelines and instructions for contributing.

## Code of Conduct

Please be respectful and considerate of others when contributing to this project.

## How to Contribute

### Reporting Bugs
1. Check if the bug has already been reported in [Issues](https://github.com/daoism-systems/hivesync/issues)
2. If not, create a new issue with:
   - A clear, descriptive title
   - Steps to reproduce the bug
   - Expected vs actual behavior
   - Environment details (OS, Node.js version, etc.)
   - Any relevant logs or screenshots

### Suggesting Features
1. Check if the feature has already been suggested
2. Create a new issue with:
   - A clear description of the feature
   - Use cases and benefits
   - Any implementation ideas you have

### Pull Requests
1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Make your changes
4. Add or update tests as needed
5. Ensure all tests pass: `npm test`
6. Update documentation if necessary
7. Commit your changes: `git commit -m 'Add amazing feature'`
8. Push to your branch: `git push origin feature/amazing-feature`
9. Open a Pull Request

## Development Setup

### Prerequisites
- Node.js 22+
- npm 10+
- Git

### Installation
```bash
git clone https://github.com/daoism-systems/hivesync.git
cd hivesync
npm install
npm run build
```

### Running Tests
```bash
# Run all tests
npm test

# Run specific test suites
npm run test:unit
npm run test:integration
npm run test:e2e     # needs internet; HIVESYNC_SKIP_E2E=1 skips it

# Run with coverage
npm run coverage
```

### Code Style
- Use TypeScript for all new code
- Follow existing code style and patterns
- Run linter: `npm run lint`
- Format code: `npm run format`

## Project Structure
```
src/              # Source code
├── core/         # Bridge, transport (Waku/InMemory), identity, crypto, self-update
├── storage/      # SQLite storage + quarantine store
├── sync/         # Obsidian real-time sync
├── utils/        # Config, logger, TUI
├── types/        # TypeScript definitions
├── cli.ts        # `hivesync` CLI entry point
└── mcp-server.ts # MCP server (`hivesync mcp`)

tests/            # Test suites
├── unit/         # Unit tests
├── integration/  # Two BridgeManagers over the in-memory bus
└── e2e/          # Two real processes over the live Waku network

scripts/          # Diagnostics, demos, and the on-message hook example
docs/             # Setup guides (light mode, relay hub, self-update, protocol)
hermes-setup/     # Hermes platform plugin (installed by hermes-setup.sh)
openclaw-skill/   # OpenClaw skill (see also openclaw-setup.sh)
```

## Commit Guidelines
- Use conventional commit messages
- Keep commits focused and atomic
- Reference issue numbers when applicable

Example commit messages:
```
feat: add message encryption
fix: resolve database connection issue
docs: update setup instructions
test: add unit tests for storage manager
```

## Release Process
1. Update version in `package.json`
2. Update CHANGELOG.md
3. Create a release tag: `git tag v2.1.0`
4. Push the tag: `git push origin v2.1.0` — CI publishes it to npm and creates
   the GitHub release (requires the `NPM_TOKEN` repo secret)

## Getting Help
- Check the [documentation](https://github.com/daoism-systems/hivesync#readme)
- Ask questions in [Issues](https://github.com/daoism-systems/hivesync/issues)

## License
By contributing, you agree that your contributions will be licensed under the MIT License.
