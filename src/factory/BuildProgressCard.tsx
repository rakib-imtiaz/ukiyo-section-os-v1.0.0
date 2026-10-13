// Build progress — how much of the theme exists vs the plan, which step the build is on, how long
// it has run and roughly how long is left. Reads GET /jobs/:id/progress; page-by-page detail is
// tucked behind a toggle so the card stays small. ThemeBot Cloud builds also report their real step
// list (`steps` / `stepTotals`), shown behind its own toggle; other builds show what they always did.
import { useState } from 'react';
import { AlertCircle, CheckCircle2, ChevronDown, Clock, FileCode2, Layers, LayoutTemplate, MinusCircle } from 'lucide-react';
import { api, usePoll } from './api';
import type { BuildStepStatus } from './types';

const STEP_STATE: Record<BuildStepStatus, string> = { pending: 'to do', running: 'working on it', done: 'done', failed: 'will try again', skipped: 'skipped for now' };

function duration(ms: number) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function BuildProgressCard({ jobId, running }: { jobId: string; running: boolean }) {
  const { data } = usePoll(() => api.progress(jobId), running ? 8000 : 30000, [jobId]);
  const [open, setOpen] = useState(false);
  const [stepsOpen, setStepsOpen] = useState(false);
  if (!data) return null;

  const { totals, files, step } = data;
  const steps = data.steps?.length ? data.steps : null;
  const stepTotals = data.stepTotals ?? (steps ? { done: steps.filter((entry) => entry.status === 'done' || entry.status === 'skipped').length, total: steps.length } : null);
  // "4/11" from the server → "Step 4 of 11: …" when the Cloud's step list is known.
  const stepNumber = steps && step && /^\d+\/\d+$/.test(step.n) ? step.n.replace('/', ' of ') : null;
  const share = totals.sectionsPlanned ? totals.sectionsBuilt / totals.sectionsPlanned : 0;
  const fileCount = Object.values(files).reduce((sum, value) => sum + value, 0);
  const eta = data.etaMs === 0 ? 'All planned sections are built'
    : data.etaMs != null ? `About ${duration(data.etaMs)} left`
    : running ? 'Estimating time left…' : null;

  return (
    <div className="bp">
      <div className="bp-head">
        <div>
          <b>Build progress</b>
          <span>{running
            ? (step ? (stepNumber ? `Step ${stepNumber}: ${step.label}` : `Step: ${step.label}`) : stepTotals && stepTotals.total ? `${stepTotals.done} of ${stepTotals.total} steps done` : data.planned ? 'Working through the plan' : 'Planning the pages first')
            : share >= 1 ? 'Every planned section is written — run a check to see how well it matches'
            : data.planned ? `${totals.sectionsPlanned - totals.sectionsBuilt} sections still to write` : 'Not planned yet'}</span>
        </div>
        <strong title="Share of the planned sections that exist in the theme — not a quality score">{data.planned ? `${Math.round(share * 100)}%` : '—'}<small>written</small></strong>
      </div>

      <div className="bp-bar" aria-hidden><i style={{ width: `${Math.round(share * 100)}%` }} /></div>

      <div className="bp-stats">
        <div><LayoutTemplate /><span><b>{totals.pagesDone}<small>/{totals.pagesPlanned || '—'}</small></b>pages done</span></div>
        <div><Layers /><span><b>{totals.sectionsBuilt}<small>/{totals.sectionsPlanned || '—'}</small></b>sections</span></div>
        <div><FileCode2 /><span><b>{fileCount}</b>theme files</span></div>
        <div title="Time of the latest run — Rebuild starts the clock again"><Clock /><span><b>{duration(data.elapsedMs)}</b>{running ? (eta ?? 'so far') : `last run${eta && data.etaMs === 0 ? ' · all built' : ''}`}</span></div>
      </div>

      {steps && stepTotals && (
        <>
          <button type="button" className="bp-toggle" aria-expanded={stepsOpen} onClick={() => setStepsOpen((value) => !value)}>
            <ChevronDown className={stepsOpen ? 'is-open' : ''} /> {stepsOpen ? 'Hide steps' : `See all ${stepTotals.total} steps (${stepTotals.done} done)`}
          </button>
          {stepsOpen && (
            <ul className="bp-pages bp-steps">
              {steps.map((entry) => (
                <li key={entry.id} className={`is-${entry.status}`}>
                  {entry.status === 'done' ? <CheckCircle2 className="bp-pages__icon" />
                    : entry.status === 'failed' ? <AlertCircle className="bp-pages__icon bp-steps__warn" />
                    : entry.status === 'skipped' ? <MinusCircle className="bp-pages__icon bp-steps__muted" />
                    : <span className="bp-pages__dot" />}
                  <span className="bp-pages__name" title={entry.title}>{entry.title}</span>
                  <span className="bp-pages__count">{STEP_STATE[entry.status] ?? entry.status}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {data.pages.length > 0 && (
        <>
          <button type="button" className="bp-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            <ChevronDown className={open ? 'is-open' : ''} /> {open ? 'Hide pages' : `See all ${data.pages.length} pages`}
          </button>
          {open && (
            <ul className="bp-pages">
              {data.pages.map((page) => {
                const done = page.built >= page.planned;
                return (
                  <li key={page.route || page.name} className={done ? 'is-done' : page.hasTemplate ? 'is-started' : ''}>
                    {done ? <CheckCircle2 className="bp-pages__icon" /> : <span className="bp-pages__dot" />}
                    <span className="bp-pages__name">{page.name}</span>
                    <span className="bp-pages__bar"><i style={{ width: `${Math.round((page.built / page.planned) * 100)}%` }} /></span>
                    <span className="bp-pages__count">{page.built}/{page.planned}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
