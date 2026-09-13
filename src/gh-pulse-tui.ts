/**
 * gh-pulse show — the report and the history, in the terminal.
 *
 * Built on @profullstack/hqtui so the same data that goes out by email is
 * readable over SSH without a mail client: the ranked movers on the left, the
 * selected repo's traffic and detail on the right, and a History tab over
 * every snapshot on disk (stars, followers, movers, traffic per run).
 *
 * The range row and the filter row are clickable. Ranges (latest report, last
 * hour, day, week, month, quarter, year, all time) run a live scan when no
 * fresh one is cached, in the background, while the current view stays up.
 * Filters are on/off toggles: which kinds of movement count (stars, forks,
 * commits, PRs, issues, releases, traffic), which owners, and private repos.
 * A repo stays in the list while at least one enabled kind moved for it.
 *
 * Mouse: one click selects a row or flips a toggle, the row under the pointer
 * is lit, the wheel scrolls. Keys: up/down or j/k move, Tab switches Movers
 * and History, h d w m q y a l pick a range, 1-7 flip the kind filters, p
 * flips private, r rescans the current range, o opens the HTML, q quits.
 */

import { createApp } from '@profullstack/hqtui';

import {
  RANGE_KEYS,
  RANGE_LABEL,
  listSnapshots,
  movementBits,
  openInBrowser,
  outputPaths,
  rangeOutputPaths,
  readReport,
  readSnapshot,
  trafficBits,
  type RangeKey,
  type ReportJson,
  type ReportMover,
  type Snapshot,
} from './gh-pulse.ts';

export interface HistoryRow {
  at: string;
  repos: number;
  stars: number;
  followers: number;
  movers: number;
  views: number;
  clones: number;
}

/** One line per snapshot, oldest first. The movement rows are only stored for movers, which is what the counts are. */
export function historyRows(snapshots: Snapshot[]): HistoryRow[] {
  return snapshots.map((s) => {
    const rows = Object.values(s.repos);
    const moved = rows.filter((r) => r.movement);
    return {
      at: s.at,
      repos: rows.length,
      stars: rows.reduce((t, r) => t + r.stars, 0),
      followers: s.followers.length,
      movers: moved.length,
      views: moved.reduce((t, r) => t + (r.movement?.views ?? 0), 0),
      clones: moved.reduce((t, r) => t + (r.movement?.clones ?? 0), 0),
    };
  });
}

export function loadHistory(dataDir: string, max = 120): HistoryRow[] {
  const files = listSnapshots(dataDir).slice(-max);
  const snaps: Snapshot[] = [];
  for (const f of files) {
    try {
      snaps.push(readSnapshot(f));
    } catch {
      // A truncated file (a run killed mid-write) is skipped, not fatal.
    }
  }
  return historyRows(snaps);
}

// ---------------------------------------------------------------- filters

export const KINDS = ['stars', 'forks', 'commits', 'prs', 'issues', 'releases', 'traffic'] as const;
export type Kind = (typeof KINDS)[number];

export interface Filters {
  kinds: Set<Kind>;
  /** Owners switched OFF; an empty set means every owner shows. */
  hiddenOwners: Set<string>;
  showPrivate: boolean;
}

export const defaultFilters = (): Filters => ({ kinds: new Set(KINDS), hiddenOwners: new Set(), showPrivate: true });

export function movedIn(m: ReportMover['movement'], kind: Kind): boolean {
  switch (kind) {
    case 'stars': return m.stars !== 0;
    case 'forks': return m.forks !== 0;
    case 'commits': return m.commits > 0;
    case 'prs': return m.prOpened + m.prMerged + m.prClosed > 0;
    case 'issues': return m.issuesOpened + m.issuesClosed > 0;
    case 'releases': return m.releases > 0;
    case 'traffic': return m.views > 0 || m.clones > 0;
    default: return false;
  }
}

export const ownerOf = (repo: string): string => repo.split('/')[0] ?? repo;

/** The movers that pass every toggle. Rank order is kept; the rank shown is the position in the full list. */
export function applyFilters(movers: ReportMover[], f: Filters): { mover: ReportMover; rank: number }[] {
  const out: { mover: ReportMover; rank: number }[] = [];
  movers.forEach((mover, i) => {
    if (!f.showPrivate && mover.private) return;
    if (f.hiddenOwners.has(ownerOf(mover.repo))) return;
    if (![...f.kinds].some((k) => movedIn(mover.movement, k))) return;
    out.push({ mover, rank: i + 1 });
  });
  return out;
}

// ---------------------------------------------------------------- the app

const fmtStamp = (iso: string): string => iso.replace('T', ' ').slice(0, 16);
const RANGE_HOTKEY: Record<RangeKey, string> = { hour: 'h', day: 'd', week: 'w', month: 'm', quarter: 'q', year: 'y', all: 'a' };

export interface ShowOptions {
  /** Start on this range instead of the latest daily report. */
  range?: RangeKey | undefined;
  /** Produce (or fetch from cache) the report for a range. Called off the render loop. */
  loadRange: (key: RangeKey, progress: (line: string) => void) => Promise<ReportJson>;
}

export async function showTui(dataDir: string, opts: ShowOptions): Promise<number> {
  let report: ReportJson | null = readReport(dataDir);
  let current: RangeKey | 'latest' = 'latest';
  if (!report && !opts.range) {
    process.stderr.write(`gh-pulse show: no report yet in ${dataDir}. Run \`gh-pulse\` (or \`gh-pulse --dry-run\`) first.\n`);
    return 1;
  }
  const history = loadHistory(dataDir);
  const filters = defaultFilters();

  let tab = 0;
  let selected = 0;
  let offset = 0;
  let hovered = -1;
  let hOffset = Math.max(0, history.length - 1);
  let hSelected = Math.max(0, history.length - 1);
  let hHovered = -1;
  let notice = '';
  let scanning: RangeKey | null = null;
  let scanLine = '';

  const app = await createApp({ mouse: true, quitKeys: ['q', 'ctrl+c', 'escape'] });

  const visible = (): { mover: ReportMover; rank: number }[] => (report ? applyFilters(report.movers, filters) : []);
  const owners = (): string[] => [...new Set((report?.movers ?? []).map((m) => ownerOf(m.repo)))].sort();

  const move = (delta: number): void => {
    if (tab === 0) selected = Math.max(0, Math.min(visible().length - 1, selected + delta));
    else hSelected = Math.max(0, Math.min(history.length - 1, hSelected + delta));
  };

  const pickRange = (key: RangeKey | 'latest', force = false): void => {
    if (key === 'latest') {
      const latest = readReport(dataDir);
      if (latest) { report = latest; current = 'latest'; selected = 0; offset = 0; notice = ''; }
      else notice = 'no daily report yet';
      app.invalidate();
      return;
    }
    if (scanning) { notice = `still scanning ${RANGE_LABEL[scanning]}`; app.invalidate(); return; }
    scanning = key;
    scanLine = force ? 'rescanning' : 'loading';
    notice = '';
    app.invalidate();
    opts.loadRange(key, (line) => { scanLine = line; app.invalidate(); }).then(
      (r) => { report = r; current = key; selected = 0; offset = 0; scanning = null; scanLine = ''; app.invalidate(); },
      (error: unknown) => { scanning = null; scanLine = ''; notice = `scan failed: ${(error as Error).message}`; app.invalidate(); },
    );
  };

  app.on('key', (e) => {
    if (e.name === 'down' || e.name === 'j') move(1);
    else if (e.name === 'up' || e.name === 'k') move(-1);
    else if (e.name === 'pagedown') move(10);
    else if (e.name === 'pageup') move(-10);
    else if (e.name === 'home') move(-1e9);
    else if (e.name === 'end') move(1e9);
    else if (e.name === 'tab' || e.name === 'left' || e.name === 'right') tab = (tab + 1) % 2;
    else if (e.name === 'l') { pickRange('latest'); return; }
    else if (e.name === 'r') { pickRange(current === 'latest' ? 'day' : current, true); return; }
    else if (e.name === 'p') { filters.showPrivate = !filters.showPrivate; selected = 0; }
    else if (e.name === 'o') {
      const file = current === 'latest' ? outputPaths(dataDir).html : rangeOutputPaths(dataDir, current).html;
      notice = openInBrowser(file) ? 'opened the HTML report in the browser' : `no opener found; the report is at ${file}`;
    } else if (/^[1-7]$/.test(e.name)) {
      const kind = KINDS[Number(e.name) - 1]!;
      if (filters.kinds.has(kind)) filters.kinds.delete(kind); else filters.kinds.add(kind);
      selected = 0;
    } else {
      const key = (Object.keys(RANGE_HOTKEY) as RangeKey[]).find((k) => RANGE_HOTKEY[k] === e.name);
      if (key) pickRange(key);
      return;
    }
    app.invalidate();
  });

  app.on('mouse', (e) => {
    if (e.action === 'move') { hovered = -1; hHovered = -1; app.invalidate(); }
  });

  if (opts.range) pickRange(opts.range);

  app.render(({ ui, theme, width, height }) => {
    const rows = visible();
    const bodyRows = Math.max(3, height - 13);
    if (selected >= rows.length) selected = Math.max(0, rows.length - 1);
    if (selected < offset) offset = selected;
    if (selected >= offset + bodyRows) offset = selected - bodyRows + 1;
    if (hSelected < hOffset) hOffset = hSelected;
    if (hSelected >= hOffset + bodyRows) hOffset = hSelected - bodyRows + 1;
    const paneCols = Math.max(14, Math.floor((width - 3) / 2) - 4);

    ui.column({ padding: 0 }, (col) => {
      // Range row: one button per range, the current one lit, all clickable.
      col.buttons([
        { label: 'latest', variant: current === 'latest' ? 'primary' : 'ghost', onPress: () => pickRange('latest') },
        ...RANGE_KEYS.map((k) => ({
          label: `${RANGE_LABEL[k].replace('last ', '')}${scanning === k ? ' …' : ''}`,
          variant: (current === k ? 'primary' : 'ghost') as 'primary' | 'ghost',
          onPress: () => pickRange(k),
        })),
      ], { size: 1 });
      // Filter rows: kinds and private on one, owners on the next (eleven orgs do not fit beside the kinds).
      col.row({ size: 1, gap: 2 }, (r) => {
        for (const k of KINDS) {
          r.checkbox({ label: k, checked: filters.kinds.has(k), variant: 'toggle', width: k.length + 5, onToggle: () => { if (filters.kinds.has(k)) filters.kinds.delete(k); else filters.kinds.add(k); selected = 0; } });
        }
        r.spacer(1);
        r.checkbox({ label: 'private', checked: filters.showPrivate, variant: 'toggle', width: 12, onToggle: () => { filters.showPrivate = !filters.showPrivate; selected = 0; } });
      });
      col.row({ size: 1, gap: 2 }, (r) => {
        for (const o of owners()) {
          r.checkbox({ label: o, checked: !filters.hiddenOwners.has(o), width: o.length + 5, onToggle: () => { if (filters.hiddenOwners.has(o)) filters.hiddenOwners.delete(o); else filters.hiddenOwners.add(o); selected = 0; } });
        }
      });

      if (!report) {
        col.panel({ title: scanning ? `Scanning ${RANGE_LABEL[scanning]}` : 'No report' }, (p) => { p.text(scanLine || notice || 'nothing loaded yet', { fg: theme.muted }); });
        return;
      }
      const rep = report;
      const rangeLabel = rep.range ? rep.range.label : `since last run (${fmtStamp(rep.since)})`;
      col.row({ size: 4, gap: 2 }, (r) => {
        r.keyValues([
          { label: 'Report', value: `${fmtStamp(rep.at)} · ${rangeLabel}` },
          { label: 'Coverage', value: rep.range ? rep.range.coverage : `${rep.trafficLabel}, newest GitHub day ${rep.newestTrafficDay}` },
          { label: 'Moved', value: `${rows.length} shown of ${rep.movers.length} movers, ${rep.totals.repos} repos` },
          { label: 'Followers', value: `${rep.followers} (+${rep.followersGained.length} / -${rep.followersLost.length})` },
        ], { width: '1fr' });
        r.keyValues([
          { label: 'Stars', value: `${rep.totals.stars}${rep.totals.starsDelta === null ? '' : ` (${rep.totals.starsDelta >= 0 ? '+' : ''}${rep.totals.starsDelta})`}`, color: theme.accent },
          { label: 'Views', value: `${rep.totals.views} / ${rep.totals.uniques} unique` },
          { label: 'Clones', value: `${rep.totals.clones} / ${rep.totals.cloners} unique` },
          { label: scanning ? 'Scanning' : 'Status', value: scanning ? `${RANGE_LABEL[scanning]}: ${scanLine}` : (notice || 'ready'), color: scanning ? theme.warning : theme.muted },
        ], { width: '1fr' });
      });

      if (tab === 0) {
        col.grid({ columns: ['1fr', '1fr'], rows: ['1fr'], gap: 1 }, (grid) => {
          grid.panel({ title: `Ranked by movement, ${rangeLabel} (${rows.length})`, footer: '↑/↓ move · click selects · 1-7 kinds · h d w m q y a l range · r rescan · o HTML · Tab history · q quit' }, (p) => {
            p.table({
              rows,
              selected,
              hovered,
              offset,
              followSelection: true,
              scrollbar: true,
              zebra: true,
              columns: [
                { key: 'rank', title: '#', width: 4, align: 'right', render: (r) => String(r.rank) },
                { key: 'repo', title: 'Repo', color: theme.primary, render: (r) => r.mover.repo },
                { key: 'score', title: 'pts', width: 6, align: 'right', render: (r) => r.mover.score.toFixed(0) },
                { key: 'bits', title: 'Movement', render: (r) => [...movementBits(r.mover.movement), ...trafficBits(r.mover.movement)].join(' · ') },
              ],
              onSelectRow: (row) => { selected = offset + row; app.invalidate(); },
              onHoverRow: (row) => { hovered = row === null ? -1 : offset + row; app.invalidate(); },
              onScroll: (delta) => { move(delta); app.invalidate(); },
            });
          });
          const x = rows[selected]?.mover;
          grid.panel({ title: x ? x.repo : 'Nothing matches', subtitle: x ? `★ ${x.stars} · ⑂ ${x.forks} · ${x.score.toFixed(0)} pts` : '' }, (p) => {
            if (!x) { p.text('Switch a filter back on, or pick another range.', { fg: theme.muted }); return; }
            const m = x.movement;
            const vs = x.views14d;
            const cs = x.clones14d;
            const vTotal = vs.reduce((t, d) => t + d.count, 0);
            const cTotal = cs.reduce((t, d) => t + d.count, 0);
            const perBar = Math.max(1, Math.floor(paneCols / Math.max(1, vs.length)));
            const widen = (values: number[]): number[] => values.flatMap((v) => Array<number>(perBar).fill(v));
            const span = vs.length ? `${vs[0]!.day} to ${rep.newestTrafficDay}` : '';
            p.text(movementBits(m).join(' · ') || 'traffic only', { fg: theme.muted, size: 1 });
            p.keyValues([
              { label: `Views (${rangeLabel})`, value: `${m.views} / ${m.uniques} unique`, color: theme.info },
              { label: `Clones (${rangeLabel})`, value: `${m.clones} / ${m.cloners} unique`, color: theme.warning },
            ], { size: 2 });
            p.text(`Views, ${span}  (${vTotal} charted, peak ${Math.max(0, ...vs.map((d) => d.count))})`, { fg: theme.muted, size: 1 });
            p.histogram({ values: widen(vs.map((d) => d.count)), color: theme.info, size: 5 });
            p.text(`Clones  (${cTotal} charted, peak ${Math.max(0, ...cs.map((d) => d.count))})`, { fg: theme.muted, size: 1 });
            p.histogram({ values: widen(cs.map((d) => d.count)), color: theme.warning, size: 5 });
            const lines: string[] = [];
            if (x.referrers.length) lines.push(`Referrers (14d): ${x.referrers.slice(0, 5).map((q) => `${q.referrer} ${q.count}/${q.uniques}`).join(' · ')}`);
            if (x.paths.length) lines.push(`Popular (14d): ${x.paths.slice(0, 4).map((q) => `${q.path.replace(`/${x.repo}`, '') || '/'} ${q.count}/${q.uniques}`).join(' · ')}`);
            if (m.newStargazers.length) lines.push(`Starred by ${m.newStargazers.slice(0, 10).join(', ')}${m.newStargazers.length > 10 ? ` and ${m.newStargazers.length - 10} more` : ''}`);
            if (m.newForks.length) lines.push(`Forked by ${m.newForks.slice(0, 6).map((f) => f.split('/')[0]).join(', ')}`);
            if (m.authors.length) lines.push(`Commits by ${m.authors.slice(0, 6).join(', ')}`);
            for (const pr of m.mergedPrs.slice(0, 5)) lines.push(`merged #${pr.n} ${pr.t}`);
            for (const pr of m.openedPrs.slice(0, 3)) lines.push(`opened #${pr.n} ${pr.t} (${pr.u})`);
            for (const is of m.openedIssues.slice(0, 3)) lines.push(`issue #${is.n} ${is.t} (${is.u})`);
            for (const rel of m.releaseList.slice(0, 5)) lines.push(`released ${rel.tag}`);
            if (lines.length) p.text(lines.join('\n'), { wrap: true });
            p.spacer('fill');
            p.text(`${x.url}/graphs/traffic`, { fg: theme.muted, size: 1 });
          });
        });
      } else {
        col.panel({ title: `History (${history.length} snapshot${history.length === 1 ? '' : 's'})`, footer: 'one row per daily run · ↑/↓ move · Tab movers · q quit' }, (p) => {
          const stars = history.map((h) => h.stars);
          const followers = history.map((h) => h.followers);
          p.sparkline({ values: stars, label: 'Stars', text: String(stars.at(-1) ?? 0), color: theme.accent, size: 1 });
          p.sparkline({ values: followers, label: 'Followers', text: String(followers.at(-1) ?? 0), color: theme.primary, size: 1 });
          p.sparkline({ values: history.map((h) => h.views), label: 'Views', text: String(history.at(-1)?.views ?? 0), color: theme.info, size: 1 });
          p.sparkline({ values: history.map((h) => h.clones), label: 'Clones', text: String(history.at(-1)?.clones ?? 0), color: theme.warning, size: 1 });
          p.spacer(1);
          p.table({
            rows: history,
            selected: hSelected,
            hovered: hHovered,
            offset: hOffset,
            followSelection: true,
            scrollbar: true,
            zebra: true,
            columns: [
              { key: 'at', title: 'Run (UTC)', width: 17, render: (r) => fmtStamp(r.at) },
              { key: 'repos', title: 'Repos', width: 6, align: 'right' },
              { key: 'movers', title: 'Moved', width: 6, align: 'right' },
              { key: 'stars', title: 'Stars', width: 7, align: 'right' },
              { key: 'followers', title: 'Followers', width: 10, align: 'right' },
              { key: 'views', title: 'Views', width: 7, align: 'right' },
              { key: 'clones', title: 'Clones', width: 7, align: 'right' },
            ],
            onSelectRow: (row) => { hSelected = hOffset + row; app.invalidate(); },
            onHoverRow: (row) => { hHovered = row === null ? -1 : hOffset + row; app.invalidate(); },
            onScroll: (delta) => { move(delta); app.invalidate(); },
          });
        });
      }
    });
  });

  await app.start();
  return 0;
}
