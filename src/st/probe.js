/**
 * npm run probe
 *
 * Run this FIRST, before writing or trusting any poller logic.
 * It answers four questions against the real tenant:
 *   1. Do the credentials work?
 *   2. Do the endpoint paths in endpoints.js resolve?
 *   3. Do the query parameter names in PARAM actually filter?
 *   4. What are the tenant's business unit / job type / employee IDs?
 *
 * Output is meant to be pasted back into .env and endpoints.js.
 */
import { stGet, stGetAll } from './client.js';
import { EP, PARAM } from './endpoints.js';
import { cfg, localDayWindow } from '../config.js';

const line = (s = '') => console.log(s);
const head = (s) => { line(); line('─'.repeat(72)); line(s); line('─'.repeat(72)); };

async function tryEndpoint(name, { module, path }, params = {}) {
  try {
    const json = await stGet(module, path, { ...params, page: 1, pageSize: 5 });
    const rows = json?.data ?? [];
    line(`✅ ${name}  →  ${module}/v2/tenant/{id}/${path}`);
    line(`   envelope keys : ${Object.keys(json).join(', ')}`);
    line(`   totalCount    : ${json.totalCount ?? '(not returned)'}`);
    if (rows[0]) line(`   record keys   : ${Object.keys(rows[0]).join(', ')}`);
    return json;
  } catch (e) {
    line(`❌ ${name}  →  ${module}/v2/tenant/{id}/${path}`);
    line(`   ${e.message}`);
    return null;
  }
}

async function main() {
  head(`ServiceTitan probe — tenant ${cfg.st.tenantId} (${cfg.st.env}), TZ=${cfg.tz}`);

  const today = localDayWindow(0);
  line(`Local "today" resolves to UTC window:`);
  line(`  start ${today.start}`);
  line(`  end   ${today.end}`);
  line(`If those do not straddle your actual business day, TZ is wrong.`);

  head('1. Endpoint reachability (unfiltered)');
  await tryEndpoint('businessUnits', EP.businessUnits);
  await tryEndpoint('jobTypes', EP.jobTypes);
  await tryEndpoint('employees', EP.employees);
  const jobsRaw = await tryEndpoint('jobs', EP.jobs);
  await tryEndpoint('calls', EP.calls);

  head('2. Do the filters actually narrow the result set?');
  /* This check is the whole point of the probe, and the first version of it
     could not fail: totalCount comes back NULL unless includeTotal=true is
     passed, so every count read "null" and matched every other "null".
     A comparison where both sides are null proves nothing.

     It now (a) asks for the total explicitly and (b) sends a deliberately
     bogus parameter as a control. If the bogus filter returns the same count
     as no filter at all, that is the silent-drop behaviour — and it confirms
     the real filters below are being honoured rather than ignored. */
  {
    const P = PARAM.jobs;
    const C = PARAM.calls;

    const count = async (ep, params) => {
      try {
        const j = await stGet(ep.module, ep.path, { ...params, includeTotal: true, page: 1, pageSize: 1 });
        return j.totalCount ?? '(null — includeTotal not honoured)';
      } catch (e) { return `ERROR ${e.message.slice(0, 90)}`; }
    };

    const jobsUnfiltered = await count(EP.jobs, {});
    const jobsBogus = await count(EP.jobs, { totallyMadeUpFilterXyz: today.start });
    const jobsCreated = await count(EP.jobs, { [P.createdOnOrAfter]: today.start, [P.createdBefore]: today.end });
    const jobsSched = await count(EP.jobs, { [P.scheduledOnOrAfter]: today.start, [P.scheduledBefore]: today.end });

    line('jobs');
    line(`  unfiltered                        : ${jobsUnfiltered}`);
    line(`  BOGUS param (control)             : ${jobsBogus}`);
    line(`  ${P.createdOnOrAfter.padEnd(34)}: ${jobsCreated}`);
    line(`  ${P.scheduledOnOrAfter.padEnd(34)}: ${jobsSched}`);

    const callsUnfiltered = await count(EP.calls, {});
    const callsBogus = await count(EP.calls, { totallyMadeUpFilterXyz: today.start });
    const callsToday = await count(EP.calls, { [C.createdOnOrAfter]: today.start, [C.createdBefore]: today.end });

    line('calls');
    line(`  unfiltered                        : ${callsUnfiltered}`);
    line(`  BOGUS param (control)             : ${callsBogus}`);
    line(`  ${C.createdOnOrAfter.padEnd(34)}: ${callsToday}`);

    line();
    const suspect = [
      ['jobs.' + P.createdOnOrAfter, jobsCreated, jobsUnfiltered],
      ['jobs.' + P.scheduledOnOrAfter, jobsSched, jobsUnfiltered],
      ['calls.' + C.createdOnOrAfter, callsToday, callsUnfiltered],
    ].filter(([, got, unf]) => got === unf);

    if (suspect.length) {
      line('❌ THESE FILTERS ARE BEING IGNORED — they return the unfiltered count:');
      for (const [name] of suspect) line(`     ${name}`);
      line('   Fix the names in endpoints.js PARAM before going further, or every');
      line('   number on the board will be a full-history total that looks plausible.');
    } else {
      line('✅ Every filter narrowed the result set, and the bogus control did not.');
    }
  }

  head('3. Job types — fill ESTIMATE_JOB_TYPE_IDS from this list');
  const jobTypes = await stGetAll(EP.jobTypes.module, EP.jobTypes.path, {}, { pageSize: 200 });
  for (const t of jobTypes) line(`  ${String(t.id).padEnd(12)} ${t.name}`);
  const guess = jobTypes.filter((t) => /estimate|quote|bid|consult/i.test(t.name || ''));
  if (guess.length) {
    line();
    line('  Name-match suggestion (VERIFY, do not paste blind):');
    line(`  ESTIMATE_JOB_TYPE_IDS=${guess.map((t) => t.id).join(',')}`);
  }

  head('4. Business units — these become the BU rows on the board');
  const bus = await stGetAll(EP.businessUnits.module, EP.businessUnits.path, {}, { pageSize: 200 });
  for (const b of bus) line(`  ${String(b.id).padEnd(12)} ${b.name}${b.active === false ? '  (inactive)' : ''}`);

  head('5. Employees who booked a job today — candidate CSR list');
  try {
    const P = PARAM.jobs;
    const jobs = await stGetAll(EP.jobs.module, EP.jobs.path, {
      [P.createdOnOrAfter]: today.start,
      [P.createdBefore]: today.end,
    });
    const byCreator = new Map();
    for (const j of jobs) {
      const k = j.createdById ?? j.createdBy ?? 'unknown';
      byCreator.set(k, (byCreator.get(k) || 0) + 1);
    }
    const emps = await stGetAll(EP.employees.module, EP.employees.path, {}, { pageSize: 200 });
    const nameOf = new Map(emps.map((e) => [e.id, e.name]));
    line(`  ${jobs.length} jobs created today, by employee:`);
    for (const [id, n] of [...byCreator].sort((a, b) => b[1] - a[1])) {
      line(`  ${String(id).padEnd(12)} ${(nameOf.get(id) || '(unknown)').padEnd(28)} ${n} jobs`);
    }
    line();
    line(`  CSR_EMPLOYEE_IDS=${[...byCreator.keys()].filter((k) => k !== 'unknown').join(',')}`);
    line();
    line('  ⚠️  Confirm createdById is the CSR and not an automation/API user.');
    line('     Online-booking and integration-created jobs often carry a service');
    line('     account here, which would appear on the board as a phantom CSR.');
  } catch (e) {
    line(`  ❌ ${e.message}`);
  }

  head('Done. Update .env and src/st/endpoints.js from the output above.');
}

main().catch((e) => { console.error(e); process.exit(1); });
