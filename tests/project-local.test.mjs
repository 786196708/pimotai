import test from 'node:test';
import assert from 'node:assert/strict';
import {packProject,unpackProject,LIMITS,make3mf} from '../web/project.js';
const I=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const piece=(id,positions=new Float32Array([0,0,0,1,0,0,0,1,0]))=>({id,name:id,source:'原始分件.stl',positions,color:'#aa2432',done:false,placement:'manual',base:{toArray:()=>[...I]},originalMatrix:[...I],visible:false,note:'内部件，待定位',sourceFileId:id});
test('registered project binding, visibility and source-file identity survive save/reopen',()=>{
 const d=unpackProject(packProject([piece('helmet')],'本机装甲',null,{localProjectId:'mk6-local',attribution:'DaDave / Thingiverse'}));
 assert.equal(d.localProjectId,'mk6-local');assert.equal(d.attribution,'DaDave / Thingiverse');assert.equal(d.parts[0].visible,false);assert.equal(d.parts[0].note,'内部件，待定位');assert.equal(d.parts[0].sourceFileId,'helmet');
});
test('optional local binding cannot become an arbitrary path',()=>{
 const p=piece('one');p.sourceFileId='../secret';const d=unpackProject(packProject([p],'test',null,{localProjectId:'../outside'}));assert.equal(d.localProjectId,null);assert.equal(d.parts[0].sourceFileId,null);
});
test('assembled multi-file projects can exceed the per-file analysis budget',()=>{
 const a=new Float32Array((LIMITS.faces/2+1)*9);a[a.length-1]=37;
 const d=unpackProject(packProject([piece('one',a),piece('two',a)],'大装配'));
 assert.equal(d.parts.reduce((n,p)=>n+p.positions.length/9,0),LIMITS.faces+2);assert.equal(d.parts[1].positions.at(-1),37);
});
test('large assembly XML export refuses before allocating giant strings',()=>{
 const p=piece('large',new Float32Array(500001*9));assert.throws(()=>make3mf([p]),/50万面/);
});
