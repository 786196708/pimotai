import {zipSync,Inflate,strToU8,strFromU8} from './vendor/addons/libs/fflate.module.js';
export const LIMITS={files:64,bytes:150*1024*1024,faces:2000000,projectFaces:8000000};
const ZIP_LIMITS={entries:1024,total:200*1024*1024,entry:150*1024*1024,manifest:2*1024*1024};
const crcTable=Uint32Array.from({length:256},(_,i)=>{let c=i;for(let j=0;j<8;j++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
const zipError=message=>new Error(`ZIP 压缩包损坏或不受支持：${message}`);
function byteArray(input){if(input instanceof ArrayBuffer)return new Uint8Array(input);if(!(input instanceof Uint8Array))throw zipError('需要二进制字节数据');return input;}
function inspectZip(input,totalLimit=ZIP_LIMITS.total){
  const bytes=byteArray(input);
  if(bytes.byteLength>LIMITS.bytes)throw new Error('压缩文件过大，请分批载入');
  if(bytes.length<22)throw zipError('缺少结束记录');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),u16=i=>view.getUint16(i,true),u32=i=>view.getUint32(i,true);
  const range=(start,length,end=bytes.length)=>{if(!Number.isSafeInteger(start)||!Number.isSafeInteger(length)||start<0||length<0||start+length>end)throw zipError('记录越界或长度声明不一致');};
  let e=bytes.length-22;
  while(e>=Math.max(0,bytes.length-65557)&&(u32(e)!==0x06054b50||e+22+u16(e+20)!==bytes.length))e--;
  if(e<Math.max(0,bytes.length-65557))throw zipError('找不到完整结束记录');
  const count=u16(e+10),directorySize=u32(e+12),directoryOffset=u32(e+16);
  if(u16(e+4)||u16(e+6)||u16(e+8)!==count)throw zipError('不支持分卷压缩包');
  if(count===65535||directorySize===0xffffffff||directoryOffset===0xffffffff)throw zipError('不支持 ZIP64，请使用普通 ZIP');
  if(count>ZIP_LIMITS.entries)throw new Error('ZIP 文件条目过多，最多1024项');
  range(directoryOffset,directorySize,e);
  if(directoryOffset+directorySize!==e)throw zipError('中央目录边界不一致');
  const entries=[],names=new Set();let offset=directoryOffset,total=0;
  for(let index=0;index<count;index++){
    range(offset,46,e);if(u32(offset)!==0x02014b50)throw zipError('中央目录签名错误');
    const flags=u16(offset+8),method=u16(offset+10),crc=u32(offset+16),size=u32(offset+20),originalSize=u32(offset+24),nameLength=u16(offset+28),extraLength=u16(offset+30),commentLength=u16(offset+32),local=u32(offset+42);
    range(offset+46,nameLength+extraLength+commentLength,e);
    if(flags&~0x080e||![0,8].includes(method))throw zipError('仅支持未加密的 stored/deflate 条目');
    if(u16(offset+34)||[size,originalSize,local].includes(0xffffffff))throw zipError('不支持分卷或 ZIP64 条目');
    if(originalSize>ZIP_LIMITS.entry)throw new Error('ZIP 单个文件解压大小超限，最多150MB');
    total+=originalSize;if(total>totalLimit)throw new Error('ZIP 解压总大小超限');
    const nameBytes=bytes.subarray(offset+46,offset+46+nameLength);
    let name;try{name=flags&0x0800?new TextDecoder('utf-8',{fatal:true}).decode(nameBytes):strFromU8(nameBytes,true);}catch{throw zipError('文件名编码错误');}
    if(!name||name.length>1024||/[\\\x00-\x1f:]/.test(name)||name.startsWith('/')||name.split('/').some((s,i,a)=>s==='..'||s==='.'||(!s&&i!==a.length-1)))throw zipError('文件路径无效');
    if(names.has(name))throw zipError('存在重复文件名');names.add(name);
    let extra=offset+46+nameLength,extraEnd=extra+extraLength;
    while(extra<extraEnd){range(extra,4,extraEnd);const length=u16(extra+2);if(u16(extra)===1)throw zipError('不支持 ZIP64 扩展');range(extra+4,length,extraEnd);extra+=4+length;}
    range(local,30,directoryOffset);if(u32(local)!==0x04034b50)throw zipError('本地条目签名错误');
    const localNameLength=u16(local+26),localExtraLength=u16(local+28),data=local+30+localNameLength+localExtraLength;
    range(local+30,localNameLength+localExtraLength,directoryOffset);range(data,size,directoryOffset);
    if(u16(local+6)!==flags||u16(local+8)!==method||localNameLength!==nameLength||nameBytes.some((b,i)=>b!==bytes[local+30+i]))throw zipError('本地条目和中央目录不一致');
    const descriptor=!!(flags&8);
    for(const [position,expected] of [[local+14,crc],[local+18,size],[local+22,originalSize]])if(u32(position)!==expected&&(!descriptor||u32(position)!==0))throw zipError('本地大小或CRC声明与中央目录不一致');
    if(method===0&&size!==originalSize)throw zipError('未压缩条目的长度声明不一致');
    let end=data+size;
    if(descriptor){range(end,12,directoryOffset);const descriptorOffset=u32(end)===0x08074b50?end+4:end;range(descriptorOffset,12,directoryOffset);if(u32(descriptorOffset)!==crc||u32(descriptorOffset+4)!==size||u32(descriptorOffset+8)!==originalSize)throw zipError('数据描述符声明不一致');end=descriptorOffset+12;}
    if(name.endsWith('/')&&(size||originalSize))throw zipError('目录条目包含数据');
    entries.push({name,method,crc,size,originalSize,data,local,end});
    offset+=46+nameLength+extraLength+commentLength;
  }
  if(offset!==directoryOffset+directorySize)throw zipError('中央目录长度不一致');
  const byOffset=[...entries].sort((a,b)=>a.local-b.local);let previousEnd=0;
  for(const entry of byOffset){if(entry.local<previousEnd)throw zipError('条目区域重叠');previousEnd=entry.end;}
  return {bytes,entries};
}
function expandEntry(archive,entry){
  const input=archive.bytes.subarray(entry.data,entry.data+entry.size),output=new Uint8Array(entry.originalSize);let written=0,crc=0xffffffff;
  const append=chunk=>{if(written+chunk.length>output.length)throw zipError('实际解压长度超过声明，已停止解压');output.set(chunk,written);written+=chunk.length;for(const b of chunk)crc=crcTable[(crc^b)&255]^(crc>>>8);};
  try{
    if(entry.method===0)append(input);
    else{
      // Bounded input chunks also bound temporary inflater output. A forged small
      // originalSize cannot silently truncate a huge actual DEFLATE expansion.
      const stream=new Inflate(chunk=>append(chunk));
      for(let i=0;i<input.length;i+=4096)stream.push(input.subarray(i,i+4096),i+4096>=input.length);
      if(!input.length||!stream.s.f)throw zipError('DEFLATE 数据不完整');
    }
  }catch(error){if(error.message?.startsWith('ZIP '))throw error;throw zipError(`解压失败：${error.message||error}`);}
  if(written!==entry.originalSize)throw zipError('实际解压长度和声明不一致');
  if(((crc^0xffffffff)>>>0)!==entry.crc)throw zipError('CRC 校验失败，文件可能已损坏');
  return output;
}
export function preflight3mf(input){
  const archive=inspectZip(input),files=Object.create(null),models=[];
  for(const entry of archive.entries){const bytes=expandEntry(archive,entry);files[entry.name]=bytes;if(/\.model$/i.test(entry.name)){let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new Error('3MF 模型XML不是有效UTF-8');}models.push({name:entry.name,text});}}
  if(!models.length)throw new Error('3MF 中没有模型XML');
  return {files,models};
}
function validMatrix(matrix){
  if(!Array.isArray(matrix)||matrix.length!==16||!matrix.every(n=>Number.isFinite(n)&&Math.abs(n)<=1e8)||[3,7,11].some(i=>Math.abs(matrix[i])>1e-10)||Math.abs(matrix[15]-1)>1e-10)throw new Error('摆位矩阵无效或包含透视变换');
  const axes=[0,4,8].map(i=>matrix.slice(i,i+3)),lengths=axes.map(a=>Math.hypot(...a));
  if(lengths.some(n=>!Number.isFinite(n)||n<1e-6||n>1e6))throw new Error('摆位矩阵含奇异或零缩放');
  const normalized=axes.map((a,i)=>a.map(v=>v/lengths[i]));
  for(const [a,b] of [[0,1],[0,2],[1,2]])if(Math.abs(normalized[a].reduce((s,v,i)=>s+v*normalized[b][i],0))>1e-6)throw new Error('摆位矩阵含编辑器不能保留的剪切变换');
}
const placement=value=>['imported','manual','confirmed','matched','ambiguous','unmatched'].includes(value)?value:'imported';
function validIdentity(p,ids){if(!p||typeof p!=='object'||typeof p.id!=='string'||!p.id||p.id.length>100||ids.has(p.id)||typeof p.name!=='string')throw new Error('部件标识无效或重复');ids.add(p.id);}
function validPositions(a){if(!(a instanceof Float32Array)||a.length%9||a.length/9>LIMITS.faces||!a.every(n=>Number.isFinite(n)&&Math.abs(n)<=1e7))throw new Error('模型数据无效或包含非有限坐标');}
export function download(data,name,type='application/octet-stream'){
  const url=URL.createObjectURL(new Blob([data],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
const localId=value=>typeof value==='string'&&/^[a-z0-9_.-]{1,100}$/i.test(value)&&!value.includes('..')?value:null;
const extraPart=p=>({visible:p.visible!==false,note:String(p.note||'').slice(0,4000),sourceFileId:localId(p.sourceFileId)});
const projectMeta=p=>({localProjectId:localId(p?.localProjectId),attribution:String(p?.attribution||'').slice(0,4000)});
export function packProject(parts,title,reference,metadata={}){
  if(!Array.isArray(parts)||parts.length>500)throw new Error('工程部件数超限，最多500件');
  const manifest={format:'pimotai',version:1,title:String(title||'模型项目').slice(0,150),parts:[],reference:!!reference,...projectMeta(metadata)};const files={},ids=new Set();let faces=0;
  parts.forEach((p,i)=>{validIdentity(p,ids);validPositions(p.positions);const matrix=p.base.toArray();validMatrix(matrix);validMatrix(p.originalMatrix);faces+=p.positions.length/9;if(faces>LIMITS.projectFaces)throw new Error('工程面数超限');const file=`part-${i}.bin`;files[file]=new Uint8Array(p.positions.buffer.slice(p.positions.byteOffset,p.positions.byteOffset+p.positions.byteLength));manifest.parts.push({id:p.id,name:p.name.slice(0,200),source:String(p.source||'').slice(0,200),color:/^#[a-f0-9]{6}$/i.test(p.color)?p.color:'#ccd7df',done:p.done===true,placement:placement(p.placement),matrix,originalMatrix:p.originalMatrix,...extraPart(p),file});});
  if(reference){validPositions(reference);faces+=reference.length/9;if(faces>LIMITS.projectFaces)throw new Error('工程及参考总面数超限');files['reference.bin']=new Uint8Array(reference.buffer.slice(reference.byteOffset,reference.byteOffset+reference.byteLength));}
  files['manifest.json']=strToU8(JSON.stringify(manifest));const packed=zipSync(files,{level:1});if(packed.byteLength>LIMITS.bytes)throw new Error('压缩工程超过150MB，请分为多个工程');return packed;
}
export function unpackProject(bytes){
  const archive=inspectZip(bytes,384*1024*1024),entries=new Map(archive.entries.map(e=>[e.name,e])),manifestEntry=entries.get('manifest.json');
  if(!manifestEntry||manifestEntry.originalSize>ZIP_LIMITS.manifest)throw new Error('不是有效的拼模台工程，或工程清单过大');
  let d;try{d=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(expandEntry(archive,manifestEntry)));}catch(error){if(error.message?.startsWith('ZIP '))throw error;throw new Error('工程清单损坏或不是有效JSON');}
  if(!d||d.format!=='pimotai'||d.version!==1||!Array.isArray(d.parts)||d.parts.length>500||typeof d.reference!=='boolean')throw new Error('不支持此工程格式');
  let faces=0;const expectedFiles=new Set(['manifest.json']),ids=new Set();
  for(const p of d.parts){validIdentity(p,ids);validMatrix(p.matrix);validMatrix(p.originalMatrix);if(typeof p.file!=='string'||!/^part-\d+\.bin$/.test(p.file)||expectedFiles.has(p.file))throw new Error('工程部件文件标识无效或重复');expectedFiles.add(p.file);}
  if(d.reference)expectedFiles.add('reference.bin');
  for(const name of entries.keys())if(!expectedFiles.has(name))throw new Error('工程含未声明的文件资源');
  for(const name of expectedFiles)if(name!=='manifest.json'){const entry=entries.get(name);if(!entry||entry.originalSize%36)throw new Error('模型数据文件缺失或损坏');faces+=entry.originalSize/36;if(faces>LIMITS.projectFaces)throw new Error('模型数据面数超限');}
  const floatData=file=>{const b=expandEntry(archive,entries.get(file)),a=new Float32Array(b.buffer);validPositions(a);return a;};
  d.parts=d.parts.map(p=>{
    return {...p,name:p.name.slice(0,200),source:String(p.source||'').slice(0,200),color:/^#[a-f0-9]{6}$/i.test(p.color)?p.color:'#ccd7df',done:p.done===true,placement:placement(p.placement),...extraPart(p),positions:floatData(p.file)};
  });
  d.reference=d.reference?floatData('reference.bin'):null;return {...d,...projectMeta(d)};
}
let dbPromise;
function db(){return dbPromise??=new Promise((resolve,reject)=>{const request=indexedDB.open('pimotai-project',1);request.onupgradeneeded=()=>request.result.createObjectStore('projects');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
export async function saveLocal(bytes){const database=await db();await new Promise((resolve,reject)=>{const tx=database.transaction('projects','readwrite');tx.objectStore('projects').put(bytes,'current');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});}
export async function loadLocal(){const database=await db();return new Promise((resolve,reject)=>{const r=database.transaction('projects').objectStore('projects').get('current');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
// Geometry is immutable in the workbench. Persist it once, then only write the
// small working manifest when color/pose/print status changes on large projects.
const storedGeometry=new WeakMap();
function analysisSummary(value,faces){
  if(!value||value.faces!==faces||!['faces','boundaryEdges','nonManifoldEdges'].every(k=>Number.isSafeInteger(value[k])&&value[k]>=0))return null;
  return {faces,closed:value.closed===true,boundaryEdges:value.boundaryEdges,nonManifoldEdges:value.nonManifoldEdges,volumeMm3:Number.isFinite(value.volumeMm3)&&value.volumeMm3>=0?value.volumeMm3:null};
}
const writerToken=crypto.randomUUID();
export async function saveLocalState(parts,title,reference,metadata={}){
  if(parts.length>500)throw new Error('工程部件数超限');
  const ids=new Set(),geometries=[],keep=new Set(),doc={storageFormat:'pimotai-local-v2',writerToken,title:String(title).slice(0,150),parts:[],reference:!!reference,...projectMeta(metadata)};let faces=0;
  for(const p of parts){
    validIdentity(p,ids);const key='geometry:part:'+p.id,matrix=p.base.toArray();validMatrix(matrix);validMatrix(p.originalMatrix);faces+=p.positions.length/9;
    if(storedGeometry.get(p.positions)!==key)validPositions(p.positions);
    geometries.push({key,value:p.positions});keep.add(key);doc.parts.push({id:p.id,name:String(p.name).slice(0,200),source:String(p.source||'').slice(0,200),color:p.color,done:p.done===true,placement:placement(p.placement),matrix,originalMatrix:p.originalMatrix,...extraPart(p),analysis:analysisSummary(p.analysis,p.positions.length/9),geometryKey:key});
  }
  if(reference){const key='geometry:reference';faces+=reference.length/9;keep.add(key);if(storedGeometry.get(reference)!==key)validPositions(reference);geometries.push({key,value:reference});}
  if(faces>LIMITS.projectFaces)throw new Error('工程及参考超过800万面');
  const database=await db();await new Promise((resolve,reject)=>{
    const tx=database.transaction('projects','readwrite'),store=tx.objectStore('projects'),prior=store.get('current-state');
    prior.onsuccess=()=>{
      // Another tab may have replaced/cleaned this cache. Rewrite this tab's
      // geometry inside the same transaction before publishing its manifest.
      const force=prior.result?.writerToken!==writerToken;
      for(const item of geometries)if(force||storedGeometry.get(item.value)!==item.key)store.put(item.value,item.key);
      store.put(doc,'current-state');store.delete('current');
      const keys=store.getAllKeys();keys.onsuccess=()=>{for(const key of keys.result)if(typeof key==='string'&&key.startsWith('geometry:')&&!keep.has(key))store.delete(key);};
    };
    tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(tx.error||new Error('本机保存中断'));
  });for(const item of geometries)storedGeometry.set(item.value,item.key);
}
export async function loadLocalState(){
  const database=await db();return new Promise((resolve,reject)=>{
    const tx=database.transaction('projects','readonly'),store=tx.objectStore('projects'),request=store.get('current-state');let result=null,faces=0;
    const fail=error=>{try{tx.abort();}catch{}reject(error);};
    request.onsuccess=()=>{
      const doc=request.result;if(!doc)return;
      try{
        if(doc.storageFormat!=='pimotai-local-v2'||!Array.isArray(doc.parts)||doc.parts.length>500)throw new Error('本机工程缓存损坏');
        const ids=new Set();result={...doc,...projectMeta(doc),parts:doc.parts.map(p=>{validIdentity(p,ids);validMatrix(p.matrix);validMatrix(p.originalMatrix);if(p.geometryKey!=='geometry:part:'+p.id)throw new Error('本机几何索引无效');return {...p,...extraPart(p)};}),reference:null};
        for(const part of result.parts){const key=part.geometryKey,r=store.get(key);r.onsuccess=()=>{try{const positions=r.result;validPositions(positions);faces+=positions.length/9;if(faces>LIMITS.projectFaces)throw new Error('本机工程面数超限');part.positions=positions;part.analysis=analysisSummary(part.analysis,positions.length/9);storedGeometry.set(positions,key);}catch(e){fail(e);}};}
        if(doc.reference){const r=store.get('geometry:reference');r.onsuccess=()=>{try{validPositions(r.result);faces+=r.result.length/9;if(faces>LIMITS.projectFaces)throw new Error('本机工程面数超限');result.reference=r.result;storedGeometry.set(r.result,'geometry:reference');}catch(e){fail(e);}};}
      }catch(e){fail(e);}
    };
    tx.oncomplete=()=>resolve(result);tx.onerror=tx.onabort=()=>reject(tx.error||new Error('本机读取中断'));
  });
}
const xml=s=>String(s).replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
export function make3mf(parts){
  if(parts.reduce((n,p)=>n+p.positions.length/9,0)>500000)throw new Error('装配3MF导出最多50万面；大型项目请逐件导出STL，或在拓竹打开登记的原件');
  const resources=[];const build=[];
  resources.push('<basematerials id="1">'+parts.map(p=>`<base name="${xml(p.name)}" displaycolor="${p.color.toUpperCase()}FF"/>`).join('')+'</basematerials>');
  parts.forEach((p,index)=>{const id=index+2,a=p.positions;let vertices='',triangles='';
    for(let i=0;i<a.length;i+=3)vertices+=`<vertex x="${a[i]}" y="${a[i+1]}" z="${a[i+2]}"/>`;
    for(let i=0;i<a.length/3;i+=3)triangles+=`<triangle v1="${i}" v2="${i+1}" v3="${i+2}" pid="1" p1="${index}"/>`;
    resources.push(`<object id="${id}" type="model" name="${xml(p.name)}"><mesh><vertices>${vertices}</vertices><triangles>${triangles}</triangles></mesh></object>`);
    const m=p.base.elements;const transform=[m[0],m[1],m[2],m[4],m[5],m[6],m[8],m[9],m[10],m[12],m[13],m[14]].join(' ');build.push(`<item objectid="${id}" transform="${transform}"/>`);
  });
  const model=`<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="zh-CN" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">拼模台</metadata><resources>${resources.join('')}</resources><build>${build.join('')}</build></model>`;
  return zipSync({'3D/3dmodel.model':strToU8(model),'[Content_Types].xml':strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'),'_rels/.rels':strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')},{level:1});
}
