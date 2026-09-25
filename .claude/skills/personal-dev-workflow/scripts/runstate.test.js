#!/usr/bin/env node
'use strict';
const fs=require('fs'), os=require('os'), path=require('path'), cp=require('child_process');
const script=path.join(__dirname,'runstate.js');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pdw-runstate-'));
function run(args, ok=true){
  const r=cp.spawnSync(process.execPath,[script,...args],{encoding:'utf8'});
  if (ok && r.status!==0) throw new Error(`expected success: ${args.join(' ')}\n${r.stdout}\n${r.stderr}`);
  if (!ok && r.status===0) throw new Error(`expected failure: ${args.join(' ')}`);
  return r;
}
try {
  run(['gate',dir],false); // bounded gate must fail closed when state missing
  run(['init',dir]);
  const p=path.join(dir,'.agent-state','run-state.json');
  const s=JSON.parse(fs.readFileSync(p,'utf8'));
  s.mission.goal='test mission';
  s.mission.definitionOfDone=['tests pass'];
  fs.writeFileSync(p,JSON.stringify(s,null,2)+'\n');
  run(['check',dir]);
  run(['gate',dir]);
  run(['advance',dir,'research']);
  run(['advance',dir,'research'],false); // research budget is action-specific
  run(['gate',dir]); // research limit must not freeze normal card execution
  run(['worker-start',dir]); run(['worker-start',dir]); run(['worker-start',dir]);
  run(['worker-start',dir],false); // active gauge limit
  run(['worker-stop',dir]);
  run(['worker-start',dir]); // capacity released
  for(let i=0;i<6;i++) run(['advance',dir,'card']);
  run(['gate',dir],false); // run card budget exhausted
  run(['new-run',dir]);
  run(['gate',dir]);
  const s2=JSON.parse(fs.readFileSync(p,'utf8'));
  if(s2.workers.active!==0) throw new Error('new-run did not reset active workers');
  if(s2.budget.run.cards.used!==0) throw new Error('new-run did not reset run cards');
  if(s2.budget.mission.cards.used!==6) throw new Error('mission card counter was reset incorrectly');
  console.log('runstate smoke tests: PASS');
} finally { fs.rmSync(dir,{recursive:true,force:true}); }
