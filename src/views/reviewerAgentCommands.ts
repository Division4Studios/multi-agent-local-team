/** Agent commands accept only validated snapshots and use the observed task identity. */
import * as vscode from 'vscode';
import type { ReviewerManager } from '../backend/reviewerManager';
import { isRecord } from '../shared/guards';
import { parseReviewerAgent } from '../shared/reviewerAgents';
import type { AgentControl } from '../shared/reviewerAgents';
import { ConversationPanel } from './conversationPanel';

const ACTIONS: readonly AgentControl['action'][] = ['add', 'cancel', 'stop', 'start'];

export const registerAgentCommands = (manager: ReviewerManager, extensionUri: vscode.Uri, register: (id: string, handler: (...args: unknown[]) => unknown) => vscode.Disposable): vscode.Disposable => {
  const control = async (action: AgentControl['action'], argument: unknown): Promise<void> => {
    const agent = isRecord(argument) ? parseReviewerAgent(argument['agent']) : undefined;
    if (action !== 'add' && agent === undefined) { return; }
    try {
      if (action === 'add') { await manager.addAgent(); }
      else if (agent !== undefined) { await manager.agentMonitor.control({ action, id: agent.id, taskId: agent.taskId }); }
    } catch (error: unknown) {
      void vscode.window.showWarningMessage(`MALT: ${error instanceof Error ? error.message : 'Agent action failed'}`);
    }
  };
  return vscode.Disposable.from(
    ...ACTIONS.map((action) =>
      register(`malt.${action}ReviewerAgent`, async (argument: unknown) => { await control(action, argument); })),
    register('malt.showAgentLog', (argument: unknown) => {
      const agent = isRecord(argument) ? parseReviewerAgent(argument['agent']) : undefined;
      if (agent !== undefined && manager.agentMonitor.agents.some((current) => current.id === agent.id)) {
        ConversationPanel.show(manager, extensionUri, agent);
      }
    }),
  );
};
