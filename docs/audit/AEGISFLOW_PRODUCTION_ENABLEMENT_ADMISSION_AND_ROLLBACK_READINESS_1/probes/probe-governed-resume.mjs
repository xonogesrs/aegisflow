// Governed resume: does the second launch on the same session get a NEW generation
// and never reuse a closed one?
import { writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const CLIENT = process.env.AEGIS_CLIENT;
const OMP = process.env.AEGIS_RPC_BIN;
const EXT = process.env.AEGIS_CONTROLLER_EXTENSION;
if (!CLIENT || !OMP || !EXT) {
	console.error("set AEGIS_CLIENT, AEGIS_RPC_BIN and AEGIS_CONTROLLER_EXTENSION to absolute paths");
	process.exit(2);
}
const { prepareControllerRoot, launchGovernedRuntime, createControllerGrant, attestExtension, bindIdentity, commitFence } = await import(pathToFileURL(CLIENT).href);
const ROOT = process.env.AEGIS_ADMISSION_SCRATCH || join(process.env.TMPDIR || "/tmp", `gov-resume-${process.pid}`);
const SHA = createHash("sha256").update(readFileSync(EXT)).digest("hex");
const dir=join(ROOT,"cases","gov-resume"); rmSync(dir,{recursive:true,force:true}); mkdirSync(dir,{recursive:true});
const sessionDir=join(dir,"sessions"); mkdirSync(sessionDir,{recursive:true});
const sessionId="rehearsal-resume-fixture";
const sessionFile=join(sessionDir,`${sessionId}.jsonl`);
writeFileSync(sessionFile,`${JSON.stringify({type:"session",version:3,id:sessionId,timestamp:new Date().toISOString(),cwd:dir})}\n${JSON.stringify({type:"message",id:"m1",parentId:null,timestamp:new Date().toISOString(),message:{role:"user",content:"f",timestamp:Date.now()}})}\n`);
const root=prepareControllerRoot({root:join(dir,"controller")});
mkdirSync(join(root.childHome,".omp","agent"),{recursive:true});
writeFileSync(join(root.childHome,".omp","agent","models.yml"),"providers:\n  inert:\n    baseUrl: http://127.0.0.1:1/v1\n    api: openai-responses\n    apiKey: k\n    models:\n    - id: inert/inert\n      name: I\n      contextWindow: 1000\n      maxTokens: 16\n");
writeFileSync(join(root.childHome,".omp","agent","config.yml"),"modelRoles:\n  default: inert/inert\nsymbolPreset: ascii\n");
const launch=()=>launchGovernedRuntime({rpcBin:OMP,controllerRoot:root,grant:createControllerGrant({controllerId:"gr",basis:"x"}),extensionPath:EXT,extensionSha256:SHA,extensionTree:attestExtension(EXT,SHA).digests,args:["--session-dir",sessionDir,"--resume",sessionFile,"--no-skills","--no-rules"],cwd:dir});
const r1=await launch(); const b1=await bindIdentity(r1);
const c1=await commitFence(r1,{status:"PASS",expectation:b1.identity});
await r1.stop();
const r2=await launch(); const b2=await bindIdentity(r2);
console.log("first generation:", b1.identity.generation, "committed:", c1.result?.committed);
console.log("second generation:", b2.identity?.generation, "newer:", b2.identity?.generation > b1.identity.generation);
console.log("same session:", b2.identity?.sessionId === b1.identity.sessionId);
console.log("distinct runtime:", b2.identity?.runtimeInstanceId !== b1.identity.runtimeInstanceId);
await r2.stop();
const recs=readFileSync(join(root.stateDir,`${sessionId}.jsonl`),"utf8").trim().split("\n").map(JSON.parse);
console.log("ledger:", recs.map(r=>`${r.type}:${r.generation}`).join(" "));
