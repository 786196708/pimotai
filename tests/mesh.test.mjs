import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { analyzeTriangles, suggestAlignment } from '../web/core/mesh.js';

// A scalene tetrahedron: outward winding, volume = 4*6*9/6 = 36 mm³.
const TETRA = new Float32Array([
  0,0,0, 0,6,0, 4,0,0,
  0,0,0, 4,0,0, 0,0,9,
  0,0,0, 0,0,9, 0,6,0,
  4,0,0, 0,6,0, 0,0,9,
]);
const join = (...arrays) => new Float32Array(arrays.flatMap(a => [...a]));
function transform(points, m) {
  const result = new Float32Array(points.length);
  for (let i = 0; i < points.length; i += 3) {
    const [x,y,z] = points.subarray(i,i+3);
    result[i] = m[0]*x+m[4]*y+m[8]*z+m[12];
    result[i+1] = m[1]*x+m[5]*y+m[9]*z+m[13];
    result[i+2] = m[2]*x+m[6]*y+m[10]*z+m[14];
  }
  return result;
}
const MOVE = [0,1,0,0, 0,0,1,0, 1,0,0,0, 17,-11,23,1];
const SHIFT = [1,0,0,0, 0,1,0,0, 0,0,1,0, 50,0,0,1];

test('separates disconnected solids and preserves original coordinates', () => {
  const source = join(TETRA, transform(TETRA, SHIFT));
  const before = source.slice();
  const result = analyzeTriangles(source);
  assert.equal(result.components.length, 2);
  assert.deepEqual(result.components.map(c => c.faces), [4,4]);
  assert.deepEqual([...result.components[1].triangleIndices], [4,5,6,7]);
  assert.deepEqual(result.components[1].bounds.min, [50,0,0]);
  assert.deepEqual(result.components[1].bounds.size, [4,6,9]);
  assert.deepEqual(source, before);
});

test('closed tetrahedron reports its independently known volume', () => {
  const result = analyzeTriangles(TETRA);
  const component = result.components[0];
  assert.equal(component.closed, true);
  assert.equal(component.boundaryEdges, 0);
  assert.equal(component.nonManifoldEdges, 0);
  assert.ok(Math.abs(component.volumeMm3 - 36) < 1e-8);
  assert.equal(result.vertices, 4);
});

test('open plane does not claim solid volume', () => {
  const plane = new Float32Array([0,0,0, 2,0,0, 2,2,0, 0,0,0, 2,2,0, 0,2,0]);
  const { components: [c] } = analyzeTriangles(plane);
  assert.equal(c.closed, false);
  assert.equal(c.boundaryEdges, 4);
  assert.equal(c.volumeMm3, null);
});

test('validates malformed, nonfinite and oversized geometry before analysis', () => {
  assert.throws(() => analyzeTriangles(new Float32Array([0,0,0])), /9|三角/);
  const invalid = TETRA.slice(); invalid[5] = Infinity;
  assert.throws(() => analyzeTriangles(invalid), /finite|有限|非法/);
  assert.throws(() => analyzeTriangles(TETRA, {maxFaces:3}), /超|limit|面数/);
  assert.throws(() => analyzeTriangles(TETRA, {tolerance:0}), /tolerance|容差/);
  assert.equal(analyzeTriangles(new Float32Array()).components.length, 0);
});

test('reports degenerate triangles and never treats them as a closed solid', () => {
  const { components: [c], degenerateFaces } = analyzeTriangles(new Float32Array([1,2,3, 1,2,3, 1,2,3]));
  assert.equal(degenerateFaces, 1);
  assert.equal(c.degenerateFaces, 1);
  assert.equal(c.closed, false);
  assert.equal(c.volumeMm3, null);
});

test('welds across spatial hash cell boundaries within tolerance', () => {
  const positions = new Float32Array([0.099,0,0, 2,0,0, 2,2,0, 0.101,0,0, -2,0,0, -2,-2,0]);
  assert.equal(analyzeTriangles(positions,{tolerance:.01}).components.length, 1);
  assert.equal(analyzeTriangles(positions,{tolerance:.0001}).components.length, 2);
});

test('recovers a known rotation and translation against a larger reference assembly', () => {
  const target = transform(TETRA, MOVE);
  const reference = join(target, transform(TETRA, SHIFT));
  const result = suggestAlignment(TETRA, reference, {tolerance:.0001});
  // This reference contains two equivalent pieces and must not be certified unique.
  assert.equal(result.status, 'ambiguous');
  const correct = result.candidates.find(c => c.matrix.every((v,i) => Math.abs(v-MOVE[i])<1e-5));
  assert.ok(correct, 'a source→reference candidate must recover the known pose');
  assert.equal(correct.score, 1);
  assert.ok(correct.rmsErrorMm < .0001);
});

test('one asymmetric same-source piece yields one rigid placement', () => {
  const reference = transform(TETRA, MOVE);
  const result = suggestAlignment(TETRA, reference, {tolerance:.0001});
  assert.equal(result.status, 'matched');
  assert.equal(result.candidates.length, 1);
  const recovered = transform(TETRA, result.candidates[0].matrix);
  for (let i=0; i<reference.length; i++) assert.ok(Math.abs(recovered[i]-reference[i]) < .0001);
});

test('duplicated equivalent piece is ambiguous rather than arbitrarily certified', () => {
  const result = suggestAlignment(TETRA, join(TETRA,transform(TETRA,SHIFT)), {tolerance:.001});
  assert.equal(result.status,'ambiguous');
  assert.equal(result.candidates.length,2);
  assert.equal(result.requiresConfirmation,true);
});

test('incompatible scale returns unmatched without invented transforms', () => {
  const scaled = TETRA.map(v => v * 1.5);
  const result = suggestAlignment(TETRA,scaled,{tolerance:.001});
  assert.equal(result.status,'unmatched');
  assert.deepEqual(result.candidates,[]);
  assert.equal(result.confidence,0);
});

test('non-manifold shared edge and inconsistent winding cannot claim solid volume', () => {
  const duplicatedFace=join(TETRA,TETRA.subarray(0,9));
  const duplicate=analyzeTriangles(duplicatedFace).components[0];
  assert.equal(duplicate.nonManifoldEdges,3);
  assert.equal(duplicate.closed,false);
  assert.equal(duplicate.volumeMm3,null);
  const flipped=TETRA.slice();
  flipped.set(TETRA.subarray(6,9),3); flipped.set(TETRA.subarray(3,6),6);
  const reversed=analyzeTriangles(flipped).components[0];
  assert.equal(reversed.inconsistentEdges,3);
  assert.equal(reversed.closed,false);
  assert.equal(reversed.volumeMm3,null);
});

test('geometric symmetries retain multiple proper rotations', () => {
  const p=[[1,1,1],[-1,-1,1],[-1,1,-1],[1,-1,-1]];
  const regular=new Float32Array([0,2,1,0,1,3,0,3,2,1,2,3].flatMap(i=>p[i]));
  const result=suggestAlignment(regular,regular,{tolerance:.001});
  assert.equal(result.status,'ambiguous');
  assert.equal(result.candidates.length,12);
  assert.equal(result.searchLimited,false);
});

test('bounded candidate or verification search never certifies uniqueness', () => {
  const reference=join(TETRA,transform(TETRA,SHIFT));
  const capped=suggestAlignment(TETRA,reference,{tolerance:.001,maxCandidates:1});
  assert.equal(capped.searchLimited,true);
  assert.equal(capped.status,'ambiguous');
  const exhausted=suggestAlignment(TETRA,reference,{tolerance:.001,maxChecks:1});
  assert.equal(exhausted.status,'unmatched');
  assert.equal(exhausted.searchLimited,true);
});

test('analysis honors explicit vertex and component resource bounds', () => {
  assert.throws(()=>analyzeTriangles(TETRA,{maxVertices:3}),/顶点|vertex/);
  assert.throws(()=>analyzeTriangles(join(TETRA,transform(TETRA,SHIFT)),{maxComponents:1}),/部件|component/);
  assert.throws(()=>analyzeTriangles(TETRA,{tolerance:1e-300}),/容差|坐标/);
});

test('arbitrary non-axis rotation is recovered without allowing scale', () => {
  const c=Math.SQRT1_2,m=[c,c,0,0,-c,c,0,0,0,0,1,0,12.25,-7.75,4.5,1];
  const target=transform(TETRA,m);
  const result=suggestAlignment(TETRA,target,{tolerance:.0001});
  assert.equal(result.status,'matched');
  for(let i=0;i<16;i++)assert.ok(Math.abs(result.candidates[0].matrix[i]-m[i])<1e-5);
});

test('real worker transfers analysis arrays and returns task-specific errors', async () => {
  const url=new URL('../web/core/worker.js',import.meta.url).href;
  const worker=new Worker(`
    const {parentPort}=require('node:worker_threads');
    globalThis.self={postMessage:(value,transfer)=>parentPort.postMessage(value,transfer)};
    import(${JSON.stringify(url)}).then(()=>{
      parentPort.on('message',data=>self.onmessage({data}));
      parentPort.postMessage({ready:true});
    });
  `,{eval:true});
  try {
    await once(worker,'message');
    const positions=TETRA.slice();
    const response=once(worker,'message');
    worker.postMessage({id:'geometry',type:'analyze',positions:positions.buffer},[positions.buffer]);
    assert.equal(positions.byteLength,0);
    const [message]=await response;
    assert.equal(message.id,'geometry');
    assert.equal(message.result.components[0].volumeMm3,36);
    assert.ok(message.result.components[0].triangleIndices instanceof Uint32Array);
    assert.deepEqual([...message.result.components[0].triangleIndices],[0,1,2,3]);
    const errorResponse=once(worker,'message');
    worker.postMessage({id:'unknown',type:'unexpected',positions:new ArrayBuffer(0)});
    const [error]=await errorResponse;
    assert.equal(error.id,'unknown');
    assert.match(error.error,/未知/);
  } finally { await worker.terminate(); }
});
