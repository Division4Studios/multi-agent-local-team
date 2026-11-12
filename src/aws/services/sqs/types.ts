import type { AccountRegion } from '../types';
import type { QueueAttributes } from '../../../shared/aws/types';
export interface MessageState {
  readonly id: string;
  readonly body: string;
  readonly sentAt: number;
  availableAt: number;
  readonly expiresAt: number;
  receiveCount: number;
  firstReceivedAt?: number;
  currentReceipt?: string;
  readonly oldReceipts: string[];
}
export interface QueueState {
  readonly name: string;
  readonly attributes: QueueAttributes;
  messages: MessageState[];
}
export interface ScopedQueues { readonly scope: AccountRegion; readonly queues: Map<string, QueueState> }
export type QueueStore = Map<string, ScopedQueues>;
