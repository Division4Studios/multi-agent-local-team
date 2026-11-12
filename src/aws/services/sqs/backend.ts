import type { AwsQueueResource } from '../../../shared/aws/types';
import { scopeKey } from '../../../shared/aws/validation';
import { model } from '../../models/sqs';
import { unsupported } from '../../protocol/errors';
import { fields } from '../../protocol/values';
import { stateDocument } from '../state';
import { supportMap } from '../support';
import type { AccountRegion, CallContext, ParsedCall, ServiceBackend, StateDocument } from '../types';
import { deleteMessage, prune, sendMessage } from './messages';
import { Polls } from './polls';
import { createQueue, findQueue, getQueueUrl, missingQueue, scopedQueues } from './queues';
import { nextAvailability, receiveNow, receiveOptions } from './receive';
import { queueResources } from './resources';
import { copyQueue, parseQueues } from './state';
import type { QueueStore, ScopedQueues } from './types';
import { endpointOrigin } from './validation';

export interface SqsOptions { readonly endpoint: string; readonly now?: () => number }
const LIMITS: Readonly<Record<string, readonly string[]>> = {
  CreateQueue: ['Standard queues and five attributes only; creation readiness and recreation delays are accelerated.'],
  GetQueueUrl: ['Only same-account scoped queue lookup.'],
  DeleteQueue: ['Immediate local deletion; distributed deletion timing is not simulated.'],
  SendMessage: ['No FIFO, message attributes or system attributes; local UTF-8 payloads only.'],
  ReceiveMessage: ['Deterministic local ordering; AWS probabilistic sampling and distributed delivery are not simulated.'],
  DeleteMessage: ['Known old receipts succeed without deletion; distributed duplicate-after-delete behavior is not simulated.'],
};
export class SqsBackend implements ServiceBackend {
  public readonly service = 'sqs';
  public readonly operations = supportMap(model, LIMITS);
  private readonly endpoint: string;
  private readonly now: () => number;
  private readonly store: QueueStore = new Map();
  private readonly polls = new Polls();
  private closed = false;
  public constructor(options: SqsOptions) {
    this.endpoint = endpointOrigin(options.endpoint);
    this.now = options.now ?? Date.now;
  }
  public async handle(call: ParsedCall, context: CallContext): Promise<Readonly<Record<string, unknown>>> {
    if (!Object.hasOwn(LIMITS, call.operation)) { throw unsupported(this.service, call.operation); }
    const scope = scopedQueues(this.store, context);
    const result = call.operation === 'ReceiveMessage'
      ? await this.receive(scope, call.input) : this.immediate(scope, call);
    if (call.operation === 'CreateQueue') { this.store.set(scopeKey(scope.scope), scope); }
    if (call.operation !== 'GetQueueUrl') { context.emit({ kind: 'mutation' }); }
    return result;
  }
  private immediate(scope: ScopedQueues, call: ParsedCall): Readonly<Record<string, unknown>> {
    if (call.operation === 'CreateQueue') { return createQueue(scope, call.input, this.endpoint); }
    if (call.operation === 'GetQueueUrl') { return getQueueUrl(scope, call.input, this.endpoint); }
    const queue = findQueue(scope, call.input['QueueUrl'], this.endpoint);
    let result: Readonly<Record<string, unknown>> = {};
    if (call.operation === 'DeleteQueue') {
      fields(call.input, ['QueueUrl']);
      scope.queues.delete(queue.name);
    } else if (call.operation === 'SendMessage') { result = sendMessage(queue, call.input, this.now()); }
    else { result = deleteMessage(queue, call.input, this.now()); }
    this.polls.wake(queue);
    return result;
  }
  private async receive(scope: ScopedQueues, input: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>> {
    const queue = findQueue(scope, input['QueueUrl'], this.endpoint);
    const options = receiveOptions(queue, input);
    const deadline = Date.now() + options.wait * 1000;
    for (;;) {
      if (this.closed) { return {}; }
      if (scope.queues.get(queue.name) !== queue) { throw missingQueue(); }
      const result = receiveNow(queue, options, scope.scope.account, this.now());
      const remaining = deadline - Date.now();
      if (Object.hasOwn(result, 'Messages') || remaining <= 0) { return result; }
      await this.polls.wait(queue, nextAvailability(queue, this.now(), remaining));
    }
  }
  public exportState(scope: AccountRegion): StateDocument {
    const queues = [...(this.store.get(scopeKey(scope))?.queues.values() ?? [])];
    queues.forEach(queue => { prune(queue, this.now()); });
    return stateDocument(this.service, scope, { queues: queues.map(copyQueue) });
  }
  public importState(scope: AccountRegion, document: unknown): void {
    const queues = parseQueues(document, scope);
    this.reset(scope);
    this.store.set(scopeKey(scope), { scope: { account: scope.account, region: scope.region }, queues });
  }
  public reset(scope: AccountRegion | 'all'): void {
    const selected = scope === 'all' ? [...this.store.values()] : [this.store.get(scopeKey(scope))];
    for (const entry of selected) {
      if (entry === undefined) { continue; }
      const queues = [...entry.queues.values()];
      entry.queues.clear();
      queues.forEach(queue => { this.polls.wake(queue); });
      this.store.delete(scopeKey(entry.scope));
    }
  }
  public scopes(): readonly AccountRegion[] { return [...this.store.values()].map(entry => ({ ...entry.scope })); }
  public resources(): readonly AwsQueueResource[] { return queueResources(this.store, this.endpoint, this.now()); }
  public close(): void { this.closed = true; this.polls.close(); }
}
export const createSqsBackend = (options: SqsOptions): SqsBackend => new SqsBackend(options);
