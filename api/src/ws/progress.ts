/**
 * WebSocket progress fan-out.
 *
 * Ingestion is asynchronous, so the client subscribes to paper:{id} and
 * receives IngestProgressEvent stage transitions. Tutor Chat deliberately
 * uses SSE instead -- it is one-way token streaming and does not need a
 * bidirectional channel.
 *
 * Events travel API <- Redis pub/sub <- worker, rather than worker -> API
 * directly, because the API is stateless and horizontally scaled: the socket
 * for paper 42 is held by whichever instance the client happened to reach,
 * which is not the instance the worker could call even if it knew how.
 */
// Side-effect imports: both plugins augment FastifyInstance and the route
// options via declaration merging, and the augmentation is only visible in
// modules that reference the package.
import '@fastify/jwt';
import '@fastify/websocket';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { IngestProgressEvent } from '@precedent/shared';
import { redis } from '../queue/index.js';
import type { WsClientMessage, WsServerMessage } from '../types.js';

/** The one Redis channel every ingest progress event crosses. */
export const PROGRESS_CHANNEL = 'precedent:ingest-progress';

export const paperChannel = (paperId: string): string => `paper:${paperId}`;

/** Structural, so the module does not depend on @types/ws being installed. */
export interface ProgressSocket {
  send(data: string, cb?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
  on(event: 'message' | 'close' | 'error', cb: (...args: never[]) => void): void;
}

/** 1008 "policy violation" -- the standard close code for a rejected client. */
export const CLOSE_UNAUTHORIZED = 1008;

export class ProgressHub {
  private readonly byChannel = new Map<string, Set<ProgressSocket>>();

  subscribe(channel: string, socket: ProgressSocket): void {
    let set = this.byChannel.get(channel);
    if (!set) {
      set = new Set();
      this.byChannel.set(channel, set);
    }
    set.add(socket);
  }

  unsubscribe(channel: string, socket: ProgressSocket): void {
    const set = this.byChannel.get(channel);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) this.byChannel.delete(channel);
  }

  /** Drops a closing socket from every channel it joined. */
  remove(socket: ProgressSocket): void {
    for (const channel of [...this.byChannel.keys()]) this.unsubscribe(channel, socket);
  }

  subscriberCount(channel: string): number {
    return this.byChannel.get(channel)?.size ?? 0;
  }

  deliver(event: IngestProgressEvent): number {
    const channel = paperChannel(event.paperId);
    const sockets = this.byChannel.get(channel);
    if (!sockets) return 0;
    const frame: WsServerMessage = { type: 'progress', channel, event };
    const payload = JSON.stringify(frame);
    let sent = 0;
    for (const socket of sockets) {
      try {
        socket.send(payload);
        sent += 1;
      } catch {
        // A socket that throws on send is already gone; dropping it here
        // avoids waiting for a close event that may never arrive.
        this.remove(socket);
      }
    }
    return sent;
  }
}

/** Publishes an event for every API instance to fan out. Also used by the worker. */
export async function publishProgress(event: IngestProgressEvent): Promise<void> {
  await redis().publish(PROGRESS_CHANNEL, JSON.stringify(event));
}

function send(socket: ProgressSocket, message: WsServerMessage): void {
  socket.send(JSON.stringify(message));
}

export interface ProgressPlugin {
  hub: ProgressHub;
  close: () => Promise<void>;
}

export interface ProgressOptions {
  /**
   * Whether to open the Redis subscription that carries worker events. The
   * route and the hub exist either way, so the test suite can drive the hub
   * directly without holding a blocking connection open.
   */
  subscribe?: boolean;
}

export function registerProgressSocket(
  app: FastifyInstance,
  log: FastifyBaseLogger,
  options: ProgressOptions = {},
): ProgressPlugin {
  const hub = new ProgressHub();

  // A dedicated connection: a subscribed ioredis client cannot run ordinary
  // commands, so it must not be the one the queues share.
  const subscriber = options.subscribe === false ? null : redis().duplicate();
  if (subscriber) {
    void subscriber.subscribe(PROGRESS_CHANNEL).catch((err: unknown) => {
      log.error({ err }, 'failed to subscribe to the progress channel');
    });
    subscriber.on('message', (_channel: string, raw: string) => {
      try {
        hub.deliver(JSON.parse(raw) as IngestProgressEvent);
      } catch (err) {
        log.warn({ err }, 'malformed progress event discarded');
      }
    });
  }

  app.get('/ws', { websocket: true }, (rawSocket, request) => {
    const socket = rawSocket as unknown as ProgressSocket;

    // Browsers cannot set an Authorization header on a WebSocket handshake,
    // so the token arrives as a query parameter.
    const token = (request.query as { token?: string } | undefined)?.token;
    try {
      app.jwt.verify(token ?? '');
    } catch {
      // Closed only once the rejection frame has actually been flushed:
      // closing straight after send() discards it, and the client is left
      // guessing why the socket went away.
      socket.send(
        JSON.stringify({
          type: 'error',
          message: 'A valid token query parameter is required.',
        } satisfies WsServerMessage),
        () => socket.close(CLOSE_UNAUTHORIZED, 'unauthorized'),
      );
      return;
    }

    socket.on('message', ((raw: Buffer | string) => {
      let message: WsClientMessage;
      try {
        message = JSON.parse(raw.toString()) as WsClientMessage;
      } catch {
        send(socket, { type: 'error', message: 'Expected a JSON frame.' });
        return;
      }

      switch (message.type) {
        case 'subscribe':
          // Only paper channels exist; anything else would be a client
          // guessing at an internal namespace.
          if (!/^paper:\d+$/.test(message.channel)) {
            send(socket, { type: 'error', message: `Unknown channel ${message.channel}.` });
            return;
          }
          hub.subscribe(message.channel, socket);
          send(socket, { type: 'subscribed', channel: message.channel });
          return;
        case 'unsubscribe':
          hub.unsubscribe(message.channel, socket);
          send(socket, { type: 'unsubscribed', channel: message.channel });
          return;
        case 'ping':
          send(socket, { type: 'pong' });
          return;
        default:
          send(socket, { type: 'error', message: 'Unknown frame type.' });
      }
    }) as (...args: never[]) => void);

    socket.on('close', (() => hub.remove(socket)) as (...args: never[]) => void);
    socket.on('error', (() => hub.remove(socket)) as (...args: never[]) => void);
  });

  return {
    hub,
    close: async () => {
      if (!subscriber) return;
      await subscriber.unsubscribe(PROGRESS_CHANNEL).catch(() => undefined);
      subscriber.disconnect();
    },
  };
}
