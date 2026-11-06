/**
 * The kinds of model call MALT makes, each with its own provider, model and effort. Shared by the extension (settings and
 * the tray), the reviewer manager (which passes them to the reviewer as environment variables) and the reviewer
 * (which uses them per call). Values are validated on both sides; invalid ones fall back to the defaults.
 */
export type ReviewType = 'overview' | 'check' | 'consolidation' | 'standards' | 'investigation';

/**
 * Who answers a call. `claude` runs the Claude Code CLI inside the reviewer; `copilot` is GitHub Copilot through VS
 * Code's Language Model API, so the reviewer delegates those calls to the extension (`DelegatingProvider`).
 */
export type ProviderId = 'claude' | 'copilot';
export const PROVIDERS: readonly ProviderId[] = ['claude', 'copilot'];
export const PROVIDER_LABELS: Readonly<Record<ProviderId, string>> = { claude: 'Claude', copilot: 'GitHub Copilot' };
export const isProviderId = (value: unknown): value is ProviderId => PROVIDERS.some((provider) => provider === value);
/** Providers whose calls the extension makes, not the reviewer. */
export const isDelegated = (provider: ProviderId): boolean => provider !== 'claude';
/** Copilot's model when none is set: the first model Copilot offers. */
export const COPILOT_AUTO_MODEL = 'auto';
/** Whether a provider takes a reasoning effort; Copilot's Language Model API has none. */
export const takesEffort = (provider: ProviderId): boolean => provider === 'claude';

/** `default` passes no effort flag, leaving the CLI's built-in default. */
export type Effort = 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface CallProfile {
  readonly provider: ProviderId;
  readonly model: string;
  readonly effort: Effort;
}

export type ReviewProfiles = Readonly<Record<ReviewType, CallProfile>>;

export interface ReviewTypeInfo {
  readonly label: string;
  /** What the calls are and how many there are, for the tray and settings. */
  readonly detail: string;
  /** Setting keys under `malt.`. The provider setting is machine-scoped: a repository must not choose who sees its code. */
  readonly providerSetting: string;
  /** Claude's model (workspace-overridable, as before). */
  readonly modelSetting: string;
  /**
   * Copilot's model, machine-scoped like the provider. Each provider keeps its own model, so switching provider in
   * one workspace never leaves another with a model the provider doesn't have.
   */
  readonly copilotModelSetting: string;
  readonly effortSetting: string;
  readonly defaults: CallProfile;
}

export const REVIEW_TYPES: readonly ReviewType[] = ['overview', 'check', 'consolidation', 'standards', 'investigation'];

export const EFFORTS: readonly Effort[] = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Defaults favour low usage: rule checks (most calls) are narrow yes/no questions on a small block, so they run on
 * Haiku at low effort; the overview and consolidation need judgment, so Sonnet at low effort; the rare standards
 * scan reads the whole project, so Opus at medium effort; a gap investigation (on request) weighs real code, so
 * Sonnet at medium effort.
 */
export const REVIEW_TYPE_INFO: Readonly<Record<ReviewType, ReviewTypeInfo>> = {
  overview: {
    label: 'Block overview',
    detail: 'What each changed block does, why, and which rules apply. One call per block.',
    providerSetting: 'reviewer.triageProvider',
    modelSetting: 'reviewer.triageModel',
    copilotModelSetting: 'reviewer.triageCopilotModel',
    effortSetting: 'reviewer.triageEffort',
    defaults: { provider: 'claude', model: 'sonnet', effort: 'low' },
  },
  check: {
    label: 'Rule checks',
    detail: 'One call per applicable rule per block. Most of MALT’s usage.',
    providerSetting: 'reviewer.reviewProvider',
    modelSetting: 'reviewer.reviewModel',
    copilotModelSetting: 'reviewer.reviewCopilotModel',
    effortSetting: 'reviewer.reviewEffort',
    defaults: { provider: 'claude', model: 'haiku', effort: 'low' },
  },
  consolidation: {
    label: 'Consolidation',
    detail: 'One call across the whole change, after new files stop appearing.',
    providerSetting: 'reviewer.consolidationProvider',
    modelSetting: 'reviewer.consolidationModel',
    copilotModelSetting: 'reviewer.consolidationCopilotModel',
    effortSetting: 'reviewer.consolidationEffort',
    defaults: { provider: 'claude', model: 'sonnet', effort: 'low' },
  },
  standards: {
    label: 'Standards scan',
    detail: 'Three calls, only when you run Scan Project Standards.',
    providerSetting: 'reviewer.standardsProvider',
    modelSetting: 'reviewer.standardsModel',
    copilotModelSetting: 'reviewer.standardsCopilotModel',
    effortSetting: 'reviewer.standardsEffort',
    defaults: { provider: 'claude', model: 'opus', effort: 'medium' },
  },
  investigation: {
    label: 'Gap investigation',
    detail: 'Reads the real code behind one standards gap and decides if it is real. Only when you ask.',
    providerSetting: 'reviewer.investigationProvider',
    modelSetting: 'reviewer.investigationModel',
    copilotModelSetting: 'reviewer.investigationCopilotModel',
    effortSetting: 'reviewer.investigationEffort',
    defaults: { provider: 'claude', model: 'sonnet', effort: 'medium' },
  },
};

/** A model alias (`haiku`) or full id (`claude-sonnet-5-5`, `claude-opus-5-5[1m]`); never anything flag-like. */
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/u;

export const isModelName = (value: unknown): value is string => typeof value === 'string' && MODEL.test(value);

export const isEffort = (value: unknown): value is Effort => EFFORTS.some((effort) => effort === value);

/**
 * A profile from untrusted values (settings or environment); each invalid field falls back to its default. A model
 * name only means something to the provider it was chosen for, so an invalid provider resets the model too: a
 * Copilot model id must never be sent to Claude, or the reverse.
 */
export const profileFrom = (type: ReviewType, model: unknown, effort: unknown, provider: unknown = 'claude'): CallProfile => {
  const { defaults } = REVIEW_TYPE_INFO[type];
  const known = isProviderId(provider);
  const fallback = known && provider === 'copilot' ? COPILOT_AUTO_MODEL : defaults.model;
  return {
    provider: known ? provider : defaults.provider,
    model: known && isModelName(model) ? model : fallback,
    effort: isEffort(effort) ? effort : defaults.effort,
  };
};

const envKey = (kind: 'PROVIDER' | 'MODEL' | 'EFFORT', type: ReviewType): string => `MALT_${kind}_${type.toUpperCase()}`;

/** Environment variables carrying the profiles from the extension to the reviewer process or container. */
export const profilesToEnv = (profiles: ReviewProfiles): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const type of REVIEW_TYPES) {
    env[envKey('PROVIDER', type)] = profiles[type].provider;
    env[envKey('MODEL', type)] = profiles[type].model;
    env[envKey('EFFORT', type)] = profiles[type].effort;
  }
  return env;
};

export const profilesFromEnv = (env: Readonly<Record<string, string | undefined>>): ReviewProfiles => {
  const read = (type: ReviewType): CallProfile => profileFrom(type, env[envKey('MODEL', type)], env[envKey('EFFORT', type)], env[envKey('PROVIDER', type)]);
  return { overview: read('overview'), check: read('check'), consolidation: read('consolidation'), standards: read('standards'), investigation: read('investigation') };
};

/** "sonnet · low effort" for Claude (as before); other providers are named, and show no effort when they take none. */
export const describeProfile = ({ provider, model, effort }: CallProfile): string => {
  const prefix = provider === 'claude' ? '' : `${PROVIDER_LABELS[provider]} · `;
  if (!takesEffort(provider)) {
    return `${prefix}${model}`;
  }
  return `${prefix}${model} · ${effort === 'default' ? 'default effort' : `${effort} effort`}`;
};
