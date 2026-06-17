declare module '@waku/sdk' {
  export interface PeerId {
    toString(): string;
  }

  export interface IDecodedMessage {
    payload?: Uint8Array;
    contentTopic?: string;
    timestamp?: Date;
  }

  export interface IEncoder {
    contentTopic: string;
  }

  export interface IDecoder {
    contentTopic: string;
  }

  export interface SDKProtocolResult {
    successes?: PeerId[];
    failures?: Array<{ error: string; peerId?: PeerId }>;
  }

  export interface SubscribeResult {
    subscription: ISubscription | null;
    error: string | null;
    results: SDKProtocolResult | null;
  }

  export interface ISubscription {
    subscribe(
      decoders: IDecoder | IDecoder[],
      callback: (msg: IDecodedMessage) => void | Promise<void>
    ): Promise<SDKProtocolResult>;
    unsubscribe(contentTopics: string[]): Promise<SDKProtocolResult>;
    unsubscribeAll(): Promise<SDKProtocolResult>;
    ping(peerId?: PeerId): Promise<SDKProtocolResult>;
  }

  export interface IFilter {
    subscribe(
      decoders: IDecoder | IDecoder[],
      callback: (msg: IDecodedMessage) => void | Promise<void>
    ): Promise<SubscribeResult>;
  }

  export interface ILightPush {
    send(
      encoder: IEncoder,
      message: { payload: Uint8Array },
      options?: Record<string, unknown>
    ): Promise<SDKProtocolResult>;
  }

  export interface LightNode {
    peerId: PeerId;
    filter?: IFilter;
    lightPush?: ILightPush;
    start(): Promise<void>;
    stop(): Promise<void>;
    waitForPeers(protocols?: string[], timeoutMs?: number): Promise<void>;
    isStarted(): boolean;
    isConnected(): boolean;
    getConnectedPeers(): Promise<Array<{ id: PeerId }>>;
  }

  export enum Protocols {
    Relay = 'relay',
    Store = 'store',
    LightPush = 'lightpush',
    Filter = 'filter',
  }

  export interface CreateNodeOptions {
    defaultBootstrap?: boolean;
    bootstrapPeers?: string[];
    networkConfig?: Record<string, unknown>;
    autoStart?: boolean;
  }

  export function createLightNode(options?: CreateNodeOptions): Promise<LightNode>;
  export function waitForRemotePeer(
    waku: LightNode,
    protocols?: Protocols[],
    timeoutMs?: number
  ): Promise<void>;
  export function createEncoder(params: { contentTopic: string; ephemeral?: boolean }): IEncoder;
  export function createDecoder(contentTopic: string): IDecoder;
  export function utf8ToBytes(str: string): Uint8Array;
  export function bytesToUtf8(bytes: Uint8Array): string;
}
