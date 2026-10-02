import { config } from '../config';
import { db } from '../db';
import { BOT_MODELS, DEFAULT_SCORE_WEIGHTS, type BotModel, type FactorySettings } from './types';

const SETTINGS_KEY = 'factory_settings';

// Env-provided values are locked (not editable from the UI); everything else is a default.
const ENV_LOCKED = new Set(
  ['FACTORY_CONCURRENCY', 'FACTORY_LAUNCH_STAGGER_SEC', 'FACTORY_INACTIVITY_TIMEOUT_MIN', 'FACTORY_CLONE_TIMEOUT_MIN', 'FACTORY_FIX_TIMEOUT_MIN', 'FACTORY_QA_TIMEOUT_MIN']
    .filter((name) => Boolean(process.env[name]?.trim())),
);

export function factoryDefaults(): FactorySettings {
  return {
    cloneModel: 'opus',
    collectorModel: 'opus',
    concurrency: config.factory.defaultConcurrency,
    launchStaggerSec: config.factory.launchStaggerSec,
    inactivityTimeoutMin: config.factory.inactivityTimeoutMin,
    cloneTimeoutMin: config.factory.cloneTimeoutMin,
    fixTimeoutMin: config.factory.fixTimeoutMin,
    qaTimeoutMin: config.factory.qaTimeoutMin,
    defaultMaxIterations: 5,
    defaultScoreThreshold: 0.92,
    scoreWeights: { ...DEFAULT_SCORE_WEIGHTS },
    noProgressEpsilon: 0.01,
    earlyStopOnNoProgress: true,
    pauseQueueOnUsageLimit: true,
    keepIterations: 3,
    secretScrub: true,
    extraAllow: [],
    browserQaSetup: { done: false, doneAt: null },
  };
}

export const lockedFields = () => ({
  concurrency: ENV_LOCKED.has('FACTORY_CONCURRENCY'),
  launchStaggerSec: ENV_LOCKED.has('FACTORY_LAUNCH_STAGGER_SEC'),
  inactivityTimeoutMin: ENV_LOCKED.has('FACTORY_INACTIVITY_TIMEOUT_MIN'),
  cloneTimeoutMin: ENV_LOCKED.has('FACTORY_CLONE_TIMEOUT_MIN'),
  fixTimeoutMin: ENV_LOCKED.has('FACTORY_FIX_TIMEOUT_MIN'),
  qaTimeoutMin: ENV_LOCKED.has('FACTORY_QA_TIMEOUT_MIN'),
});

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function sanitizeSettings(input: Partial<FactorySettings>, base: FactorySettings): FactorySettings {
  const next = { ...base, ...input };
  const model = (value: unknown, fallback: BotModel): BotModel => BOT_MODELS.includes(value as BotModel) ? value as BotModel : fallback;
  next.cloneModel = model(next.cloneModel, base.cloneModel);
  next.collectorModel = model(next.collectorModel, base.collectorModel);
  next.concurrency = clamp(Math.round(next.concurrency), 1, 5);
  next.launchStaggerSec = clamp(next.launchStaggerSec, 0, 600);
  next.inactivityTimeoutMin = clamp(next.inactivityTimeoutMin, 5, 120);
  next.cloneTimeoutMin = clamp(next.cloneTimeoutMin, 30, 720);
  next.fixTimeoutMin = clamp(next.fixTimeoutMin, 10, 240);
  next.qaTimeoutMin = clamp(next.qaTimeoutMin, 5, 120);
  next.defaultMaxIterations = clamp(Math.round(next.defaultMaxIterations), 1, 10);
  next.defaultScoreThreshold = clamp(next.defaultScoreThreshold, 0.5, 1);
  next.noProgressEpsilon = clamp(next.noProgressEpsilon, 0, 0.2);
  next.keepIterations = clamp(Math.round(next.keepIterations), 1, 20);
  const weights = { ...DEFAULT_SCORE_WEIGHTS, ...next.scoreWeights };
  const total = weights.presence + weights.text + weights.interaction || 1;
  next.scoreWeights = { presence: weights.presence / total, text: weights.text / total, interaction: weights.interaction / total };
  next.extraAllow = (next.extraAllow ?? []).filter((entry) => typeof entry === 'string' && entry.length < 200).slice(0, 20);
  // Coerce booleans — a persisted JSON string "false" would otherwise read as truthy.
  const bool = (value: unknown, fallback: boolean) => typeof value === 'boolean' ? value : typeof value === 'string' ? value === 'true' : fallback;
  next.earlyStopOnNoProgress = bool(next.earlyStopOnNoProgress, base.earlyStopOnNoProgress);
  next.pauseQueueOnUsageLimit = bool(next.pauseQueueOnUsageLimit, base.pauseQueueOnUsageLimit);
  next.secretScrub = bool(next.secretScrub, base.secretScrub);
  const setup = (next.browserQaSetup ?? base.browserQaSetup) as Partial<FactorySettings['browserQaSetup']> | undefined;
  next.browserQaSetup = { done: bool(setup?.done, false), doneAt: typeof setup?.doneAt === 'string' ? setup.doneAt.slice(0, 40) : null };
  return next;
}

export async function getFactorySettings(): Promise<FactorySettings> {
  const stored = await db.getSetting(SETTINGS_KEY) as Partial<FactorySettings> | null;
  return sanitizeSettings(stored ?? {}, factoryDefaults());
}

export async function updateFactorySettings(patch: Partial<FactorySettings>): Promise<FactorySettings> {
  const current = await getFactorySettings();
  const locked = lockedFields();
  for (const [field, isLocked] of Object.entries(locked)) if (isLocked) delete (patch as Record<string, unknown>)[field];
  const next = sanitizeSettings(patch, current);
  await db.setSetting(SETTINGS_KEY, next);
  return next;
}
