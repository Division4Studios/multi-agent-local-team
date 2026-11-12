/** Original synthetic Docker Engine HTTP responses, independent of the gateway implementation. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRecord } from '../../shared/guards';
import { healthValue } from './awsData';
import { bounded, httpFixture, replyJson } from './awsHttpFixture';
import type { CapturedRequest, HttpFixture } from './awsHttpFixture';

export interface CreatedContainer {
  readonly id: string;
  readonly name: string;
  readonly spec: Record<string, unknown>;
  running: boolean;
}

export class DockerFixture {
  public readonly requests: CapturedRequest[] = [];
  public readonly containers: CreatedContainer[] = [];
  public readonly foreignContainers: CreatedContainer[] = [];
  public readonly builds: Buffer[] = [];
  public readonly events: string[] = [];
  public readonly root: string;
  public readonly socketPath: string;
  public readonly admin: HttpFixture;
  public failStart = false;
  public failRemove = false;
  public conflict = false;
  public operatingSystem = 'Docker Desktop';
  public conflictLabels: (spec: Record<string, unknown>) => Readonly<Record<string, string>> = () => ({
    'dev.malt.role': 'other-service', 'dev.malt.workspace': 'other-workspace',
  });
  private readonly server: Server;
  private readonly failures: unknown[] = [];
  private readonly existing = new Map<string, CreatedContainer>();
  private readonly pending: Promise<unknown>[] = [];

  public constructor(root: string, admin: HttpFixture) {
    this.root = root;
    this.admin = admin;
    this.socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\malt-aws-test-${randomUUID()}` : join(root, 'engine.sock');
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      request.on('error', () => { response.destroy(); });
      request.on('end', () => {
        const captured = { method: request.method ?? '', url: request.url ?? '', headers: request.headers, body: Buffer.concat(chunks) };
        this.requests.push(captured);
        try {
          this.reply(captured, response);
        } catch (error: unknown) {
          this.failures.push(error);
          response.destroy();
        }
      });
    });
  }

  public async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.socketPath, resolve);
    });
  }

  public find(target: string): CreatedContainer | undefined {
    return [...this.existing.values()].find(container => container.id === target || container.name === target);
  }

  public async track<T>(operation: Promise<T>): Promise<T> {
    this.pending.push(Promise.allSettled([operation]));
    return await bounded(operation);
  }

  public runtimeShutdown(): void {
    this.events.push('admin:shutdown');
    for (const container of this.containers) { container.running = false; }
  }

  public async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      this.server.close(error => {
        if (error === undefined) { resolve(); } else { reject(error); }
      });
    });
    await this.admin.close();
    await bounded(Promise.all(this.pending));
    await rm(this.root, { recursive: true, force: true });
    assert.deepEqual(this.failures, [], 'synthetic Engine handler must not fail');
  }

  private reply(request: CapturedRequest, response: ServerResponse): void {
    const url = new URL(request.url, 'http://docker.invalid');
    const path = decodeURIComponent(url.pathname.replace(/^\/v\d+\.\d+/u, ''));
    if (path.startsWith('/containers')) {
      this.containerReply(request, response, path, url.searchParams);
      return;
    }
    if (path === '/build') {
      if (!method(request, response, 'POST')) { return; }
      this.builds.push(request.body);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"stream":"Successfully built synthetic image\\n"}\n{"aux":{"ID":"sha256:synthetic"}}\n');
      return;
    }
    const bodies: Readonly<Record<string, unknown>> = {
      '/info': { OperatingSystem: this.operatingSystem, OSType: 'linux', SecurityOptions: ['name=seccomp,profile=builtin'], ServerVersion: '28.0.0' },
      '/version': { ApiVersion: '1.48', MinAPIVersion: '1.24', Os: 'linux' },
    };
    if (path === '/_ping' && request.method === 'HEAD') { response.writeHead(200).end(); return; }
    if (!method(request, response, 'GET')) { return; }
    if (path === '/_ping') {
      response.end('OK');
    } else {
      replyJson(response, bodies[path] ?? { message: 'No such image or route' }, bodies[path] === undefined ? 404 : 200);
    }
  }

  private containerReply(request: CapturedRequest, response: ServerResponse, path: string, query: URLSearchParams): void {
    if (path === '/containers/create') {
      if (method(request, response, 'POST')) { this.create(request, response, query.get('name') ?? ''); }
      return;
    }
    if (path === '/containers/json') {
      if (method(request, response, 'GET')) { this.list(response, query); }
      return;
    }
    this.containerAction(request, response, path, query);
  }

  private containerAction(request: CapturedRequest, response: ServerResponse, path: string, query: URLSearchParams): void {
    const match = /^\/containers\/([^/]+)(?:\/(json|start|stop))?$/u.exec(path);
    if (match === null) { replyJson(response, { message: 'Unknown route' }, 404); return; }
    const target = match[1] ?? '';
    const action = match[2] ?? 'remove';
    const verb = action === 'json' ? 'GET' : action === 'remove' ? 'DELETE' : 'POST';
    if (!method(request, response, verb)) { return; }
    const container = this.find(target);
    if (container === undefined) { replyJson(response, { message: 'No such container' }, 404); return; }
    this.action(response, container, action, query);
  }

  private list(response: ServerResponse, query: URLSearchParams): void {
    const all = query.get('all') === '1' || query.get('all') === 'true';
    replyJson(response, [...this.existing.values()].filter(container => all || container.running).map(container => ({
      Id: container.id, Names: [`/${container.name}`], Labels: container.spec['Labels'], State: container.running ? 'running' : 'exited',
    })));
  }

  private action(response: ServerResponse, container: CreatedContainer, action: string, query: URLSearchParams): void {
    if (action === 'json') {
      replyJson(response, { Id: container.id, Name: `/${container.name}`, Config: container.spec, State: { Running: container.running } });
      return;
    }
    if (action === 'remove') { this.remove(response, container, query); return; }
    this.events.push(`${action}:${container.id}`);
    if (action === 'start' && this.failStart) { replyJson(response, { message: 'Start failed' }, 500); return; }
    const running = action === 'start';
    const status = container.running === running ? 304 : 204;
    container.running = running;
    response.writeHead(status).end();
  }

  private remove(response: ServerResponse, container: CreatedContainer, query: URLSearchParams): void {
    this.events.push(`remove:${container.id}`);
    if (this.failRemove) { replyJson(response, { message: 'Removal failed' }, 500); return; }
    if (container.running && query.get('force') !== '1' && query.get('force') !== 'true') {
      replyJson(response, { message: 'Cannot remove a running container without force' }, 409);
      return;
    }
    this.existing.delete(container.id);
    response.writeHead(204).end();
  }

  private create(request: CapturedRequest, response: ServerResponse, name: string): void {
    const spec: unknown = JSON.parse(request.body.toString('utf8'));
    assert.ok(isRecord(spec));
    if (this.conflict) {
      this.conflict = false;
      const foreign = { id: `foreign-${String(this.foreignContainers.length + 1)}`, name, spec: { ...spec, Labels: this.conflictLabels(spec) }, running: true };
      this.foreignContainers.push(foreign);
      this.existing.set(foreign.id, foreign);
    }
    if (this.find(name) !== undefined) {
      replyJson(response, { message: 'Conflict: name already in use' }, 409);
      return;
    }
    const id = `task5-owned-${String(this.containers.length + 1)}`;
    const container = { id, name, spec, running: false };
    this.containers.push(container);
    this.existing.set(id, container);
    replyJson(response, { Id: id, Warnings: [] }, 201);
  }
}

const method = (request: CapturedRequest, response: ServerResponse, expected: string): boolean => {
  if (request.method === expected) { return true; }
  replyJson(response, { message: 'Method not allowed' }, 405);
  return false;
};

export const dockerFixture = async (): Promise<DockerFixture> => {
  const admin = await httpFixture((request, response) => {
    if (request.url === '/shutdown') {
      fixture.runtimeShutdown();
      replyJson(response, { stopping: true });
    } else if (request.url === '/save') {
      replyJson(response, { saved: true });
    } else {
      replyJson(response, healthValue());
    }
  });
  const fixture = new DockerFixture(await mkdtemp(join(tmpdir(), 'malt-aws-engine-')), admin);
  await fixture.listen();
  return fixture;
};

export const tarEntries = (tar: Buffer): Map<string, Buffer> => {
  const entries = new Map<string, Buffer>();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const name = tar.toString('utf8', offset, offset + 100).replace(/\0.*$/su, '');
    if (name === '') {
      break;
    }
    const prefix = tar.toString('utf8', offset + 345, offset + 500).replace(/\0.*$/su, '');
    const size = Number.parseInt(tar.toString('ascii', offset + 124, offset + 136).replace(/\0.*$/su, '').trim(), 8);
    assert.ok(Number.isSafeInteger(size) && size >= 0);
    assert.ok(offset + 512 + size <= tar.length);
    const path = prefix === '' ? name : `${prefix}/${name}`;
    assert.ok(!entries.has(path), 'the explicit context must not contain duplicate paths');
    entries.set(path, tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
};
