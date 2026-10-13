import { config } from '../config';
import { db } from '../db';
import { BOT_MODELS, BUILD_ENGINES, DEFAULT_SCORE_WEIGHTS, type BotModel, type BuildEngine, type FactorySettings } from './types';

const SETTINGS_KEY = 'factory_settings';

// Env-provided values are locked (not editable from the UI); everything else is a default.
const ENV_LOCKED = new Set(
  ['FACTORY_CONCURRENCY', 'FACTORY_LAUNCH_STAGGER_SEC', 'FACTORY_INACTIVITY_TIMEOUT_MIN', 'FACTORY_CLONE_TIMEOUT_MIN', 'FACTORY_FIX_TIMEOUT_MIN', 'FACTORY_QA_TIMEOUT_MIN']
    .filter((name) => Boolean(process.env[name]?.trim())),
);

/** THEMEBOT_BUILD_ENGINE=themebot|claude-code picks the engine for every build (and locks the setting). */
export function envBuildEngine(env: NodeJS.ProcessEnv = process.env): BuildEngine | null {
  const value = env.THEMEBOT_BUILD_ENGINE?.trim().toLowerCase();
  return BUILD_ENGINES.includes(value as BuildEngine) ? value as BuildEngine : null;
}
/** THEMEBOT_ENGINE_BUDGET_USD=<dollars> sets the per-build cap (and locks the setting). */
export function envEngineBudget(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.THEMEBOT_ENGINE_BUDGET_USD?.trim();
  const value = raw ? Number(raw) : NaN;
  return Number.isFinite(value) && value >= 0 ? Math.min(value, MAX_ENGINE_BUDGET_USD) : null;
}
export const DEFAULT_ENGINE_BUDGET_USD = 25;
const MAX_ENGINE_BUDGET_USD = 2000;

export function factoryDefaults(): FactorySettings {
  return {
    buildEngine: 'claude-code',
    engineBudgetUsd: DEFAULT_ENGINE_BUDGET_USD,
    cloneModel: 'opus',
    collectorModel: 'opus',
    concurrency: config.factory.defaultConcurrency,
    pageConcurrency: 2,
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
  buildEngine: envBuildEngine() !== null,
  engineBudgetUsd: envEngineBudget() !== null,
});

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function sanitizeSettings(input: Partial<FactorySettings>, base: FactorySettings): FactorySettings {
  const next = { ...base, ...input };
  next.buildEngine = BUILD_ENGINES.includes(next.buildEngine) ? next.buildEngine : base.buildEngine;
  const budget = Number(next.engineBudgetUsd);
  next.engineBudgetUsd = Number.isFinite(budget) ? clamp(Math.round(budget * 100) / 100, 0, MAX_ENGINE_BUDGET_USD) : base.engineBudgetUsd;
  const model = (value: unknown, fallback: BotModel): BotModel => BOT_MODELS.includes(value as BotModel) ? value as BotModel : fallback;
  next.cloneModel = model(next.cloneModel, base.cloneModel);
  next.collectorModel = model(next.collectorModel, base.collectorModel);
  next.concurrency = clamp(Math.round(next.concurrency), 1, 5);
  next.pageConcurrency = clamp(Math.round(Number(next.pageConcurrency) || base.pageConcurrency), 1, 4);
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

async function storedSettings(): Promise<FactorySettings> {
  const stored = await db.getSetting(SETTINGS_KEY) as Partial<FactorySettings> | null;
  return sanitizeSettings(stored ?? {}, factoryDefaults());
}

/** Env choices for the build engine win over what was saved (the UI shows them as locked). They are
 *  applied on read only, so a temporary env var is never written into the saved settings. */
function withEnvOverrides(settings: FactorySettings): FactorySettings {
  const engine = envBuildEngine();
  const budget = envEngineBudget();
  return { ...settings, ...(engine ? { buildEngine: engine } : {}), ...(budget !== null ? { engineBudgetUsd: budget } : {}) };
}

export async function getFactorySettings(): Promise<FactorySettings> {
  return withEnvOverrides(await storedSettings());
}

export async function updateFactorySettings(patch: Partial<FactorySettings>): Promise<FactorySettings> {
  const current = await storedSettings();
  const locked = lockedFields();
  for (const [field, isLocked] of Object.entries(locked)) if (isLocked) delete (patch as Record<string, unknown>)[field];
  const next = sanitizeSettings(patch, current);
  await db.setSetting(SETTINGS_KEY, next);
  return withEnvOverrides(next);
}
