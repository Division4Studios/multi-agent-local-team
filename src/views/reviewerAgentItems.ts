/** Text labels accompany status colors for accessibility and high-contrast themes. */
import * as vscode from 'vscode';
import { agentsHealth } from '../shared/reviewerAgents';
import type { AgentHealth, AgentState, ReviewerAgent } from '../shared/reviewerAgents';

const ICONS: Readonly<Record<AgentState, vscode.ThemeIcon>> = {
  idle: new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('disabledForeground')),
  stopped: new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground')),
  working: new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('malt.hunkPass')),
  warning: new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground')),
  error: new vscode.ThemeIcon('error', new vscode.ThemeColor('malt.hunkFail')),
};
const HEALTH_ICONS: Readonly<Record<AgentHealth, vscode.ThemeIcon>> = {
  green: new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('malt.hunkPass')),
  yellow: ICONS.warning,
  red: ICONS.error,
};
const HEALTH_WORDS = { green: 'healthy', yellow: 'needs attention', red: 'all agents failed' };

export const reviewerAgentItem = (agent: ReviewerAgent): vscode.TreeItem => {
  const item = new vscode.TreeItem(`Agent ${String(agent.number)}`);
  item.id = `reviewer-agent-${agent.id}`;
  item.description = agent.state === 'warning' ? 'waiting for activity' : agent.state;
  item.iconPath = ICONS[agent.state];
  item.contextValue = agent.state === 'stopped' ? 'reviewerAgentStopped' : agent.taskId === '' ? 'reviewerAgentIdle' : 'reviewerAgentWorking';
  item.tooltip = `Agent ${String(agent.number)}: ${item.description}${agent.label === '' ? '' : `\n${agent.label}`}\nRight-click for task controls and this agent's live log.`;
  item.command = { command: 'malt.showAgentLog', title: 'Show agent live stream log', arguments: [{ kind: 'agent', agent }] };
  return item;
};

export const reviewersHealthItem = (agents: readonly ReviewerAgent[], unavailable: boolean): vscode.TreeItem => {
  const health = unavailable ? 'yellow' : agentsHealth(agents);
  const item = new vscode.TreeItem('Reviewers health', vscode.TreeItemCollapsibleState.Expanded);
  item.id = 'reviewers-health';
  item.contextValue = 'reviewersHealth';
  item.description = unavailable ? 'status unavailable' : HEALTH_WORDS[health];
  item.iconPath = HEALTH_ICONS[health];
  item.tooltip = `${String(agents.length)} agents. Expand to inspect agents; right-click to add one. Idle agents are grey and do not degrade health.`;
  return item;
};
