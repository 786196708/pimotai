import test from 'node:test';
import assert from 'node:assert/strict';
import * as project from '../web/project.js';
import {zipSync,unzipSync,strToU8,strFromU8,Zip,ZipDeflate} from '../web/vendor/addons/libs/fflate.module.js';

const IDENTITY=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const TRIANGLE=new Float32Array([0,0,0,4,0,0,0,6,0]);
const metadata=(overrides={})=>({id:'one',name:'部件 <A> & "B"',source:'本地.obj',color:'#12ab34',done:true,placement:'confirmed',matrix:[...IDENTITY],originalMatrix:[...IDENTITY],file:'part-0.bin',...overrides});
const manifest=(parts=[metadata()])=>({format:'pimotai',version:1,title:'可恢复项目',parts,reference:false});
const floatBytes=a=>new Uint8Array(a.buffer.slice(a.byteOffset,a.byteOffset+a.byteLength));
function archive(doc=manifest(),extra={},options={level:0}) {
  return zipSync({'manifest.json':strToU8(JSON.stringify(doc)),'part-0.bin':floatBytes(TRIANGLE),...extra},options);
}
function central(bytes) {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),result=[];
  let e=bytes.length-22;
  while(e>=0 && view.getUint32(e,true)!==0x06054b50)e--;
  assert.ok(e>=0,'fixture contains an end record');
  let offset=view.getUint32(e+16,true);
  for(let i=0;i<view.getUint16(e+10,true);i++) {
    const nameLength=view.getUint16(offset+28,true),extraLength=view.getUint16(offset+30,true),commentLength=view.getUint16(offset+32,true);
    result.push({offset,name:strFromU8(bytes.subarray(offset+46,offset+46+nameLength)),local:view.getUint32(offset+42,true)});
    offset+=46+nameLength+extraLength+commentLength;
  }
  return {view,entries:result,e};
}

test('project roundtrip preserves sliced positions, pose, print status and reference',()=>{
  const backing=new Float32Array([99,99,99,...TRIANGLE,88,88,88]);
  const positions=backing.subarray(3,12),m=[0,2,0,0,-3,0,0,0,0,0,4,0,12,-7,5,1];
  const part={...metadata(),positions,base:{toArray:()=>m},originalMatrix:IDENTITY};
  const packed=project.packProject([part],'项目 <一>',TRIANGLE);
  const loaded=project.unpackProject(packed);
  assert.equal(loaded.title,'项目 <一>');
  assert.deepEqual([...loaded.parts[0].positions],[...TRIANGLE]);
  assert.deepEqual(loaded.parts[0].matrix,m);
  assert.equal(loaded.parts[0].done,true);
  assert.equal(loaded.parts[0].placement,'confirmed');
  assert.deepEqual([...loaded.reference],[...TRIANGLE]);
  loaded.parts[0].positions[0]=123;
  assert.equal(backing[3],0,'loaded geometry must not alias the original import');
});

test('rejects nonfinite geometry, missing members and duplicate identities',()=>{
  const bad=TRIANGLE.slice();bad[3]=NaN;
  assert.throws(()=>project.unpackProject(archive(manifest(),{'part-0.bin':floatBytes(bad)})),/无效|损坏|有限/);
  assert.throws(()=>project.unpackProject(archive(manifest([metadata({file:'part-5.bin'})]))),/缺失|损坏|文件/);
  assert.throws(()=>project.unpackProject(archive(manifest([metadata(),metadata()]))),/标识|重复/);
});

test('rejects singular transforms before they can create NaN quaternions',()=>{
  const singular=[...IDENTITY];singular[0]=0;
  assert.throws(()=>project.unpackProject(archive(manifest([metadata({matrix:singular})]))),/摆位|矩阵|缩放/);
});

test('rejects perspective and shear transforms that the TRS editor cannot preserve',()=>{
  const perspective=[...IDENTITY];perspective[3]=.01;
  const shear=[...IDENTITY];shear[4]=.25;
  assert.throws(()=>project.unpackProject(archive(manifest([metadata({matrix:perspective})]))),/摆位|矩阵/);
  assert.throws(()=>project.unpackProject(archive(manifest([metadata({originalMatrix:shear})]))),/摆位|矩阵/);
});

test('rejects excessive ZIP entry counts even when entries expand to zero bytes',()=>{
  const extra={};for(let i=0;i<1100;i++)extra[`unused-${i}`]=new Uint8Array();
  assert.throws(()=>project.unpackProject(archive(manifest(),extra)),/条目|文件|过多|资源/);
});

test('rejects declared expansion excess without allocating the claimed member',()=>{
  const bytes=archive(),{view,entries}=central(bytes),entry=entries.find(e=>e.name==='part-0.bin');
  view.setUint32(entry.offset+24,512*1024*1024,true);
  assert.throws(()=>project.unpackProject(bytes),/过大|超限|大小|声明|损坏|长度/);
});

test('rejects inconsistent local and central ZIP size declarations',()=>{
  const bytes=archive(),{view,entries}=central(bytes),entry=entries.find(e=>e.name==='part-0.bin');
  view.setUint32(entry.offset+24,TRIANGLE.byteLength*2,true);
  assert.throws(()=>project.unpackProject(bytes),/ZIP|压缩|长度|损坏|大小|声明/);
});

test('detects payload corruption instead of silently loading changed coordinates',()=>{
  const bytes=archive(),{view,entries}=central(bytes),entry=entries.find(e=>e.name==='part-0.bin');
  const data=entry.local+30+view.getUint16(entry.local+26,true)+view.getUint16(entry.local+28,true);
  bytes[data+3]^=1;
  assert.throws(()=>project.unpackProject(bytes),/CRC|校验|损坏/);
});

test('rejects actual DEFLATE expansion beyond forged small declarations',()=>{
  const bytes=archive(manifest(),{'part-0.bin':new Uint8Array(256*1024)},{level:9});
  const {view,entries}=central(bytes),entry=entries.find(e=>e.name==='part-0.bin');
  view.setUint32(entry.offset+24,36,true);view.setUint32(entry.local+22,36,true);
  assert.throws(()=>project.unpackProject(bytes),/长度|声明|解压|损坏|CRC|校验/);
});

test('3MF export retains escaped names, chosen color and physical transform',()=>{
  const m=[0,2,0,0,-3,0,0,0,0,0,4,0,12,-7,5,1];
  const bytes=project.make3mf([{...metadata(),positions:TRIANGLE,base:{elements:m}}]);
  const files=unzipSync(bytes),xml=strFromU8(files['3D/3dmodel.model']);
  assert.match(xml,/unit="millimeter"/);
  assert.match(xml,/name="部件 &lt;A&gt; &amp; &quot;B&quot;"/);
  assert.match(xml,/displaycolor="#12AB34FF"/);
  assert.match(xml,/transform="0 2 0 -3 0 0 0 0 4 12 -7 5"/);
});

test('3MF preflight returns reusable decompressed files and every model XML',()=>{
  assert.equal(typeof project.preflight3mf,'function','a bounded preflight is required before ThreeMFLoader');
  const model='<model unit="inch"><resources/><build/></model>';
  const bytes=zipSync({'3D/main.model':strToU8(model),'3D/other.model':strToU8(model),'_rels/.rels':strToU8('<Relationships/>')});
  const result=project.preflight3mf(bytes);
  assert.deepEqual(result.models.map(m=>m.name),['3D/main.model','3D/other.model']);
  assert.equal(result.models[0].text,model);
  assert.equal(strFromU8(result.files['3D/main.model']),model);
});

test('3MF preflight refuses oversized and corrupted resources before model parsing',()=>{
  assert.equal(typeof project.preflight3mf,'function');
  const oversized=zipSync({'3D/main.model':strToU8('<model/>')},{level:0});
  const {view,entries}=central(oversized);view.setUint32(entries[0].offset+24,151*1024*1024,true);
  assert.throws(()=>project.preflight3mf(oversized),/过大|大小|声明|损坏|长度|超限/);
  const corrupt=zipSync({'3D/main.model':strToU8('<model/>')},{level:0});
  const info=central(corrupt),entry=info.entries[0],data=entry.local+30+info.view.getUint16(entry.local+26,true)+info.view.getUint16(entry.local+28,true);
  corrupt[data]^=1;
  assert.throws(()=>project.preflight3mf(corrupt),/CRC|校验|损坏/);
});

test('streamed ZIP data descriptors remain compatible with bounded 3MF loading',()=>{
  const chunks=[],zip=new Zip((error,chunk)=>{if(error)throw error;chunks.push(chunk);});
  const file=new ZipDeflate('3D/main.model');zip.add(file);
  file.push(strToU8('<model unit="millimeter"><resources/><build/></model>'),true);zip.end();
  const length=chunks.reduce((n,a)=>n+a.length,0),bytes=new Uint8Array(length);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  const result=project.preflight3mf(bytes);
  assert.match(result.models[0].text,/unit="millimeter"/);
});

test('multi-chunk inflation preserves the complete UTF-8 model and input byte offset',()=>{
  let seed=12345,body='';for(let i=0;i<50000;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;body+=String.fromCharCode(33+seed%90);}
  const xml=`<model>${body}</model>`,bytes=zipSync({'3D/main.model':strToU8(xml)},{level:1});
  assert.ok(bytes.length>4096,'fixture must exercise multiple inflater pushes');
  const wrapped=new Uint8Array(bytes.length+20);wrapped.set(bytes,7);
  assert.equal(project.preflight3mf(wrapped.subarray(7,7+bytes.length)).models[0].text,xml);
});

test('3MF refuses the cumulative declared resource budget before expansion',()=>{
  const files={};for(let i=0;i<3;i++)files[`3D/${i}.model`]=strToU8('<model/>');
  const bytes=zipSync(files),{view,entries}=central(bytes);
  for(const entry of entries){view.setUint32(entry.offset+24,80*1024*1024,true);view.setUint32(entry.local+22,80*1024*1024,true);}
  assert.throws(()=>project.preflight3mf(bytes),/总大小超限/);
});

test('duplicate names and overlapping ZIP records are rejected',()=>{
  const files={'3D/0.model':strToU8('<model/>'),'3D/1.model':strToU8('<model/>')};
  const duplicate=zipSync(files),info=central(duplicate),second=info.entries[1];
  duplicate[second.offset+46+3]='0'.charCodeAt(0);duplicate[second.local+30+3]='0'.charCodeAt(0);
  assert.throws(()=>project.preflight3mf(duplicate),/重复/);
  const overlap=zipSync(files),o=central(overlap);
  o.view.setUint32(o.entries[1].offset+42,o.entries[0].local,true);
  assert.throws(()=>project.preflight3mf(overlap),/不一致|重叠/);
});
