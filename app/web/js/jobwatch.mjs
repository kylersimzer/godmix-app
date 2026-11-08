// Jobs as the app sees them. On the server every job goes queued → running → done | error, one at a time
// (app/server.js). The app polls GET /api/jobs while any job is live; this works out which jobs changed status
// since the last look, so each finish is reported exactly once.
//
//   saw(job)      a job this app just started (the POST /api/jobs answer), so even one that finishes before the
//                 first poll is reported
//   update(list)  the latest /api/jobs list → [{job, was, now}], one per change of status. A job that was live
//                 and is missing from the list ended with the server (it was restarted or closed): now = 'gone'.
//                 Jobs seen for the first time already finished (another tab, before a reload) aren't reported.
//
// Nothing here touches the page, so tests/jobwatch.test.mjs drives it directly.
export const isLive = j => j.status === 'queued' || j.status === 'running';
export const FINISHED = ['done', 'error', 'gone'];

export function createJobWatch() {
  const seen = new Map();                  // id → {job: as last seen, listed: has a /api/jobs list shown it yet}
  return {
    saw(job) { if (job?.id && !seen.has(job.id)) seen.set(job.id, { job, listed: false }); },
    update(list) {
      const changes = [], ids = new Set();
      for (const j of list) {
        ids.add(j.id);
        const was = seen.get(j.id)?.job.status;
        seen.set(j.id, { job: j, listed: true });
        if (was && was !== j.status) changes.push({ job: j, was, now: j.status });
      }
      for (const [id, { job: j, listed }] of seen) {
        // a job only this app knows about (just started) can be missing from a list fetched before it existed
        if (ids.has(id) || !listed) continue;
        seen.delete(id);
        if (isLive(j)) changes.push({ job: { ...j, status: 'gone' }, was: j.status, now: 'gone' });
      }
      return changes;
    },
    live: () => [...seen.values()].some(x => isLive(x.job)),
  };
}
