/**
 * The kinds of model call MALT makes, each with its own model and effort. Shared by the extension (settings and
 * the tray), the reviewer manager (which passes them to the reviewer as environment variables) and the reviewer
 * (which uses them per call). Values are validated on both sides; invalid ones fall back to the defaults.
 */
export type ReviewType = 'overview' | 'check' | 'consolidation' | 'standards';

/** `default` passes no effort flag, leaving the CLI's built-in default. */
export type Effort = 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface CallProfile {
  readonly model: string;
  readonly effort: Effort;
}

export type ReviewProfiles = Readonly<Record<ReviewType, CallProfile>>;

export interface ReviewTypeInfo {
  readonly label: string;
  /** What the calls are and how many there are, for the tray and settings. */
  readonly detail: string;
  /** Setting keys under `malt.`. */
  readonly modelSetting: string;
  readonly effortSetting: string;
  readonly defaults: CallProfile;
}

export const REVIEW_TYPES: readonly ReviewType[] = ['overview', 'check', 'consolidation', 'standards'];

export const EFFORTS: readonly Effort[] = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Defaults favour low usage: rule checks (most calls) are narrow yes/no questions on a small block, so they run on
 * Haiku at low effort; the overview and consolidation need judgment, so Sonnet at low effort; the rare standards
 * scan reads the whole project, so Opus at medium effort.
 */
export const REVIEW_TYPE_INFO: Readonly<Record<ReviewType, ReviewTypeInfo>> = {
  overview: {
    label: 'Block overview',
    detail: 'What each changed block does, why, and which rules apply. One call per block.',
    modelSetting: 'reviewer.triageModel',
    effortSetting: 'reviewer.triageEffort',
    defaults: { model: 'sonnet', effort: 'low' },
  },
  check: {
    label: 'Rule checks',
    detail: 'One call per applicable rule per block. Most of MALT’s usage.',
    modelSetting: 'reviewer.reviewModel',
    effortSetting: 'reviewer.reviewEffort',
    defaults: { model: 'haiku', effort: 'low' },
  },
  consolidation: {
    label: 'Consolidation',
    detail: 'One call across the whole change, after new files stop appearing.',
    modelSetting: 'reviewer.consolidationModel',
    effortSetting: 'reviewer.consolidationEffort',
    defaults: { model: 'sonnet', effort: 'low' },
  },
  standards: {
    label: 'Standards scan',
    detail: 'Three calls, only when you run Scan Project Standards.',
    modelSetting: 'reviewer.standardsModel',
    effortSetting: 'reviewer.standardsEffort',
    defaults: { model: 'opus', effort: 'medium' },
  },
};

/** A model alias (`haiku`) or full id (`claude-sonnet-5-5`, `claude-opus-5-5[1m]`); never anything flag-like. */
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/u;

export const isModelName = (value: unknown): value is string => typeof value === 'string' && MODEL.test(value);

export const isEffort = (value: unknown): value is Effort => EFFORTS.some((effort) => effort === value);

/** A profile from untrusted values (settings or environment); each invalid field falls back to its default. */
export const profileFrom = (type: ReviewType, model: unknown, effort: unknown): CallProfile => {
  const { defaults } = REVIEW_TYPE_INFO[type];
  return { model: isModelName(model) ? model : defaults.model, effort: isEffort(effort) ? effort : defaults.effort };
};

const envKey = (kind: 'MODEL' | 'EFFORT', type: ReviewType): string => `MALT_${kind}_${type.toUpperCase()}`;

/** Environment variables carrying the profiles from the extension to the reviewer process or container. */
export const profilesToEnv = (profiles: ReviewProfiles): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const type of REVIEW_TYPES) {
    env[envKey('MODEL', type)] = profiles[type].model;
    env[envKey('EFFORT', type)] = profiles[type].effort;
  }
  return env;
};

export const profilesFromEnv = (env: Readonly<Record<string, string | undefined>>): ReviewProfiles => {
  const read = (type: ReviewType): CallProfile => profileFrom(type, env[envKey('MODEL', type)], env[envKey('EFFORT', type)]);
  return { overview: read('overview'), check: read('check'), consolidation: read('consolidation'), standards: read('standards') };
};

export const describeProfile = ({ model, effort }: CallProfile): string =>
  `${model} · ${effort === 'default' ? 'default effort' : `${effort} effort`}`;
