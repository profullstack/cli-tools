/**
 * gh-pulse show — the last report and the history, in the terminal.
 *
 * Built on @profullstack/hqtui so the same data that goes out by email is
 * readable over SSH without a mail client: the ranked movers on the left, the
 * selected repo's 14-day traffic and detail on the right, and a History tab
 * over every snapshot on disk (stars, followers, movers, traffic per run).
 *
 * Mouse: one click selects a row, the row under the pointer is lit, the wheel
 * scrolls. Keys: up/down or j/k move, 1/2 or left/right switch tabs, o opens
 * the HTML report in the browser, q quits.
 */

import { createApp } from '@profullstack/hqtui';

import {
  listSnapshots,
  movementBits,
  openInBrowser,
  outputPaths,
  readReport,
  readSnapshot,
  trafficBits,
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

const fmtStamp = (iso: string): string => iso.replace('T', ' ').slice(0, 16);

export async function showTui(dataDir: string): Promise<number> {
  const report: ReportJson | null = readReport(dataDir);
  if (!report) {
    process.stderr.write(`gh-pulse show: no report yet in ${dataDir}. Run \`gh-pulse\` (or \`gh-pulse --dry-run\`) first.\n`);
    return 1;
  }
  const history = loadHistory(dataDir);
  const movers = report.movers;

  let tab = 0;
  let selected = 0;
  let offset = 0;
  let hovered = -1;
  let hOffset = Math.max(0, history.length - 1);
  let hSelected = Math.max(0, history.length - 1);
  let hHovered = -1;
  let notice = '';

  const app = await createApp({ mouse: true, quitKeys: ['q', 'ctrl+c', 'escape'] });

  const move = (delta: number): void => {
    if (tab === 0) selected = Math.max(0, Math.min(movers.length - 1, selected + delta));
    else hSelected = Math.max(0, Math.min(history.length - 1, hSelected + delta));
  };

  app.on('key', (e) => {
    if (e.name === 'down' || e.name === 'j') move(1);
    else if (e.name === 'up' || e.name === 'k') move(-1);
    else if (e.name === 'pagedown') move(10);
    else if (e.name === 'pageup') move(-10);
    else if (e.name === 'home') move(-1e9);
    else if (e.name === 'end') move(1e9);
    else if (e.name === '1' || e.name === 'left') tab = 0;
    else if (e.name === '2' || e.name === 'right') tab = 1;
    else if (e.name === 'tab') tab = (tab + 1) % 2;
    else if (e.name === 'o') {
      notice = openInBrowser(outputPaths(dataDir).html) ? 'opened the HTML report in the browser' : `no opener found; the report is at ${outputPaths(dataDir).html}`;
    } else return;
    app.invalidate();
  });

  app.on('mouse', (e) => {
    if (e.action === 'move') { hovered = -1; hHovered = -1; app.invalidate(); }
  });

  const sel = (): ReportMover | undefined => movers[selected];

  app.render(({ ui, theme, width, height }) => {
    const bodyRows = Math.max(3, height - 8);
    // The histogram draws one cell per value; repeat each day so fourteen days
    // fill the detail pane instead of its left fifth.
    const paneCols = Math.max(14, Math.floor((width - 3) / 2) - 4);
    const perDay = Math.max(1, Math.floor(paneCols / 14));
    const widen = (values: number[]): number[] => values.flatMap((v) => Array<number>(perDay).fill(v));
    if (selected < offset) offset = selected;
    if (selected >= offset + bodyRows) offset = selected - bodyRows + 1;
    if (hSelected < hOffset) hOffset = hSelected;
    if (hSelected >= hOffset + bodyRows) hOffset = hSelected - bodyRows + 1;

    ui.column({ padding: 0 }, (col) => {
      col.tabs({ tabs: ['Movers', 'History'], active: tab, size: 1, variant: 'underline', onSelect: (i) => { tab = i; app.invalidate(); } });
      col.row({ size: 4, gap: 2 }, (r) => {
        r.keyValues([
          { label: 'Report', value: fmtStamp(report.at) },
          { label: 'Window since', value: fmtStamp(report.since) },
          { label: 'Moved', value: report.totals.repos ? `${movers.length} of ${report.totals.repos} repos` : String(movers.length) },
          { label: 'Followers', value: `${report.followers} (+${report.followersGained.length} / -${report.followersLost.length})` },
        ], { width: '1fr' });
        r.keyValues([
          { label: 'Stars', value: `${report.totals.stars}${report.totals.starsDelta === null ? '' : ` (${report.totals.starsDelta >= 0 ? '+' : ''}${report.totals.starsDelta})`}`, color: theme.accent },
          { label: 'Views', value: `${report.totals.views} / ${report.totals.uniques} unique` },
          { label: 'Clones', value: `${report.totals.clones} / ${report.totals.cloners} unique` },
          { label: 'Traffic', value: `${report.trafficLabel}, newest GitHub day ${report.newestTrafficDay}` },
        ], { width: '1fr' });
      });

      if (tab === 0) {
        col.grid({ columns: ['1fr', '1fr'], rows: ['1fr'], gap: 1 }, (grid) => {
          grid.panel({ title: `Ranked by movement (${movers.length})`, footer: notice || '↑/↓ move · click selects · o opens HTML · 2 history · q quit' }, (p) => {
            p.table({
              rows: movers,
              selected,
              hovered,
              offset,
              followSelection: true,
              scrollbar: true,
              zebra: true,
              columns: [
                { key: 'rank', title: '#', width: 4, align: 'right', render: (_r, i) => String(i + 1) },
                { key: 'repo', title: 'Repo', color: theme.primary },
                { key: 'score', title: 'pts', width: 6, align: 'right', render: (r) => r.score.toFixed(0) },
                { key: 'bits', title: 'Movement', render: (r) => [...movementBits(r.movement), ...trafficBits(r.movement)].join(' · ') },
              ],
              onSelectRow: (row) => { selected = offset + row; app.invalidate(); },
              onHoverRow: (row) => { hovered = row === null ? -1 : offset + row; app.invalidate(); },
              onScroll: (delta) => { move(delta); app.invalidate(); },
            });
          });
          const x = sel();
          grid.panel({ title: x ? x.repo : 'Nothing moved', subtitle: x ? `★ ${x.stars} · ⑂ ${x.forks} · ${x.score.toFixed(0)} pts` : '' }, (p) => {
            if (!x) return;
            const m = x.movement;
            const v14 = x.views14d.reduce((t, d) => t + d.count, 0);
            const c14 = x.clones14d.reduce((t, d) => t + d.count, 0);
            p.text(movementBits(m).join(' · ') || 'traffic only', { fg: theme.muted, size: 1 });
            p.keyValues([
              { label: `Views (${report.trafficLabel})`, value: `${m.views} / ${m.uniques} unique`, color: theme.info },
              { label: `Clones (${report.trafficLabel})`, value: `${m.clones} / ${m.cloners} unique`, color: theme.warning },
            ], { size: 2 });
            p.text(`Views per day, ${x.views14d[0]?.day ?? ''} to ${report.newestTrafficDay}  (${v14} in 14d, peak ${Math.max(0, ...x.views14d.map((d) => d.count))})`, { fg: theme.muted, size: 1 });
            p.histogram({ values: widen(x.views14d.map((d) => d.count)), color: theme.info, size: 5 });
            p.text(`Clones per day  (${c14} in 14d, peak ${Math.max(0, ...x.clones14d.map((d) => d.count))})`, { fg: theme.muted, size: 1 });
            p.histogram({ values: widen(x.clones14d.map((d) => d.count)), color: theme.warning, size: 5 });
            const lines: string[] = [];
            if (x.referrers.length) lines.push(`Referrers: ${x.referrers.slice(0, 5).map((q) => `${q.referrer} ${q.count}/${q.uniques}`).join(' · ')}`);
            if (x.paths.length) lines.push(`Popular: ${x.paths.slice(0, 4).map((q) => `${q.path.replace(`/${x.repo}`, '') || '/'} ${q.count}/${q.uniques}`).join(' · ')}`);
            if (m.newStargazers.length) lines.push(`Starred by ${m.newStargazers.slice(0, 10).join(', ')}`);
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
        col.panel({ title: `History (${history.length} snapshot${history.length === 1 ? '' : 's'})`, footer: notice || 'one row per run · ↑/↓ move · 1 movers · q quit' }, (p) => {
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
