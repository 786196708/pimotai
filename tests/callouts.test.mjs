import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../web/vendor/three.module.js';
import {calloutLanes,projectPartAnchor,cardConnectorEnd,calloutLayout,formatPartNote} from '../web/callouts.js';

test('all callout lanes retain every part including hidden alternatives',()=>{
  const parts=Array.from({length:175},(_,i)=>({id:`part-${i}`,visible:i<144}));
  const lanes=calloutLanes(parts,'all','part-174');
  const shown=lanes.flat();
  assert.equal(shown.length,175);
  assert.equal(new Set(shown.map(p=>p.id)).size,175);
  assert.equal(shown.filter(p=>p.visible===false).length,31);
  assert.ok(shown.includes(parts[174]),'the last hidden part remains reachable');
  assert.deepEqual(calloutLanes(parts,'selected','part-174').flat(),[parts[174]]);
  assert.deepEqual(calloutLanes(parts,'selected',null).flat(),[]);
  assert.deepEqual(calloutLanes(parts,'off','part-1').flat(),[]);
});

test('connectors use the geometry center and current world transform including explosion',()=>{
  const geometry=new T.BoxGeometry(2,2,2).translate(2,0,0);geometry.computeBoundingBox();
  const mesh=new T.Mesh(geometry),parent=new T.Group();parent.rotation.z=Math.PI/2;parent.add(mesh);
  mesh.position.x=1;parent.updateMatrixWorld(true);
  const camera=new T.OrthographicCamera(-5,5,5,-5,.1,100);camera.position.z=10;camera.updateMatrixWorld(true);
  const part={visible:true,mesh,base:new T.Matrix4().makeTranslation(99,99,99)};
  const point=projectPartAnchor(part,camera,1000,600);
  assert.ok(Math.abs(point.x-500)<1e-8);assert.ok(Math.abs(point.y-120)<1e-8);
  mesh.position.x=2;parent.updateMatrixWorld(true);
  const exploded=projectPartAnchor(part,camera,1000,600);
  assert.ok(Math.abs(exploded.x-500)<1e-8);assert.ok(Math.abs(exploded.y-60)<1e-8);
  geometry.dispose();
});

test('hidden, invisible and offscreen parts never receive invented connector positions',()=>{
  const geometry=new T.BoxGeometry();geometry.computeBoundingBox();const mesh=new T.Mesh(geometry);mesh.updateMatrixWorld();
  const camera=new T.PerspectiveCamera(60,1,.1,100);camera.position.z=10;camera.updateMatrixWorld(true);
  const part={visible:false,mesh};assert.equal(projectPartAnchor(part,camera,400,400),null);
  part.visible=true;mesh.visible=false;assert.equal(projectPartAnchor(part,camera,400,400),null);
  mesh.visible=true;mesh.position.x=100;mesh.updateMatrixWorld();assert.equal(projectPartAnchor(part,camera,400,400),null);
  mesh.position.set(0,0,20);mesh.updateMatrixWorld();assert.equal(projectPartAnchor(part,camera,400,400),null);
  geometry.dispose();
});

test('only visible card portions supply endpoints and coordinates remain inside the viewport',()=>{
  const viewport={left:100,top:50,right:900,bottom:650};
  const lane={left:112,top:100,right:312,bottom:600};
  assert.equal(cardConnectorEnd({left:112,top:10,right:300,bottom:99},lane,viewport,'left'),null);
  assert.deepEqual(cardConnectorEnd({left:112,top:70,right:300,bottom:130},lane,viewport,'left'),{x:200,y:65});
  assert.deepEqual(cardConnectorEnd({left:112,top:570,right:300,bottom:650},lane,viewport,'left'),{x:200,y:535});
});

test('two callout lanes reserve usable model space at phone and desktop widths',()=>{
  for(const width of [280,320,420,700,1000,1530]){
    const layout=calloutLayout(width);
    assert.ok(layout.laneWidth>60);
    assert.ok(layout.modelWidth>=width*.38,`${width}px retains a central model area`);
    assert.ok(layout.laneWidth*2+layout.inset*2+layout.gap*2+layout.modelWidth<=width+.01);
  }
});

test('display notes translate internal migration fields while retaining source and fitting cautions',()=>{
  const note='来源：DaDave；来源类型 kind=supplement；旧装配状态：prototype。试装说明：接缝需结合实物确认。';
  assert.equal(formatPartNote(note),'来源：DaDave；自建试装件；试装设计，需确认。试装说明：接缝需结合实物确认。');
  assert.equal(formatPartNote('来源类型 kind=alternative；旧装配状态：needs-fit。尚未定位，请勿直接打印。'),'备选分件；待定位。尚未定位，请勿直接打印。');
  assert.equal(formatPartNote('来源类型 kind=standard；旧装配状态：verified。'),'标准分件；已按参考核对摆位。');
  assert.equal(formatPartNote('已有中文来源和装配说明。'),'已有中文来源和装配说明。');
  assert.equal(formatPartNote(null),'');
});
