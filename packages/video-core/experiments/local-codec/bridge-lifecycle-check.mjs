import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
const [buildRoot, fixture, out] = process.argv.slice(2);
assert(buildRoot && fixture && out);
await mkdir(out);
const workerSource = `import factory from '/decode.mjs';
onmessage=async({data})=>{
 let m;
 try{
 m=await factory();m.input=new Uint8Array(data.bytes);m.frames=[];m.events=[];
 const once=(fault=0,cancel=false)=>{
   m.frames=[];m.events=[];m._set_fault(fault);
   let code=m._open_input(m.input.length,1000),steps=0;
   while(code===0&&steps++<1002){code=m._decode_step();if(cancel&&steps===2){m._close_input();code=m._decode_step();}}
   const autoHandles=m._live_handles();m._close_input();m._close_input();
   return {fault,code,steps,autoHandles,closedHandles:m._live_handles(),heap:m._heap_used(),frames:m.frames.length,hashes:m.frames.map(f=>f.md5)};
 };
 if(data.mode==='terminate'||data.mode==='cancel'){
   m._set_fault(0);const opened=m._open_input(m.input.length,1000);if(opened!==0)throw Error('open '+opened);
   const first=m._decode_step();if(first!==0)throw Error('fixture must remain unfinished');
   let cancelled=false,ignored=0,grants=0,publications=0;
   await new Promise(resolve=>{
     // No further decode occurs until the parent grants a chunk. The armed event
     // therefore establishes unfinished work, not merely a queued start notice.
     onmessage=({data:command})=>{
       if(command.kind==='cancel'){
         cancelled=true;m._close_input();m._close_input();
         postMessage({kind:'cancelled',handles:m._live_handles(),grants,publications});
       }else if(command.kind==='grant'){
         if(cancelled){ignored++;return;}
         grants++;const code=m._decode_step();
         if(code===1){publications++;postMessage({kind:'unexpected-completion'});}
       }else if(command.kind==='barrier'){
         postMessage({kind:'barrier',cancelled,ignored,grants,publications,handles:m._live_handles()});resolve();
       }
     };
     postMessage({kind:'armed-unfinished',code:first,steps:1,handles:m._live_handles(),grants,publications});
   });return;
 }
 const warm=once(),rows=[];
 if(warm.code!==1||warm.frames!==12)throw Error('warm decode failed');
 for(let stage=1;stage<=10;stage++)rows.push(once(stage));
 rows.push(once(0,true));
 for(const size of [0,16*1024*1024+1]){m._set_fault(0);const code=m._open_input(size,1000);rows.push({size,code,autoHandles:m._live_handles()});}
 m._set_fault(0);const badLimit=m._open_input(m.input.length,1001);rows.push({limit:1001,code:badLimit,autoHandles:m._live_handles()});
 // Warm all error/logging paths before checking stable allocator occupancy.
 once();const baseline=m._heap_used(),repeat=[];
 for(let i=0;i<16;i++){for(let stage=1;stage<=10;stage++)once(stage);repeat.push(once());}
 postMessage({kind:'result',warm,rows,baseline,repeat});
 }catch(error){postMessage({kind:'error',error:String(error)});}finally{m?._close_input();}
};`;
const server = createServer(async (req, res) => {
  try {
    const name = req.url.slice(1);
    if (name === 'worker.mjs') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(workerSource);
    } else if (['decode.mjs', 'decode.wasm'].includes(name)) {
      res.setHeader('Content-Type', name.endsWith('wasm') ? 'application/wasm' : 'text/javascript');
      res.end(await readFile(path.join(buildRoot, name)));
    } else res.end('<!doctype html>');
  } catch {
    res.writeHead(500).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({
    executablePath: '/usr/bin/chromium',
    args: ['--no-sandbox'],
  }),
  results = [];
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const bytes = Array.from(await readFile(fixture));
  async function run(mode) {
    return page.evaluate(
      ({ bytes, mode }) =>
        new Promise((resolve, reject) => {
          const worker = new globalThis.Worker('/worker.mjs', { type: 'module' });
          const timeout = globalThis.setTimeout(() => {
            worker.terminate();
            reject(Error('worker did not settle'));
          }, 15000);
          worker.onerror = (e) => {
            globalThis.clearTimeout(timeout);
            worker.terminate();
            reject(Error(e.message));
          };
          let armed, cancelled;
          worker.onmessage = ({ data }) => {
            const finish = (value) => {
              globalThis.clearTimeout(timeout);
              worker.terminate();
              resolve(value);
            };
            if (data.kind === 'unexpected-completion') {
              globalThis.clearTimeout(timeout);
              worker.terminate();
              reject(Error('Late publication'));
              return;
            }
            if (data.kind === 'armed-unfinished') {
              armed = data;
              if (mode === 'terminate') finish({ kind: 'terminated-while-awaiting-grant', armed });
              else worker.postMessage({ kind: 'cancel' });
            } else if (data.kind === 'cancelled') {
              cancelled = data;
              // Same sender FIFO plus barrier ack proves this late grant was handled.
              worker.postMessage({ kind: 'grant' });
              worker.postMessage({ kind: 'barrier' });
            } else if (data.kind === 'barrier')
              finish({ kind: 'cancelled-before-grant', armed, cancelled, barrier: data });
            else finish(data);
          };
          worker.postMessage({ bytes, mode });
        }),
      { bytes, mode },
    );
  }
  const detail = await run('faults');
  await writeFile(path.join(out, 'raw.json'), JSON.stringify(detail, null, 2));
  assert.equal(detail.kind, 'result', detail.error);
  for (const row of detail.rows) {
    assert(row.code < 0);
    assert.equal(row.autoHandles, 0);
    if ('closedHandles' in row) assert.equal(row.closedHandles, 0);
  }
  results.push({ name: 'allocation-io-cancel-bounds', status: 'PASS', cases: detail.rows.length });
  for (const row of detail.repeat) {
    assert.equal(row.code, 1);
    assert.equal(row.frames, 12);
    assert.equal(row.autoHandles, 0);
    assert.equal(row.closedHandles, 0);
    assert.deepEqual(row.hashes, detail.warm.hashes);
    assert.equal(row.heap, detail.baseline);
  }
  results.push({
    name: 'repeated-failure-reopen-release',
    status: 'PASS',
    cycles: detail.repeat.length,
    baselineHeap: detail.baseline,
    heapAfter: detail.repeat.map((r) => r.heap),
  });
  const cancellations = [];
  for (let i = 0; i < 3; i++) {
    const ended = await run('terminate');
    assert.equal(ended.kind, 'terminated-while-awaiting-grant');
    assert.deepEqual(ended.armed, {
      kind: 'armed-unfinished',
      code: 0,
      steps: 1,
      handles: 5,
      grants: 0,
      publications: 0,
    });
    const cancelled = await run('cancel');
    cancellations.push(cancelled);
    assert.deepEqual(cancelled.armed, ended.armed);
    assert.deepEqual(cancelled.cancelled, {
      kind: 'cancelled',
      handles: 0,
      grants: 0,
      publications: 0,
    });
    assert.deepEqual(cancelled.barrier, {
      kind: 'barrier',
      cancelled: true,
      ignored: 1,
      grants: 0,
      publications: 0,
      handles: 0,
    });
  }
  await writeFile(path.join(out, 'cancellation.json'), JSON.stringify(cancellations, null, 2));
  results.push({
    name: 'cancel-unfinished-before-grant-and-ignore-late-grant',
    status: 'PASS',
    cases: 3,
  });
  // A new worker after termination must decode normally; no reuse of killed memory.
  const recovered = await run('faults');
  assert.equal(recovered.kind, 'result');
  assert.deepEqual(recovered.warm.hashes, detail.warm.hashes);
  results.push({
    name: 'terminate-unfinished-awaiting-grant-and-new-worker',
    status: 'PASS',
    terminations: 3,
  });
} catch (error) {
  results.push({ name: 'lifecycle-gate', status: 'FAIL', error: String(error) });
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
await writeFile(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
console.log(results);
process.exitCode = results.some((r) => r.status === 'FAIL') ? 1 : 0;
