import { Skill, Context, Response } from 'openclaw-sdk';
import { BridgeManager } from 'waku-bridge';
import { loadConfig } from 'waku-bridge/dist/utils/config';

export class WakuBridgeSkill extends Skill {
  private bridge: BridgeManager | null = null;
  private config: any = null;

  constructor() {
    super({
      name: 'waku-bridge',
      version: '1.0.0',
      description: 'Secure Waku-based communication between agents',
      author: 'HiveSync Contributors',
      triggers: [
        'waku',
        'bridge',
        'message',
        'sync',
        'obsidian',
        'agent',
        'send',
        'receive',
        'status',
      ],
    });
  }

  async initialize(): Promise<void> {
    try {
      this.config = await loadConfig();
      this.bridge = new BridgeManager(this.config);
      await this.bridge.start();
      
      this.logger.info('Waku Bridge skill initialized');
    } catch (error) {
      this.logger.error('Failed to initialize Waku Bridge skill:', error);
      throw error;
    }
  }

  async handle(context: Context): Promise<Response> {
    const { text, intent } = context;
    
    try {
      if (!this.bridge) {
        return this.createResponse('Waku Bridge is not initialized', false);
      }

      // Check for specific commands
      if (text.includes('status') || text.includes('check')) {
        const status = this.bridge.getStatus();
        return this.createResponse(
          `Waku Bridge Status:
• Agent: ${status.agentName} (${status.agentId})
• Connected: ${status.waku.connected ? 'Yes' : 'No'}
• Peers: ${status.waku.peers}
• Obsidian Sync: ${status.obsidianSync ? 'Enabled' : 'Disabled'}`,
          true
        );
      }

      if (text.includes('send message') || text.includes('send to')) {
        // Extract recipient and message
        const match = text.match(/send (?:message )?to (\w+) (.+)/i);
        if (match) {
          const recipient = match[1];
          const message = match[2];
          const msgId = await this.bridge.sendTextMessage(recipient, message);
          return this.createResponse(`Message sent to ${recipient} (ID: ${msgId})`, true);
        } else {
          return this.createResponse('Please specify recipient and message. Format: "send to [agent] [message]"', false);
        }
      }

      if (text.includes('sync') || text.includes('synchronize')) {
        await this.bridge.sendCommand('broadcast', 'sync');
        return this.createResponse('Sync command sent to all agents', true);
      }

      if (text.includes('agents') || text.includes('list agents')) {
        // This would require adding a method to get agents
        return this.createResponse('Agent listing feature coming soon!', false);
      }

      if (text.includes('messages') || text.includes('check messages')) {
        const messages = await this.bridge.getUnreadMessages();
        if (messages.length === 0) {
          return this.createResponse('No unread messages', true);
        } else {
          const messageList = messages
            .slice(0, 5)
            .map((msg, i) => `${i + 1}. From ${msg.sender}: ${msg.content.text || msg.type}`)
            .join('\n');
          
          return this.createResponse(
            `Unread messages (${messages.length}):\n${messageList}`,
            true
          );
        }
      }

      if (text.includes('help') || text.includes('what can you do')) {
        return this.createResponse(
          `I can help you with:
• Check bridge status: "status"
• Send messages: "send to [agent] [message]"
• Sync Obsidian: "sync"
• Check messages: "messages"
• List agents: "agents"`,
          true
        );
      }

      // Default response
      return this.createResponse(
        'I can help you with Waku Bridge communication. Try asking about status, sending messages, or syncing Obsidian.',
        false
      );

    } catch (error) {
      this.logger.error('Error handling request:', error);
      return this.createResponse(`Error: ${error.message}`, false);
    }
  }

  async shutdown(): Promise<void> {
    if (this.bridge) {
      await this.bridge.stop();
      this.bridge = null;
    }
    this.logger.info('Waku Bridge skill shutdown');
  }

  private createResponse(text: string, success: boolean): Response {
    return {
      text,
      success,
      data: {
        timestamp: new Date().toISOString(),
        skill: 'waku-bridge',
      },
    };
  }
}

// Export factory function for OpenClaw
export function createSkill(): WakuBridgeSkill {
  return new WakuBridgeSkill();
}
