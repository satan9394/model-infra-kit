#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function die(msg, code = 1, json = false) {
  if (json) process.stdout.write(JSON.stringify({ allow: false, error: msg }) + '\n');
  else process.stderr.write(`Error: ${msg}\n`);
  process.exit(code);
}

function rootOf(input) { return path.resolve(input || '.'); }
function statePath(root) { return path.join(root, '.agent-state', 'run-state.json'); }
function viewPath(root) { return path.join(root, 'RUN_STATE.md'); }

function defaultState() {
  return {
    schemaVersion: 1,
    revision: 0,
    mode: 'bounded',
    mission: {
      goal: '',
      definitionOfDone: [],
      outOfScope: [],
      status: 'active'
    },
    workset: [],
    blocked: [],
    deferredBacklog: [],
    budget: {
      run: {
        epoch: { used: 0, limit: 2 },
        cards: { used: 0, limit: 6 },
        repairs: { used: 0, limit: 1 },
        workersSpawned: { used: 0, limit: 8 },
        research: { used: 0, limit: 1 }
      },
      mission: {
        runs: { used: 1, limit: 3 },
        cards: { used: 0, limit: 12 },
        repairs: { used: 0, limit: 3 }
      },
      worksetLimit: 8,
      activeWorkerLimit: 3,
      maxSubagentDepth: 1
    },
    workers: { active: 0 },
    lastVerifiedCommit: null,
    resumeFrom: null,
    notesForNextRun: [],
    updatedAt: new Date().toISOString()
  };
}

function readState(root) {
  const p = statePath(root);
  if (!fs.existsSync(p)) throw new Error(`bounded state missing: ${p}`);
  let s;
  try { s = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { throw new Error(`invalid JSON in ${p}: ${e.message}`); }
  return s;
}

function pair(x, label) {
  if (!x || !Number.isInteger(x.used) || !Number.isInteger(x.limit)) throw new Error(`${label} must contain integer used/limit`);
  if (x.used < 0 || x.limit < 0) throw new Error(`${label} cannot be negative`);
  if (x.used > x.limit) throw new Error(`${label} exceeds limit (${x.used}/${x.limit})`);
}

function validate(s) {
  if (!s || s.schemaVersion !== 1) throw new Error('unsupported or missing schemaVersion');
  if (s.mode !== 'bounded') throw new Error('state mode must be bounded');
  if (!s.mission || typeof s.mission.goal !== 'string' || !Array.isArray(s.mission.definitionOfDone)) throw new Error('mission shape is invalid');
  if (!['active','completed','blocked'].includes(s.mission.status)) throw new Error('mission.status must be active|completed|blocked');
  if (!Array.isArray(s.workset) || !Array.isArray(s.blocked) || !Array.isArray(s.deferredBacklog)) throw new Error('workset/blocked/deferredBacklog must be arrays');
  const r = s.budget?.run, m = s.budget?.mission;
  if (!r || !m) throw new Error('budget.run and budget.mission are required');
  for (const [k,v] of Object.entries(r)) pair(v, `budget.run.${k}`);
  for (const [k,v] of Object.entries(m)) pair(v, `budget.mission.${k}`);
  for (const k of ['worksetLimit','activeWorkerLimit','maxSubagentDepth']) {
    if (!Number.isInteger(s.budget[k]) || s.budget[k] < 0) throw new Error(`budget.${k} must be a non-negative integer`);
  }
  if (!s.workers || !Number.isInteger(s.workers.active) || s.workers.active < 0) throw new Error('workers.active must be a non-negative integer');
  if (s.workers.active > s.budget.activeWorkerLimit) throw new Error(`workers.active exceeds activeWorkerLimit (${s.workers.active}/${s.budget.activeWorkerLimit})`);
  if (s.workset.length > s.budget.worksetLimit) throw new Error(`workset exceeds worksetLimit (${s.workset.length}/${s.budget.worksetLimit})`);
  return true;
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function mdList(items, empty='- —') {
  if (!items || items.length === 0) return empty;
  return items.map(x => typeof x === 'string' ? `- ${x}` : `- ${x.id || ''} ${x.title || ''} — ${x.status || ''}`.trim()).join('\n');
}

function render(s) {
  const r=s.budget.run, m=s.budget.mission;
  return `# RUN STATE (generated)\n\n> Machine source of truth: \`.agent-state/run-state.json\`. Do not edit counters here.\n\n## Mission\n${s.mission.goal || '(not set)'}\n\n## Definition of Done\n${s.mission.definitionOfDone.length ? s.mission.definitionOfDone.map(x=>`- [ ] ${x}`).join('\n') : '- [ ] (not set)'}\n\n## Out of scope\n${mdList(s.mission.outOfScope)}\n\n## Status\n- Mission: ${s.mission.status}\n- Revision: ${s.revision}\n- Updated: ${s.updatedAt}\n\n## WorkSet (${s.workset.length}/${s.budget.worksetLimit})\n${mdList(s.workset)}\n\n## Blocked\n${mdList(s.blocked)}\n\n## Deferred Backlog\n${mdList(s.deferredBacklog)}\n\n## Run Budget\n- Epoch: ${r.epoch.used}/${r.epoch.limit}\n- Cards: ${r.cards.used}/${r.cards.limit}\n- Repairs: ${r.repairs.used}/${r.repairs.limit}\n- Workers spawned: ${r.workersSpawned.used}/${r.workersSpawned.limit}\n- Research passes: ${r.research.used}/${r.research.limit}\n- Active workers: ${s.workers.active}/${s.budget.activeWorkerLimit}\n- Max subagent depth: ${s.budget.maxSubagentDepth}\n\n## Mission Budget\n- Runs: ${m.runs.used}/${m.runs.limit}\n- Cards: ${m.cards.used}/${m.cards.limit}\n- Repairs: ${m.repairs.used}/${m.repairs.limit}\n\n## Last verified commit\n${s.lastVerifiedCommit || '—'}\n\n## Resume From\n${s.resumeFrom || '—'}\n\n## Notes for next run\n${mdList(s.notesForNextRun)}\n`;
}

function save(root, s) {
  validate(s);
  s.revision = (Number.isInteger(s.revision) ? s.revision : 0) + 1;
  s.updatedAt = new Date().toISOString();
  atomicWrite(statePath(root), JSON.stringify(s, null, 2) + '\n');
  atomicWrite(viewPath(root), render(s));
}

function gateDecision(s) {
  validate(s);
  if (s.mission.status !== 'active') return { allow:false, reason:`mission status is ${s.mission.status}` };
  if (!s.mission.goal.trim()) return { allow:false, reason:'mission goal is empty' };
  if (s.mission.definitionOfDone.length === 0) return { allow:false, reason:'Definition of Done is empty' };
  // gate answers one question only: may the coordinator start another task card?
  // Action-specific budgets (repair/research/worker spawning) are enforced by their own commands.
  if (s.budget.run.cards.used >= s.budget.run.cards.limit) return { allow:false, reason:`run card budget exhausted: ${s.budget.run.cards.used}/${s.budget.run.cards.limit}` };
  if (s.budget.mission.cards.used >= s.budget.mission.cards.limit) return { allow:false, reason:`mission card budget exhausted: ${s.budget.mission.cards.used}/${s.budget.mission.cards.limit}` };
  return { allow:true, reason:'next card is within scope/budget', revision:s.revision };
}

function ensureCanInc(p, n=1, label='counter') {
  if (p.used + n > p.limit) throw new Error(`${label} would exceed limit (${p.used}+${n}>${p.limit})`);
}

function printStatus(s, json=false) {
  const d=gateDecision(s);
  const obj={allow:d.allow, reason:d.reason, revision:s.revision, mission:s.mission, budget:s.budget, workers:s.workers, worksetSize:s.workset.length, resumeFrom:s.resumeFrom, lastVerifiedCommit:s.lastVerifiedCommit};
  if (json) process.stdout.write(JSON.stringify(obj, null, 2)+'\n');
  else process.stdout.write(render(s));
}

const [,,cmd,rootArg,...rest]=process.argv;
if (!cmd) die('usage: runstate.js <init|check|status|gate|advance|worker-start|worker-stop|new-run|resume|render> <project-root> [...]',2);
const root=rootOf(rootArg);

try {
  if (cmd==='init') {
    if (fs.existsSync(statePath(root))) die(`state already exists: ${statePath(root)}`);
    const s=defaultState();
    save(root,s);
    process.stdout.write(`Initialized bounded state at ${statePath(root)}\nFill mission.goal and mission.definitionOfDone, then run check/gate.\n`);
  } else if (cmd==='check') {
    const s=readState(root); validate(s); process.stdout.write('OK\n');
  } else if (cmd==='status') {
    printStatus(readState(root), rest.includes('--json'));
  } else if (cmd==='gate') {
    const s=readState(root); const d=gateDecision(s); process.stdout.write(JSON.stringify(d)+'\n'); process.exit(d.allow?0:1);
  } else if (cmd==='advance') {
    const field=rest[0]; if (!field) die('advance requires field: epoch|card|repair|research',2);
    const s=readState(root); validate(s);
    if (field==='epoch') { ensureCanInc(s.budget.run.epoch,1,'run.epoch'); s.budget.run.epoch.used++; }
    else if (field==='research') { ensureCanInc(s.budget.run.research,1,'run.research'); s.budget.run.research.used++; }
    else if (field==='card') {
      ensureCanInc(s.budget.run.cards,1,'run.cards'); ensureCanInc(s.budget.mission.cards,1,'mission.cards');
      s.budget.run.cards.used++; s.budget.mission.cards.used++;
    } else if (field==='repair') {
      ensureCanInc(s.budget.run.repairs,1,'run.repairs'); ensureCanInc(s.budget.mission.repairs,1,'mission.repairs');
      s.budget.run.repairs.used++; s.budget.mission.repairs.used++;
    } else die(`unknown advance field: ${field}`,2);
    save(root,s); process.stdout.write('OK\n');
  } else if (cmd==='worker-start') {
    const s=readState(root); validate(s);
    ensureCanInc(s.budget.run.workersSpawned,1,'run.workersSpawned');
    if (s.workers.active + 1 > s.budget.activeWorkerLimit) throw new Error(`active workers would exceed limit (${s.workers.active}+1>${s.budget.activeWorkerLimit})`);
    const d=gateDecision(s); if (!d.allow) throw new Error(d.reason);
    s.budget.run.workersSpawned.used++; s.workers.active++;
    save(root,s); process.stdout.write('OK\n');
  } else if (cmd==='worker-stop') {
    const s=readState(root); validate(s);
    if (s.workers.active <= 0) throw new Error('workers.active is already 0');
    s.workers.active--; save(root,s); process.stdout.write('OK\n');
  } else if (cmd==='new-run') {
    const s=readState(root); validate(s);
    if (s.mission.status !== 'active') throw new Error(`cannot start new run when mission is ${s.mission.status}`);
    if (s.budget.mission.cards.used >= s.budget.mission.cards.limit) throw new Error(`mission card budget exhausted (${s.budget.mission.cards.used}/${s.budget.mission.cards.limit})`);
    ensureCanInc(s.budget.mission.runs,1,'mission.runs');
    s.budget.mission.runs.used++;
    for (const v of Object.values(s.budget.run)) v.used=0;
    s.workers.active=0;
    save(root,s); process.stdout.write('OK\n');
  } else if (cmd==='resume') {
    const s=readState(root); validate(s);
    const d=gateDecision(s);
    process.stdout.write(`Mission: ${s.mission.goal || '(not set)'}\nStatus: ${s.mission.status}\nResume From: ${s.resumeFrom || '—'}\nLast verified commit: ${s.lastVerifiedCommit || '—'}\nGate: ${d.allow ? 'ALLOW' : 'STOP'} — ${d.reason}\n`);
    process.exit(d.allow?0:1);
  } else if (cmd==='render') {
    const s=readState(root); validate(s); atomicWrite(viewPath(root), render(s)); process.stdout.write('OK\n');
  } else die(`unknown command: ${cmd}`,2);
} catch (e) {
  if (cmd==='gate') { process.stdout.write(JSON.stringify({allow:false, reason:e.message})+'\n'); process.exit(1); }
  die(e.message,1);
}
