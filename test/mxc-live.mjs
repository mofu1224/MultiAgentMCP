// Windows MXCの実機境界検証。認証情報ではなく自作のダミーファイルだけを使う。
import { Sandbox } from "../src/sandbox.mjs";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import assert from "node:assert/strict";

const dir = mkdtempSync(path.join(tmpdir(), "mamcp-boundary-"));
const foreign = path.join(dir, "dummy-secret.txt");
writeFileSync(foreign, "DUMMY_NOT_A_REAL_SECRET");
process.env.MAMCP_DUMMY_SECRET = "DUMMY_ENV_SECRET";
const listener = net.createServer(socket => socket.end("HOST"));
await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
const sandbox = new Sandbox({ backend: "mxc" });
try {
  const ready = await sandbox.available();
  console.log(JSON.stringify({ test: "mxc-ready", ...ready }));
  assert.equal(ready.ok, true);
  const code = `
    const fs=require("node:fs"), net=require("node:net"), cp=require("node:child_process");
    const out={};
    try{fs.readFileSync(${JSON.stringify(foreign)});out.foreignRead="ALLOWED";}catch{out.foreignRead="denied";}
    try{fs.writeFileSync(${JSON.stringify(foreign)},"CHANGED");out.foreignWrite="ALLOWED";}catch{out.foreignWrite="denied";}
    fs.writeFileSync("own.txt","OWN");
    out.ownWrite=fs.readFileSync("own.txt","utf8")==="OWN";
    out.envAbsent=!process.env.MAMCP_DUMMY_SECRET;
    const child=cp.spawnSync(process.execPath,["-e",${JSON.stringify(`try{require("fs").readFileSync(${JSON.stringify(foreign)});console.log("ALLOWED")}catch{console.log("DENIED")}`)}],{encoding:"utf8"});
    out.descendantDenied=child.stdout.trim()==="DENIED";
    const socket=net.connect({host:"127.0.0.1",port:${port}});
    let done=false;
    const finish=value=>{if(done)return;done=true;out.networkDenied=value;socket.destroy();console.log(JSON.stringify(out));};
    socket.on("connect",()=>finish(false));socket.on("error",()=>finish(true));socket.setTimeout(1500,()=>finish(true));
  `;
  const result = await sandbox.run({ code, timeout_ms: 10000 });
  console.log(JSON.stringify({ test: "mxc-boundaries", ...result }));
  assert.equal(result.status, "succeeded");
  const proof = JSON.parse(result.stdout.trim());
  assert.deepEqual(proof, { foreignRead: "denied", foreignWrite: "denied", ownWrite: true, envAbsent: true, descendantDenied: true, networkDenied: true });
  assert.equal(readFileSync(foreign, "utf8"), "DUMMY_NOT_A_REAL_SECRET");
  const timeout = await sandbox.run({ code: "setInterval(()=>{},1000)", timeout_ms: 1000 });
  console.log(JSON.stringify({ test: "mxc-timeout", status: timeout.status }));
  assert.equal(timeout.status, "timeout");
} finally {
  await sandbox.shutdown();
  listener.close();
  delete process.env.MAMCP_DUMMY_SECRET;
  rmSync(dir, { recursive: true, force: true });
}
