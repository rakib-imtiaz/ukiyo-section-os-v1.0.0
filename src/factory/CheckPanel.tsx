// Match card + check controls. "Run check" compares the store's draft theme with the website (a
// scripted comparison — no AI, no tokens). "Fix differences" spends AI on what the last check
// found, then checks again. Before a check it makes sure the draft theme actually has the files
// on disk, so the score is about the real theme — uploads go to the unpublished draft theme only.
import { useEffect, useState } from 'react';
import { ChevronDown, CloudUpload, Loader2, ScanSearch, Square, Wand2 } from 'lucide-react';
import { DropdownMenu, useToast } from './ui';
import { ScoreRing } from './fx';
import { api } from './api';
import type { Job } from './types';

interface Sync { ok: boolean; error?: string; missing: string[]; changed: string[]; total: number }
interface FixCost { usd: number; minutes: number }

export function CheckPanel({ job, running, busy, onChanged }: { job: Job; running: boolean; busy: boolean; onChanged: () => void }) {
  const toast = useToast();
  const [sync, setSync] = useState<Sync | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [askUpload, setAskUpload] = useState(false);
  const [acting, setActing] = useState(false);
  const [fixCost, setFixCost] = useState<FixCost | null>(null);
  const checking = job.status === 'qa_running';
  const fixing = job.status === 'fixing';
  const idle = !running && !['draft', 'queued'].includes(job.status);
  const outOfDate = (sync?.missing.length ?? 0) + (sync?.changed.length ?? 0);

  // Draft-theme sync status whenever the build is resting.
  useEffect(() => {
    if (!idle) return;
    let alive = true;
    void api.syncStatus(job.id).then((value) => { if (alive) setSync(value); }).catch(() => {});
    return () => { alive = false; };
  }, [job.id, idle, job.status]);

  // What a fix round has cost so far (average of past fix sessions).
  useEffect(() => {
    void fetch('/api/factory/engines/usage').then((r) => r.json()).then((data: { entries: Array<{ type: string; kind?: string; costUsd?: number | null; estUsd?: number | null; durationMs?: number | null; sessionId?: string | null }> }) => {
      const fixes = new Map<string, { usd: number; ms: number }>();
      for (const entry of data.entries) {
        if (entry.type !== 'session' || !/^fix/.test(entry.kind ?? '')) continue;
        const key = entry.sessionId ?? String(Math.random());
        const row = fixes.get(key) ?? { usd: 0, ms: 0 };
        row.usd += entry.costUsd ?? entry.estUsd ?? 0; row.ms = Math.max(row.ms, entry.durationMs ?? 0);
        fixes.set(key, row);
      }
      if (fixes.size) {
        const list = [...fixes.values()];
        setFixCost({ usd: list.reduce((s, r) => s + r.usd, 0) / list.length, minutes: Math.max(1, Math.round(list.reduce((s, r) => s + r.ms, 0) / list.length / 60_000)) });
      }
    }).catch(() => {});
  }, []);

  const run = async (label: string, action: () => Promise<unknown>) => {
    if (acting) return;
    setActing(true);
    try { await action(); onChanged(); }
    catch (error) { toast.push({ title: `${label} failed`, detail: error instanceof Error ? error.message : undefined, variant: 'destructive' }); }
    finally { setActing(false); }
  };
  const upload = async () => {
    setSyncing(true);
    try {
      const result = await api.syncUpload(job.id);
      toast.push({ title: `Uploaded ${result.uploaded.length} file${result.uploaded.length === 1 ? '' : 's'} to the draft theme`, detail: result.failed.length ? `${result.failed.length} could not be uploaded — see factory/logs/sync.log` : undefined, variant: result.failed.length ? 'warning' : 'default' });
      setSync(await api.syncStatus(job.id, true));
      return result.failed.length === 0;
    } catch (error) {
      toast.push({ title: 'Upload failed', detail: error instanceof Error ? error.message : undefined, variant: 'destructive' });
      return false;
    } finally { setSyncing(false); }
  };
  const startCheck = () => run('Check', () => api.check(job.id));
  const onRunCheck = () => { if (outOfDate > 0) setAskUpload(true); else void startCheck(); };
  const fix = (rounds: number) => run('Fixing', () => api.fix(job.id, rounds));
  const costNote = (rounds: number) => fixCost ? ` · ~$${(fixCost.usd * rounds).toFixed(2)}, ~${fixCost.minutes * rounds} min` : '';

  const score = job.last_score;
  const status = checking ? 'Checking against your website…'
    : fixing ? (job.status_detail ?? 'Fixing differences…').replace(/ — fixing (\d+) issue\(s\)/, ' — $1 differences')
    : score == null ? 'Not checked yet — run a check to see how close it is'
    : score >= job.score_threshold ? `Good enough to move forward (goal ${Math.round(job.score_threshold * 100)}%)`
    : `Goal ${Math.round(job.score_threshold * 100)}% — ${Math.round((job.score_threshold - score) * 100)} points to go`;

  return (
    <div className="jd-match jd-match--check">
      <ScoreRing value={score ?? 0} size={64} stroke={6} />
      <div className="jd-match__text">
        <b>Match with your website</b>
        <span>{(checking || fixing) && <Loader2 className="jd-spin" />}{status}</span>
      </div>
      <div className="jd-match__bar"><i style={{ width: `${Math.round(Math.min(1, score ?? 0) * 100)}%` }} /></div>

      <div className="jd-check">
        {(checking || fixing) ? (
          <button type="button" className="jd-check__btn" disabled={busy} onClick={() => void run('Stop', () => api.pause(job.id))}><Square /> Stop</button>
        ) : (
          <>
            <button type="button" className="jd-check__btn jd-check__btn--primary" disabled={!idle || acting || syncing} onClick={onRunCheck} title="Compare the draft theme with your website — a scripted check, no AI cost">
              <ScanSearch /> Run check <small>free</small>
            </button>
            <DropdownMenu
              label="Fix differences"
              triggerClassName={`jd-check__btn${!idle || score == null ? ' is-disabled' : ''}`}
              trigger={<><Wand2 /> Fix differences <ChevronDown className="size-3.5" /></>}
              items={score == null || !idle ? [{ label: 'Run a check first — fixes work from its report', onSelect: () => undefined, disabled: true }] : [
                { label: `1 round${costNote(1)}`, title: 'One AI round on what the last check found, then check again', onSelect: () => void fix(1) },
                { label: `Up to 3 rounds (recommended)${costNote(3)}`, title: 'Check and fix until the goal, at most 3 rounds', onSelect: () => void fix(3) },
                { label: `Up to 5 rounds${costNote(5)}`, title: 'Check and fix until the goal, at most 5 rounds', onSelect: () => void fix(5) },
              ]}
            />
          </>
        )}
        {idle && sync?.ok && outOfDate > 0 && !askUpload && (
          <button type="button" className="jd-check__sync" disabled={syncing} onClick={() => void upload()} title={[...sync.missing, ...sync.changed].slice(0, 12).join('\n')}>
            {syncing ? <Loader2 className="jd-spin" /> : <CloudUpload />} {outOfDate} file{outOfDate === 1 ? '' : 's'} not on the draft theme yet — upload
          </button>
        )}
        {idle && sync?.ok && outOfDate === 0 && <span className="jd-check__ok">Draft theme is up to date</span>}
        {idle && sync && !sync.ok && <span className="jd-check__warn">{sync.error}</span>}
      </div>

      {askUpload && (
        <div className="jd-ask">
          <p><b>{outOfDate} theme file{outOfDate === 1 ? " isn't" : "s aren't"} on the draft theme yet.</b> A check now would test the old version. Uploads go to the unpublished draft theme only — your live store isn't touched.</p>
          <div>
            <button type="button" className="jd-check__btn jd-check__btn--primary" disabled={syncing} onClick={() => void (async () => { if (await upload()) { setAskUpload(false); void startCheck(); } })()}>
              {syncing ? <Loader2 className="jd-spin" /> : <CloudUpload />} Upload &amp; check
            </button>
            <button type="button" className="jd-check__btn" disabled={syncing} onClick={() => { setAskUpload(false); void startCheck(); }}>Check anyway</button>
            <button type="button" className="jd-check__link" onClick={() => setAskUpload(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
