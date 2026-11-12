import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { jsonResponse } from './responses';

type Handler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;
export class Listener {
  private handler: Handler | undefined;
  private readonly active = new Set<Promise<void>>();
  private readonly server = createServer((request, response) => {
    const handler = this.handler;
    if (handler === undefined) { request.resume(); jsonResponse(response, 503, { message: 'AWS runtime is not ready' }); return; }
    const pending = handler(request, response).catch(() => {
      if (!response.headersSent) { jsonResponse(response, 500, { message: 'Request failed' }); }
      else { response.destroy(); }
    }).finally(() => { this.active.delete(pending); });
    this.active.add(pending);
  });
  public setHandler(handler: Handler): void { this.handler = handler; }
  public async listen(host: string, port: number): Promise<string> {
    this.server.requestTimeout = 30000;
    this.server.headersTimeout = 10000;
    await new Promise<void>((resolve, reject) => {
      const failure = (error: Error): void => { reject(error); };
      this.server.once('error', failure);
      this.server.listen(port, host, () => { this.server.off('error', failure); resolve(); });
    });
    const address = this.server.address();
    if (address === null || typeof address === 'string') { throw new Error('Invalid AWS listener address'); }
    const hostname = host === '0.0.0.0' ? '127.0.0.1' : address.address;
    return `http://${hostname.includes(':') ? `[${hostname}]` : hostname}:${String(address.port)}`;
  }
  public async close(): Promise<void> {
    this.handler = undefined;
    if (this.server.listening) {
      const closing = new Promise<void>((resolve, reject) => { this.server.close(error => { if (error !== undefined) { reject(error); } else { resolve(); } }); });
      this.server.closeAllConnections();
      await closing;
    }
    await Promise.all(this.active);
  }
}
