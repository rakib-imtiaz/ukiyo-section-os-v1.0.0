// ThemeBot Cloud step engine (Phase 2): the build recipe lives here, in cloud/recipe, and leaves the
// Cloud one rendered step prompt at a time. Wire it in cloud/src/app.ts after the JSON body parser
// and before notFound:
//
//   registerStepRoutes(app, ctx);                                  // identity prompts
//   registerStepRoutes(app, ctx, { decoratePrompt: watermark });   // Phase 4: per-account marks
export { registerStepRoutes, stepsRouter, identityDecorator, type PromptContext, type PromptDecorator, type StepRouteOptions } from './routes';
export { loadRecipe, renderPlaceholders, placeholdersIn, type Recipe, type StepKind } from './recipe';
export { normalizePages, planSteps, decideNext, signalFor, slugForRoute, missingOutputs, MAX_TRIES, REQUIRED_OUTPUTS, type BuildPage } from './plan';
