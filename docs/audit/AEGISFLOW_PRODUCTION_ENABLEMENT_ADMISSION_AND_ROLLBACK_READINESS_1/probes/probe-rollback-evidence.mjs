// Rollback must not touch evidence or the ledger (both are out-of-tree).
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
const REPO="/private/tmp/aegis-repair-1";
const dir="/private/tmp/admission-rehearsal/cases/rollback-evidence";
rmSync(dir,{recursive:true,force:true});
const target=join(dir,"home",".omp","agent","extensions");
const backups=join(dir,"backups");
mkdirSync(join(target,"lib"),{recursive:true});
writeFileSync(join(target,"no-poll-waits.js"), execFileSync("git",["-C",REPO,"show","fb8ce6a:integrations/omp/extensions/no-poll-waits.js"],{maxBuffer:1<<26}));
execFileSync("cp",[join(REPO,"integrations/omp/extensions/lib/poll-wait-policy.js"),join(target,"lib","poll-wait-policy.js")]);
const record=JSON.parse(execFileSync(process.execPath,[join(REPO,"scripts/install-omp-integration.mjs"),"install","--target",target,"--backup-root",backups,"--json"],{encoding:"utf8"}));
const recordPath=join(dir,"install-record.json"); writeFileSync(recordPath,JSON.stringify(record,null,2));
// Evidence + ledger live OUTSIDE the extension tree, as the deployment requires.
const stateDir=join(dir,"state"); mkdirSync(stateDir,{recursive:true});
const ledger=join(stateDir,"session.jsonl");
writeFileSync(ledger, JSON.stringify({type:"allocate",sessionId:"s",runtimeInstanceId:"r",generation:1,allocationToken:"t",at:1})+"\n");
const evidenceDir=join(dir,"evidence"); mkdirSync(evidenceDir,{recursive:true});
writeFileSync(join(evidenceDir,"frames.txt"),"signed frame\n");
const before={ledger:createHash("sha256").update(readFileSync(ledger)).digest("hex"),evidence:createHash("sha256").update(readFileSync(join(evidenceDir,"frames.txt"))).digest("hex")};
const rb=JSON.parse(execFileSync(process.execPath,[join(REPO,"scripts/omp-rollback-integration.mjs"),recordPath,"--json"],{encoding:"utf8"}));
const after={ledger:existsSync(ledger)?createHash("sha256").update(readFileSync(ledger)).digest("hex"):"GONE",evidence:existsSync(join(evidenceDir,"frames.txt"))?createHash("sha256").update(readFileSync(join(evidenceDir,"frames.txt"))).digest("hex"):"GONE"};
console.log("rollback ok:", rb.ok);
console.log("ledger survived byte-identical:", before.ledger===after.ledger);
console.log("evidence survived byte-identical:", before.evidence===after.evidence);
console.log("backup retained:", existsSync(backups) && readdirSync(backups).length>0);
