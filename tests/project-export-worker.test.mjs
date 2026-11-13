import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {once} from 'node:events';
import {unpackProject} from '../web/project.js';

const IDENTITY=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const TRIANGLE=new Float32Array([0,0,0,4,0,0,0,6,0]);

async function startExportWorker(){
  const url=new URL('../web/project-export-worker.js',import.meta.url).href;
  const worker=new Worker(`
    const {parentPort}=require('node:worker_threads');
    globalThis.self={postMessage:(value,transfer)=>parentPort.postMessage(value,transfer)};
    import(${JSON.stringify(url)}).then(()=>{
      parentPort.on('message',data=>self.onmessage({data}));
      parentPort.postMessage({ready:true});
    }).catch(error=>parentPort.postMessage({error:error.message}));
  `,{eval:true});
  const [ready]=await once(worker,'message');
  if(!ready.ready){await worker.terminate();assert.fail(`export worker must load: ${ready.error}`);}
  return worker;
}

test('real export worker preserves geometry, metadata and the original main-thread buffers',async()=>{
  const worker=await startExportWorker();
  try{
    const backing=new Float32Array([99,99,99,...TRIANGLE,88,88,88]),positions=backing.subarray(3,12),reference=TRIANGLE.slice();
    const matrix=[0,2,0,0,-3,0,0,0,0,0,4,0,12,-7,5,1];
    const payload={title:'后台导出测试',metadata:{localProjectId:'generic-local',attribution:'作者及来源保留'},reference,parts:[{
      id:'one',name:'独立分件.stl',source:'原始文件.stl',positions,matrix,originalMatrix:[...IDENTITY],
      color:'#12ab34',done:true,visible:false,placement:'confirmed',note:'来源类型 kind=alternative；旧装配状态：unresolved。保留原始备注。',sourceFileId:'original-one'
    }]};
    const response=once(worker,'message');worker.postMessage(payload);
    assert.equal(positions.byteLength,36,'export must not detach live model geometry');
    assert.equal(reference.byteLength,36,'export must not detach the live reference');
    payload.parts[0].done=false;payload.parts[0].matrix[12]=999;
    const [message]=await response;assert.equal(message.error,undefined);assert.ok(message.buffer instanceof ArrayBuffer);
    const loaded=unpackProject(new Uint8Array(message.buffer)),part=loaded.parts[0];
    assert.equal(loaded.title,'后台导出测试');assert.equal(loaded.localProjectId,'generic-local');assert.equal(loaded.attribution,'作者及来源保留');
    assert.deepEqual([...part.positions],[0,0,0,4,0,0,0,6,0]);assert.deepEqual([...loaded.reference],[0,0,0,4,0,0,0,6,0]);
    assert.equal(part.name,'独立分件.stl');assert.equal(part.source,'原始文件.stl');assert.equal(part.color,'#12ab34');assert.equal(part.done,true);
    assert.equal(part.visible,false);assert.equal(part.placement,'confirmed');assert.equal(part.sourceFileId,'original-one');
    assert.equal(part.note,'来源类型 kind=alternative；旧装配状态：unresolved。保留原始备注。');
    assert.deepEqual(part.matrix,[0,2,0,0,-3,0,0,0,0,0,4,0,12,-7,5,1]);assert.deepEqual(part.originalMatrix,IDENTITY);
    assert.deepEqual([...positions],[0,0,0,4,0,0,0,6,0]);assert.equal(backing[0],99);assert.equal(backing[12],88);
  }finally{await worker.terminate();}
});

test('real export worker returns existing geometry validation errors without a broken archive',async()=>{
  const worker=await startExportWorker();
  try{
    const positions=TRIANGLE.slice();positions[3]=NaN;
    const response=once(worker,'message');
    worker.postMessage({title:'无效模型',parts:[{id:'bad',name:'bad.stl',positions,matrix:IDENTITY,originalMatrix:IDENTITY}]});
    const [message]=await response;assert.match(message.error,/模型数据无效|非有限坐标/);assert.equal(message.buffer,undefined);
    assert.equal(positions.byteLength,36);
  }finally{await worker.terminate();}
});
