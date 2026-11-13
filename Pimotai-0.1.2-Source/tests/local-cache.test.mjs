import test from 'node:test';
import assert from 'node:assert/strict';

// This is a small deterministic IDB test double, not a browser emulator. It only
// models the requests used here and serializes transactions so a queued writer
// cannot run between reads belonging to the same readonly transaction.
function localDatabase(){
  const data=new Map(),waiting=[];let active=false,afterRead=null;
  function runNext(){
    if(active||!waiting.length)return;active=true;
    const tx=waiting.shift();
    async function drain(){
      while(tx.requests.length){
        const {request,operation,key}=tx.requests.shift();
        try{request.result=operation();if(key!==undefined)afterRead?.(key);request.onsuccess?.();}
        catch(error){request.error=error;request.onerror?.();tx.error=error;tx.onerror?.();active=false;runNext();return;}
        await Promise.resolve();
      }
      tx.oncomplete?.();active=false;runNext();
    }
    setImmediate(drain);
  }
  const database={transaction(){
    const tx={requests:[],objectStore:()=>store};
    function request(operation,key){const result={};tx.requests.push({request:result,operation,key});return result;}
    const store={
      put(value,key){const copy=structuredClone(value);return request(()=>data.set(key,copy));},
      delete(key){return request(()=>data.delete(key));},
      get(key){return request(()=>structuredClone(data.get(key)),key);},
      getAllKeys(){return request(()=>[...data.keys()]);},
    };
    waiting.push(tx);setImmediate(runNext);return tx;
  }};
  return {data,database,setAfterRead:callback=>{afterRead=callback;},indexedDB:{open(){const r={};queueMicrotask(()=>{r.result=database;r.onsuccess?.();});return r;}}};
}
const I=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const piece=(id,x=0)=>({id,name:id,positions:new Float32Array([x,0,0,x+1,0,0,x,1,0]),color:'#aa2432',done:false,base:{toArray:()=>[...I]},originalMatrix:[...I]});
let sequence=0;
async function tabs(){
  const cache=localDatabase();globalThis.indexedDB=cache.indexedDB;
  const a=await import(`../web/project.js?local-cache-test=${++sequence}`);
  const b=await import(`../web/project.js?local-cache-test=${++sequence}`);
  return {cache,a,b};
}

test('alternating tabs can save metadata after another project deleted their old geometry',async()=>{
  const {cache,a,b}=await tabs(),one=piece('project-a'),two=piece('project-b');
  await a.saveLocalState([one],'A');await b.saveLocalState([two],'B');
  one.done=true;await a.saveLocalState([one],'A');
  assert.ok(cache.data.has('geometry:part:project-a'),'the final manifest must retain its geometry');
  const restored=await a.loadLocalState();
  assert.equal(restored.title,'A');assert.equal(restored.parts[0].done,true);
  assert.deepEqual(restored.parts[0].positions,one.positions);
});

test('a tab rewrites stale same-id geometry instead of retaining another tab\'s coordinates',async()=>{
  const {a,b}=await tabs(),one=piece('shared',0),two=piece('shared',100);
  await a.saveLocalState([one],'A');await b.saveLocalState([two],'B');
  one.done=true;await a.saveLocalState([one],'A');
  const restored=await a.loadLocalState();
  assert.equal(restored.title,'A');assert.deepEqual(restored.parts[0].positions,one.positions);
});

test('manifest and geometry are restored from one readonly transaction snapshot',async()=>{
  const {cache,a}=await tabs(),one=piece('project-a');await a.saveLocalState([one],'A');
  cache.setAfterRead(key=>{
    if(key!=='current-state')return;cache.setAfterRead(null);
    // Queue a competing writer immediately after the manifest read, ahead of
    // any new transactions the implementation might create for geometry reads.
    const store=cache.database.transaction('projects','readwrite').objectStore('projects');
    store.put({...cache.data.get('current-state'),title:'B',parts:[]},'current-state');
    store.delete('geometry:part:project-a');
  });
  const restored=await a.loadLocalState();
  assert.equal(restored.title,'A');assert.deepEqual(restored.parts[0].positions,one.positions);
});
