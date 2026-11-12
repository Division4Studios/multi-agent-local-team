import type { AwsQueueResource } from '../../../shared/aws/types';
import type { QueueStore } from './types';
import { queueUrl } from './validation';

export const queueResources = (store: QueueStore, endpoint: string, now: number): readonly AwsQueueResource[] =>
  [...store.values()].flatMap(({ scope, queues }) => [...queues.values()].map(queue => {
    const messageCounts = { available: 0, delayed: 0, inFlight: 0 };
    for (const message of queue.messages) {
      if (message.expiresAt <= now) { continue; }
      if (message.availableAt <= now) { messageCounts.available += 1; }
      else if (message.receiveCount === 0) { messageCounts.delayed += 1; }
      else { messageCounts.inFlight += 1; }
    }
    return { service: 'sqs', ...scope, type: 'queue', name: queue.name,
      id: `arn:aws:sqs:${scope.region}:${scope.account}:${queue.name}`,
      details: { queueUrl: queueUrl(endpoint, scope, queue.name), attributes: { ...queue.attributes }, messageCounts } };
  }));
