import { Socket } from 'net';
import { EventEmitter } from 'events';

enum MessageType {
  CLIENT_ADD = 1,
  CLIENT_REMOVE = 2,
  AUTH_UPDATE = 3,
  EXECUTE_TASK = 4,
  HEARTBEAT = 5,
  METADATA_UPDATE = 6,
  SESSION_UPDATE = 7,
  RESPONSE = 128,
}

export interface TaskResponse {
  taskId: string;
  receiveTimestamp: bigint;
  dispatchTimestamp: bigint;
  connectionId: number;
  statusCode: number;
  success: boolean;
  connectionReused: boolean;
  executorLatency: number;
}

/**
 * Binary protocol client for low-latency task execution over Unix sockets
 */
export class TaskExecutorClient extends EventEmitter {
  private socket: Socket | null = null;
  private socketPath: string;
  private connected = false;
  private reconnecting = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  private clientAdded = false;
  private metadataSent = false;
  private authSent = false;

  private pendingResponses = new Map<string, {
    resolve: (response: TaskResponse) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();

  private receiveBuffer = Buffer.alloc(0);

  constructor(socketPath: string) {
    super();
    this.socketPath = socketPath;
  }

  public async connect(): Promise<void> {
    if (this.connected) return;

    return new Promise((resolve, reject) => {
      this.socket = new Socket();

      this.socket.on('connect', () => {
        this.connected = true;
        this.reconnecting = false;
        const isReconnect = this.clientAdded || this.metadataSent || this.authSent;
        this.startHeartbeat();
        if (isReconnect) {
          this.emit('reconnected');
        }
        resolve();
      });

      this.socket.on('data', (data: Buffer) => {
        this.handleIncomingData(data);
      });

      this.socket.on('error', (err) => {
        if (!this.connected) {
          reject(err);
        }
      });

      this.socket.on('close', () => {
        this.connected = false;
        this.clientAdded = false;
        this.metadataSent = false;
        this.authSent = false;
        this.stopHeartbeat();
        this.scheduleReconnect();
      });

      this.socket.connect(this.socketPath);
    });
  }

  public disconnect(): void {
    this.connected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    for (const [taskId, pending] of this.pendingResponses) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Client disconnected'));
    }
    this.pendingResponses.clear();
  }

  private scheduleReconnect(): void {
    if (this.reconnecting) return;
    this.reconnecting = true;

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch(() => {});
    }, 1000);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat().catch(() => {});
    }, 5000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private handleIncomingData(data: Buffer): void {
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, data]);

    while (this.receiveBuffer.length >= 5) {
      const messageLength = this.receiveBuffer.readUInt32LE(0);

      if (this.receiveBuffer.length < messageLength) {
        break;
      }

      const messageBuffer = this.receiveBuffer.slice(0, messageLength);
      this.receiveBuffer = this.receiveBuffer.slice(messageLength);

      this.parseMessage(messageBuffer);
    }
  }

  private parseMessage(buffer: Buffer): void {
    if (buffer.length < 5) return;

    const msgType = buffer.readUInt8(4);

    if (msgType === MessageType.RESPONSE) {
      this.parseResponse(buffer);
    }
  }

  private parseResponse(buffer: Buffer): void {
    let offset = 5;

    const taskIdLength = buffer.readUInt16LE(offset);
    offset += 2;

    const receiveTimestamp = buffer.readBigUInt64LE(offset);
    offset += 8;
    const dispatchTimestamp = buffer.readBigUInt64LE(offset);
    offset += 8;

    const connectionId = buffer.readUInt32LE(offset);
    offset += 4;
    const statusCode = buffer.readUInt16LE(offset);
    offset += 2;
    const success = buffer.readUInt8(offset) !== 0;
    offset += 1;
    const connectionReused = buffer.readUInt8(offset) !== 0;
    offset += 1;

    const taskId = buffer.toString('utf8', offset, offset + taskIdLength);

    const latencyNs = Number(dispatchTimestamp - receiveTimestamp);
    const executorLatency = latencyNs / 1_000_000;

    const response: TaskResponse = {
      taskId,
      receiveTimestamp,
      dispatchTimestamp,
      connectionId,
      statusCode,
      success,
      connectionReused,
      executorLatency,
    };

    const pending = this.pendingResponses.get(taskId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingResponses.delete(taskId);
      pending.resolve(response);
    }

    this.emit('response', response);
  }

  private async sendMessage(buffer: Buffer): Promise<void> {
    if (!this.connected || !this.socket) {
      throw new Error('Not connected to executor');
    }

    return new Promise((resolve, reject) => {
      this.socket!.write(buffer, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  public async addClient(
    clientId: string,
    sessionData: string,
    metadata: string,
    authToken: string,
    secondaryToken?: string,
    headers?: Record<string, string>
  ): Promise<void> {
    const clientIdBuf = Buffer.from(clientId, 'utf8');
    const sessionBuf = Buffer.from(sessionData, 'utf8');
    const metadataBuf = Buffer.from(metadata, 'utf8');
    const authBuf = Buffer.from(authToken, 'utf8');
    const secondaryBuf = secondaryToken
      ? Buffer.from(secondaryToken, 'utf8')
      : Buffer.alloc(0);
    const headersBuf = Buffer.from(JSON.stringify(headers || {}), 'utf8');

    const HEADER_SIZE = 4 + 1;  // message length (UInt32) + message type (UInt8)
    const LENGTH_FIELDS_SIZE = 2 * 6;  // 6 length fields (UInt16 each)

    const totalLength =
      HEADER_SIZE +
      LENGTH_FIELDS_SIZE +
      clientIdBuf.length +
      sessionBuf.length +
      metadataBuf.length +
      authBuf.length +
      secondaryBuf.length +
      headersBuf.length;

    const buffer = Buffer.allocUnsafe(totalLength);
    let offset = 0;

    buffer.writeUInt32LE(totalLength, offset); offset += 4;
    buffer.writeUInt8(MessageType.CLIENT_ADD, offset); offset += 1;

    buffer.writeUInt16LE(clientIdBuf.length, offset); offset += 2;
    buffer.writeUInt16LE(sessionBuf.length, offset); offset += 2;
    buffer.writeUInt16LE(metadataBuf.length, offset); offset += 2;
    buffer.writeUInt16LE(authBuf.length, offset); offset += 2;
    buffer.writeUInt16LE(secondaryBuf.length, offset); offset += 2;
    buffer.writeUInt16LE(headersBuf.length, offset); offset += 2;

    clientIdBuf.copy(buffer, offset); offset += clientIdBuf.length;
    sessionBuf.copy(buffer, offset); offset += sessionBuf.length;
    metadataBuf.copy(buffer, offset); offset += metadataBuf.length;
    authBuf.copy(buffer, offset); offset += authBuf.length;
    secondaryBuf.copy(buffer, offset); offset += secondaryBuf.length;
    headersBuf.copy(buffer, offset);

    await this.sendMessage(buffer);
    this.clientAdded = true;
    this.metadataSent = true;
  }

  public async removeClient(clientId: string): Promise<void> {
    const clientIdBuf = Buffer.from(clientId, 'utf8');
    const HEADER_SIZE = 4 + 1;  // message length + message type
    const totalLength = HEADER_SIZE + 2 + clientIdBuf.length;  // +2 for clientId length field
    const buffer = Buffer.allocUnsafe(totalLength);

    let offset = 0;
    buffer.writeUInt32LE(totalLength, offset); offset += 4;
    buffer.writeUInt8(MessageType.CLIENT_REMOVE, offset); offset += 1;
    buffer.writeUInt16LE(clientIdBuf.length, offset); offset += 2;
    clientIdBuf.copy(buffer, offset);

    await this.sendMessage(buffer);
  }

  public async updateAuth(
    clientId: string,
    authToken: string,
    secondaryToken?: string
  ): Promise<void> {
    const clientIdBuf = Buffer.from(clientId, 'utf8');
    const authBuf = Buffer.from(authToken, 'utf8');
    const secondaryBuf = secondaryToken
      ? Buffer.from(secondaryToken, 'utf8')
      : Buffer.alloc(0);

    const HEADER_SIZE = 4 + 1;  // message length + message type
    const LENGTH_FIELDS_SIZE = 2 * 3;  // 3 length fields (clientId, auth, secondary)
    const totalLength = HEADER_SIZE + LENGTH_FIELDS_SIZE +
                       clientIdBuf.length + authBuf.length + secondaryBuf.length;
    const buffer = Buffer.allocUnsafe(totalLength);

    let offset = 0;
    buffer.writeUInt32LE(totalLength, offset); offset += 4;
    buffer.writeUInt8(MessageType.AUTH_UPDATE, offset); offset += 1;
    buffer.writeUInt16LE(clientIdBuf.length, offset); offset += 2;
    buffer.writeUInt16LE(authBuf.length, offset); offset += 2;
    buffer.writeUInt16LE(secondaryBuf.length, offset); offset += 2;

    clientIdBuf.copy(buffer, offset); offset += clientIdBuf.length;
    authBuf.copy(buffer, offset); offset += authBuf.length;
    secondaryBuf.copy(buffer, offset);

    await this.sendMessage(buffer);
    this.authSent = true;
  }

  public async updateMetadata(clientId: string, metadata: string): Promise<void> {
    const clientIdBuf = Buffer.from(clientId, 'utf8');
    const metadataBuf = Buffer.from(metadata, 'utf8');
    const HEADER_SIZE = 4 + 1;  // message length + message type
    const LENGTH_FIELDS_SIZE = 2 * 2;  // 2 length fields (clientId, metadata)
    const totalLength = HEADER_SIZE + LENGTH_FIELDS_SIZE + clientIdBuf.length + metadataBuf.length;
    const buffer = Buffer.allocUnsafe(totalLength);

    let offset = 0;
    buffer.writeUInt32LE(totalLength, offset); offset += 4;
    buffer.writeUInt8(MessageType.METADATA_UPDATE, offset); offset += 1;
    buffer.writeUInt16LE(clientIdBuf.length, offset); offset += 2;
    buffer.writeUInt16LE(metadataBuf.length, offset); offset += 2;

    clientIdBuf.copy(buffer, offset); offset += clientIdBuf.length;
    metadataBuf.copy(buffer, offset);

    await this.sendMessage(buffer);
    this.metadataSent = true;
  }

  public async updateSession(clientId: string, sessionData: string): Promise<void> {
    const clientIdBuf = Buffer.from(clientId, 'utf8');
    const sessionBuf = Buffer.from(sessionData, 'utf8');
    const HEADER_SIZE = 4 + 1;  // message length + message type
    const LENGTH_FIELDS_SIZE = 2 * 2;  // 2 length fields (clientId, session)
    const totalLength = HEADER_SIZE + LENGTH_FIELDS_SIZE + clientIdBuf.length + sessionBuf.length;
    const buffer = Buffer.allocUnsafe(totalLength);

    let offset = 0;
    buffer.writeUInt32LE(totalLength, offset); offset += 4;
    buffer.writeUInt8(MessageType.SESSION_UPDATE, offset); offset += 1;
    buffer.writeUInt16LE(clientIdBuf.length, offset); offset += 2;
    buffer.writeUInt16LE(sessionBuf.length, offset); offset += 2;

    clientIdBuf.copy(buffer, offset); offset += clientIdBuf.length;
    sessionBuf.copy(buffer, offset);

    await this.sendMessage(buffer);
  }

  public async executeTask(
    clientId: string,
    taskId: string | string[],
    receiveTimestamp: bigint
  ): Promise<void> {
    const taskIds = Array.isArray(taskId) ? taskId : [taskId];

    const clientIdBuf = Buffer.from(clientId, 'utf8');
    const clientIdLen = clientIdBuf.length;
    const taskCount = taskIds.length;

    const HEADER_SIZE = 4 + 1;  // message length + message type
    const FIXED_FIELDS_SIZE = 8 + 2 + 2;  // timestamp + clientIdLen + taskCount
    let totalSize = HEADER_SIZE + FIXED_FIELDS_SIZE + clientIdLen;

    for (const tid of taskIds) {
      totalSize += 2 + tid.length;  // length field + task ID string
    }

    const buffer = Buffer.allocUnsafe(totalSize);
    let offset = 0;

    buffer.writeUInt32LE(totalSize, offset); offset += 4;
    buffer.writeUInt8(MessageType.EXECUTE_TASK, offset); offset += 1;

    buffer.writeBigUInt64LE(receiveTimestamp, offset); offset += 8;
    buffer.writeUInt16LE(clientIdLen, offset); offset += 2;
    buffer.writeUInt16LE(taskCount, offset); offset += 2;

    clientIdBuf.copy(buffer, offset); offset += clientIdLen;

    for (const tid of taskIds) {
      const tidBuf = Buffer.from(tid, 'utf8');
      buffer.writeUInt16LE(tidBuf.length, offset); offset += 2;
      tidBuf.copy(buffer, offset); offset += tidBuf.length;
    }

    if (!this.socket) throw new Error('Socket not connected');
    return new Promise((resolve, reject) => {
      this.socket!.write(buffer, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private async sendHeartbeat(): Promise<void> {
    const totalLength = 5;
    const buffer = Buffer.allocUnsafe(totalLength);
    buffer.writeUInt32LE(totalLength, 0);
    buffer.writeUInt8(MessageType.HEARTBEAT, 4);
    await this.sendMessage(buffer);
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public isReady(): boolean {
    return this.connected && this.clientAdded && this.metadataSent && this.authSent;
  }

  public getStatus(): {
    connected: boolean;
    clientAdded: boolean;
    metadataSent: boolean;
    authSent: boolean;
    ready: boolean;
  } {
    return {
      connected: this.connected,
      clientAdded: this.clientAdded,
      metadataSent: this.metadataSent,
      authSent: this.authSent,
      ready: this.isReady(),
    };
  }
}
