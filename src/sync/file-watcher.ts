import * as fs from 'fs';
import * as path from 'path';
import chokidar from 'chokidar';
import { logger } from '../utils/logger';

export interface FileChangeEvent {
  type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';
  path: string;
  stats?: fs.Stats;
}

export class FileWatcher {
  private watcher: chokidar.FSWatcher | null = null;
  private vaultPath: string;
  private onChange: (event: FileChangeEvent) => Promise<void>;
  private isWatching: boolean = false;
  private ignoredPatterns: string[] = [
    '.trash/**',
    '.obsidian/**',
    '.git/**',
    '*.tmp',
    '*.swp',
    '*.swo',
    '*.DS_Store'
  ];

  constructor(vaultPath: string, onChange: (event: FileChangeEvent) => Promise<void>) {
    this.vaultPath = vaultPath;
    this.onChange = onChange;
  }

  async start(): Promise<void> {
    if (this.isWatching) {
      logger.warn('File watcher is already running');
      return;
    }

    if (!fs.existsSync(this.vaultPath)) {
      throw new Error(`Vault path does not exist: ${this.vaultPath}`);
    }

    logger.info(`Starting file watcher for vault: ${this.vaultPath}`);

    this.watcher = chokidar.watch(this.vaultPath, {
      ignored: this.ignoredPatterns,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 1000,
        pollInterval: 100
      },
      depth: 10,
    });

    // Set up event handlers
    this.watcher
      .on('add', (filePath: string) => this.handleFileEvent('add', filePath))
      .on('change', (filePath: string) => this.handleFileEvent('change', filePath))
      .on('unlink', (filePath: string) => this.handleFileEvent('unlink', filePath))
      .on('addDir', (dirPath: string) => this.handleDirectoryEvent('addDir', dirPath))
      .on('unlinkDir', (dirPath: string) => this.handleDirectoryEvent('unlinkDir', dirPath))
      .on('error', (error: Error) => {
        logger.error('File watcher error:', error);
      })
      .on('ready', () => {
        this.isWatching = true;
        logger.info('File watcher is ready and monitoring for changes');
      });

    // Initial scan to establish baseline
    await this.performInitialScan();
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
      this.isWatching = false;
      logger.info('File watcher stopped');
    }
  }

  private async handleFileEvent(type: 'add' | 'change' | 'unlink', filePath: string): Promise<void> {
    // Only process markdown files
    if (!filePath.endsWith('.md')) {
      return;
    }

    try {
      const relativePath = path.relative(this.vaultPath, filePath);
      logger.debug(`File ${type}: ${relativePath}`);

      let stats: fs.Stats | undefined;
      if (type !== 'unlink') {
        try {
          stats = fs.statSync(filePath);
        } catch (error) {
          logger.warn(`Could not get stats for ${filePath}:`, error);
        }
      }

      await this.onChange({
        type,
        path: relativePath,
        stats,
      });
    } catch (error) {
      logger.error(`Error handling file event for ${filePath}:`, error);
    }
  }

  private async handleDirectoryEvent(type: 'addDir' | 'unlinkDir', dirPath: string): Promise<void> {
    try {
      const relativePath = path.relative(this.vaultPath, dirPath);
      logger.debug(`Directory ${type}: ${relativePath}`);

      await this.onChange({
        type,
        path: relativePath,
      });
    } catch (error) {
      logger.error(`Error handling directory event for ${dirPath}:`, error);
    }
  }

  private async performInitialScan(): Promise<void> {
    logger.info('Performing initial vault scan...');
    
    const scanDirectory = async (dir: string): Promise<void> => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(this.vaultPath, fullPath);

        // Skip ignored patterns
        if (this.isIgnored(relativePath)) {
          continue;
        }

        if (entry.isDirectory()) {
          // Report directory
          await this.onChange({
            type: 'addDir',
            path: relativePath,
            stats: fs.statSync(fullPath),
          });
          
          // Recursively scan subdirectory
          await scanDirectory(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          // Report file
          await this.onChange({
            type: 'add',
            path: relativePath,
            stats: fs.statSync(fullPath),
          });
        }
      }
    };

    try {
      await scanDirectory(this.vaultPath);
      logger.info('Initial vault scan completed');
    } catch (error) {
      logger.error('Error during initial vault scan:', error);
    }
  }

  private isIgnored(relativePath: string): boolean {
    return this.ignoredPatterns.some(pattern => {
      const regex = this.patternToRegex(pattern);
      return regex.test(relativePath);
    });
  }

  private patternToRegex(pattern: string): RegExp {
    // Convert glob pattern to regex
    const escaped = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '.*')
      .replace(/\*/g, '[^/]*');
    
    return new RegExp(`^${escaped}$`);
  }

  async getNoteContent(filePath: string): Promise<string> {
    const fullPath = path.join(this.vaultPath, filePath);
    return fs.readFileSync(fullPath, 'utf-8');
  }

  async saveNoteContent(filePath: string, content: string): Promise<void> {
    const fullPath = path.join(this.vaultPath, filePath);
    const dir = path.dirname(fullPath);
    
    // Ensure directory exists
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    fs.writeFileSync(fullPath, content, 'utf-8');
  }

  async deleteNote(filePath: string): Promise<void> {
    const fullPath = path.join(this.vaultPath, filePath);
    
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
      
      // Clean up empty directories
      await this.cleanupEmptyDirectories(path.dirname(fullPath));
    }
  }

  private async cleanupEmptyDirectories(dirPath: string): Promise<void> {
    // Don't go above vault root
    if (dirPath === this.vaultPath || !dirPath.startsWith(this.vaultPath)) {
      return;
    }

    try {
      const entries = fs.readdirSync(dirPath);
      
      // If directory is empty, delete it and check parent
      if (entries.length === 0) {
        fs.rmdirSync(dirPath);
        await this.cleanupEmptyDirectories(path.dirname(dirPath));
      }
    } catch (error) {
      // Directory might not exist or have permissions issues
      logger.debug(`Could not check directory ${dirPath}:`, error);
    }
  }

  isRunning(): boolean {
    return this.isWatching;
  }

  getVaultPath(): string {
    return this.vaultPath;
  }
}
