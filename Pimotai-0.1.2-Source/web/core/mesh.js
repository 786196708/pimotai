// Pure non-indexed triangle geometry. Coordinates are never rewritten or normalized.
const MAX_FACES = 2_000_000;
const MAX_ALIGN_FACES = 200_000;
const PERMUTATIONS = [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]];

function positive(value, fallback, name) {
  const n = value ?? fallback;
  if (!Number.isFinite(n) || n <= 0) throw new RangeError(`${name} 必须是大于 0 的有限数值`);
  return n;
}

function validate(positions, maxFaces, label = '模型', tolerance) {
  if (!(positions instanceof Float32Array)) throw new TypeError(`${label} positions 必须是 Float32Array`);
  if (positions.length % 9 !== 0) throw new RangeError(`${label}三角形坐标长度必须是 9 的倍数`);
  const faces = positions.length / 9;
  if (faces > maxFaces) throw new RangeError(`${label}面数 ${faces.toLocaleString()} 超过上限 ${maxFaces.toLocaleString()}；请先简化模型`);
  for (let i = 0; i < positions.length; i++) {
    if (!Number.isFinite(positions[i])) throw new RangeError(`${label}在坐标 ${i} 包含非法非有限数值 (non-finite)`);
    if (tolerance && Math.abs(positions[i]/tolerance)>Number.MAX_SAFE_INTEGER-2) throw new RangeError(`${label}坐标量级与容差不相容；请调整单位、容差或先将模型移近原点`);
  }
  return faces;
}

const key = (x,y,z) => `${x},${y},${z}`;
function emptyBounds() { return {min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity],size:[0,0,0]}; }
function extendBounds(bounds, positions, start, end) {
  for (let i=start; i<end; i+=3) for (let a=0; a<3; a++) {
    bounds.min[a] = Math.min(bounds.min[a],positions[i+a]);
    bounds.max[a] = Math.max(bounds.max[a],positions[i+a]);
  }
}
function finishBounds(bounds) {
  if (bounds.min[0] === Infinity) bounds.min = bounds.max = [0,0,0];
  bounds.size = bounds.max.map((v,i) => v-bounds.min[i]);
  return bounds;
}

/** Vertex welding uses a tolerance-sized spatial hash and all 27 neighboring cells. */
function weld(positions, tolerance, maxVertices) {
  const count = positions.length/3;
  const representatives = new Uint32Array(count);
  const ids = new Uint32Array(count);
  const cells = new Map();
  const tolerance2 = tolerance*tolerance;
  let vertices = 0;
  for (let v=0; v<count; v++) {
    const i=v*3, x=positions[i],y=positions[i+1],z=positions[i+2];
    const gx=Math.floor(x/tolerance),gy=Math.floor(y/tolerance),gz=Math.floor(z/tolerance);
    let found=-1;
    for (let dx=-1; dx<=1 && found<0; dx++) for (let dy=-1; dy<=1 && found<0; dy++) for (let dz=-1; dz<=1 && found<0; dz++) {
      const bucket=cells.get(key(gx+dx,gy+dy,gz+dz));
      if (!bucket) continue;
      for (const id of bucket) {
        const r=representatives[id];
        const a=x-positions[r],b=y-positions[r+1],c=z-positions[r+2];
        if (a*a+b*b+c*c <= tolerance2) { found=id; break; }
      }
    }
    if (found<0) {
      if (vertices>=maxVertices) throw new RangeError(`焊接后顶点数超过安全上限 ${maxVertices.toLocaleString()}；请先简化模型`);
      found=vertices++;
      representatives[found]=i;
      const cellKey=key(gx,gy,gz);
      const bucket=cells.get(cellKey);
      if (bucket) bucket.push(found); else cells.set(cellKey,[found]);
    }
    ids[v]=found;
  }
  return {ids,vertices};
}

/**
 * Connected components mean shared welded vertices, not inferred semantic parts.
 * Degenerates remain selectable and reported, but never contribute fake solid volume.
 */
export function analyzeTriangles(positions, options = {}) {
  const tolerance=positive(options.tolerance,1e-4,'焊接容差 tolerance');
  const maxFaces=Math.min(MAX_FACES,positive(options.maxFaces,MAX_FACES,'maxFaces'));
  const maxVertices=Math.min(3_000_000,positive(options.maxVertices,1_500_000,'maxVertices'));
  const maxComponents=Math.min(100_000,positive(options.maxComponents,50_000,'maxComponents'));
  const faces=validate(positions,maxFaces,'模型',tolerance);
  const {ids,vertices}=weld(positions,tolerance,maxVertices);
  const parents=new Int32Array(faces),ranks=new Uint8Array(faces);
  const firstTriangle=new Int32Array(vertices); firstTriangle.fill(-1);
  for (let f=0; f<faces; f++) parents[f]=f;
  function root(f) {
    while (parents[f]!==f) { parents[f]=parents[parents[f]]; f=parents[f]; }
    return f;
  }
  function union(a,b) {
    a=root(a); b=root(b); if (a===b) return;
    if (ranks[a]<ranks[b]) [a,b]=[b,a];
    parents[b]=a; if (ranks[a]===ranks[b]) ranks[a]++;
  }
  const degenerate=new Uint8Array(faces);
  let degenerateFaces=0;
  for (let f=0; f<faces; f++) {
    const v=f*3,i=f*9;
    for (let a=0; a<3; a++) {
      const id=ids[v+a];
      if (firstTriangle[id]<0) firstTriangle[id]=f; else union(f,firstTriangle[id]);
    }
    const ux=positions[i+3]-positions[i],uy=positions[i+4]-positions[i+1],uz=positions[i+5]-positions[i+2];
    const vx=positions[i+6]-positions[i],vy=positions[i+7]-positions[i+1],vz=positions[i+8]-positions[i+2];
    const nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx;
    const edge2=Math.max(ux*ux+uy*uy+uz*uz,vx*vx+vy*vy+vz*vz,(ux-vx)**2+(uy-vy)**2+(uz-vz)**2);
    if (ids[v]===ids[v+1] || ids[v]===ids[v+2] || ids[v+1]===ids[v+2] || nx*nx+ny*ny+nz*nz <= tolerance*tolerance*edge2) {
      degenerate[f]=1; degenerateFaces++;
    }
  }
  const componentByRoot=new Map(),components=[],faceComponent=new Uint32Array(faces);
  for (let f=0; f<faces; f++) {
    const r=root(f);
    let index=componentByRoot.get(r);
    if (index===undefined) {
      if (components.length>=maxComponents) throw new RangeError(`断开部件数超过安全上限 ${maxComponents.toLocaleString()}；请先清理碎面或简化模型`);
      index=components.length; componentByRoot.set(r,index);
      components.push({triangleIndices:null,bounds:emptyBounds(),faces:0,validFaces:0,degenerateFaces:0,closed:false,boundaryEdges:0,nonManifoldEdges:0,inconsistentEdges:0,orientationConsistent:true,volumeMm3:null});
    }
    faceComponent[f]=index;
    const c=components[index]; c.faces++;
    if (degenerate[f]) c.degenerateFaces++; else c.validFaces++;
    extendBounds(c.bounds,positions,f*9,f*9+9);
  }
  const offsets=new Uint32Array(components.length);
  for (const c of components) { c.triangleIndices=new Uint32Array(c.faces); finishBounds(c.bounds); }
  for (let f=0; f<faces; f++) { const c=faceComponent[f]; components[c].triangleIndices[offsets[c]++]=f; }

  // Numeric edge keys avoid millions of object/string edge records. The maximum
  // key at MAX_FACES is < 2^53, so this packed integer is exact in Float64.
  const edgeCodes=new Float64Array((faces-degenerateFaces)*3);
  let edgeOffset=0;
  for (let f=0; f<faces; f++) if (!degenerate[f]) {
    const v=f*3;
    for (let a=0; a<3; a++) {
      const u=ids[v+a],w=ids[v+(a+1)%3];
      edgeCodes[edgeOffset++]=(Math.min(u,w)*vertices+Math.max(u,w))*2+(u<w?0:1);
    }
  }
  edgeCodes.sort();
  for (let i=0; i<edgeCodes.length;) {
    const edge=Math.floor(edgeCodes[i]/2);
    let j=i,direction=0;
    while (j<edgeCodes.length && Math.floor(edgeCodes[j]/2)===edge) { direction += edgeCodes[j]%2 ? -1 : 1; j++; }
    const vertex=Math.floor(edge/vertices),c=components[faceComponent[firstTriangle[vertex]]],count=j-i;
    if (count===1) c.boundaryEdges++;
    else if (count>2) c.nonManifoldEdges++;
    else if (direction!==0) c.inconsistentEdges++;
    i=j;
  }
  let boundaryEdges=0,nonManifoldEdges=0,inconsistentEdges=0,volumeMm3=0;
  for (const c of components) {
    boundaryEdges+=c.boundaryEdges; nonManifoldEdges+=c.nonManifoldEdges; inconsistentEdges+=c.inconsistentEdges;
    c.orientationConsistent=c.inconsistentEdges===0;
    c.closed=c.validFaces>0 && c.degenerateFaces===0 && c.boundaryEdges===0 && c.nonManifoldEdges===0 && c.orientationConsistent;
    if (!c.closed) { volumeMm3=null; continue; }
    const origin=c.bounds.min;
    let sum=0,compensation=0;
    for (const f of c.triangleIndices) {
      const i=f*9;
      const ax=positions[i]-origin[0],ay=positions[i+1]-origin[1],az=positions[i+2]-origin[2];
      const bx=positions[i+3]-origin[0],by=positions[i+4]-origin[1],bz=positions[i+5]-origin[2];
      const cx=positions[i+6]-origin[0],cy=positions[i+7]-origin[1],cz=positions[i+8]-origin[2];
      const value=(ax*(by*cz-bz*cy)+ay*(bz*cx-bx*cz)+az*(bx*cy-by*cx))/6-compensation;
      const next=sum+value; compensation=(next-sum)-value; sum=next;
    }
    c.volumeMm3=Math.abs(sum);
    if (volumeMm3!==null) volumeMm3+=c.volumeMm3;
  }
  const bounds=emptyBounds(); extendBounds(bounds,positions,0,positions.length); finishBounds(bounds);
  const totals={faces,totalFaces:faces,validFaces:faces-degenerateFaces,vertices,weldedVertices:vertices,degenerateFaces,boundaryEdges,nonManifoldEdges,inconsistentEdges,closedComponents:components.filter(c=>c.closed).length,volumeMm3,bounds};
  return {components,...totals,totals,tolerance};
}

function point(positions,index) { return [positions[index],positions[index+1],positions[index+2]]; }
const sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const length=a=>Math.hypot(...a);
const unit=a=>{const n=length(a); return a.map(v=>v/n);};
function triangle(positions,face) { return [point(positions,face*9),point(positions,face*9+3),point(positions,face*9+6)]; }
function lengths(t) { return [length(sub(t[1],t[0])),length(sub(t[2],t[1])),length(sub(t[0],t[2]))].sort((a,b)=>a-b); }
function triangleUsable(t,tolerance) {
  const a=sub(t[1],t[0]),b=sub(t[2],t[0]);
  return length(cross(a,b)) > tolerance*Math.max(length(a),length(b));
}
function frame(t) {
  const u=unit(sub(t[1],t[0])),n=unit(cross(u,sub(t[2],t[0]))),v=cross(n,u);
  return [u,v,n];
}
function rigidMatrix(source,target) {
  const a=frame(source),b=frame(target),m=[0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,1];
  for (let column=0; column<3; column++) for (let row=0; row<3; row++) {
    m[column*4+row]=b[0][row]*a[0][column]+b[1][row]*a[1][column]+b[2][row]*a[2][column];
  }
  for (let row=0; row<3; row++) m[12+row]=target[0][row]-(m[row]*source[0][0]+m[4+row]*source[0][1]+m[8+row]*source[0][2]);
  return m;
}
function transformed(p,m) { return [m[0]*p[0]+m[4]*p[1]+m[8]*p[2]+m[12],m[1]*p[0]+m[5]*p[1]+m[9]*p[2]+m[13],m[2]*p[0]+m[6]*p[1]+m[10]*p[2]+m[14]]; }

// At most 128 distinct points per cell prevents pathological dense input from
// causing quadratic nearest-point work. A rejected model receives a clear error.
class PointIndex {
  constructor(tolerance) { this.tolerance=tolerance; this.cells=new Map(); }
  add(p) {
    const cellKey=key(...p.map(v=>Math.floor(v/this.tolerance)));
    let bucket=this.cells.get(cellKey);
    if (!bucket) { this.cells.set(cellKey,[p]); return; }
    if (bucket.some(q=>p[0]===q[0] && p[1]===q[1] && p[2]===q[2])) return;
    if (bucket.length>=128) throw new RangeError('参考模型局部顶点过密；请减小匹配容差或先简化模型');
    bucket.push(p);
  }
  distance2(p) {
    const g=p.map(v=>Math.floor(v/this.tolerance));
    let best=Infinity;
    for (let x=-1;x<=1;x++) for(let y=-1;y<=1;y++) for(let z=-1;z<=1;z++) {
      const bucket=this.cells.get(key(g[0]+x,g[1]+y,g[2]+z));
      if (!bucket) continue;
      for (const q of bucket) {
        const d=(p[0]-q[0])**2+(p[1]-q[1])**2+(p[2]-q[2])**2;
        if (d<best) best=d;
        if (best===0) return 0;
      }
    }
    return best;
  }
}

function samples(positions,maxVertices,maxCenters) {
  const vertices=[],centers=[],seen=new Set(),n=positions.length/3,faces=positions.length/9;
  const steps=Math.min(n,maxVertices*4);
  for (let i=0;i<steps && vertices.length<maxVertices;i++) {
    const offset=Math.floor(i*n/steps)*3,p=point(positions,offset),k=key(...p);
    if (!seen.has(k)) { seen.add(k); vertices.push(p); }
  }
  const count=Math.min(faces,maxCenters);
  for (let i=0;i<count;i++) {
    const t=triangle(positions,Math.floor(i*faces/count));
    centers.push([0,1,2].map(a=>(t[0][a]+t[1][a]+t[2][a])/3));
  }
  return {vertices,centers};
}

/**
 * Same-source, same-scale rigid candidates, with identical triangulation expected.
 * This is deliberately not semantic reconstruction or a general ICP/AI solver.
 * Matching is sampled evidence, never an assembly/collision/printability guarantee.
 */
export function suggestAlignment(sourcePositions, referencePositions, options = {}) {
  const tolerance=positive(options.tolerance,.1,'匹配容差 tolerance');
  const maxFaces=Math.min(MAX_ALIGN_FACES,positive(options.maxFaces,MAX_ALIGN_FACES,'maxFaces'));
  const sourceFaces=validate(sourcePositions,maxFaces,'散件',tolerance),referenceFaces=validate(referencePositions,maxFaces,'参考模型',tolerance);
  const maxCandidates=Math.min(64,Math.max(1,Math.floor(positive(options.maxCandidates,24,'maxCandidates'))));
  const maxTrials=Math.min(20_000,Math.max(1,Math.floor(positive(options.maxTrials,4000,'maxTrials'))));
  const maxChecks=Math.min(1_000_000,Math.max(1,Math.floor(positive(options.maxChecks,250_000,'maxChecks'))));
  const unmatched=reason=>({status:'unmatched',confidence:0,candidates:[],requiresConfirmation:true,searchLimited:false,reason,tolerance});
  if (!sourceFaces || !referenceFaces) return unmatched('散件或参考模型为空');
  const step=tolerance*2,signature=l=>key(...l.map(v=>Math.round(v/step)));
  const signatures=new Map();
  for (let f=0;f<referenceFaces;f++) {
    const t=triangle(referencePositions,f);
    if (!triangleUsable(t,tolerance)) continue;
    const l=lengths(t),s=signature(l),entry={face:f,lengths:l};
    const list=signatures.get(s);
    if (list) list.push(entry); else signatures.set(s,[entry]);
  }
  // Any true identical-triangulation mapping must contain this source triangle.
  // Choose a rare signature among 32 distributed anchors to keep search bounded.
  let anchor=null,matches=null;
  const anchors=Math.min(32,sourceFaces);
  for (let i=0;i<anchors;i++) {
    const face=Math.floor(i*sourceFaces/anchors),t=triangle(sourcePositions,face);
    if (!triangleUsable(t,tolerance)) continue;
    const l=lengths(t),g=l.map(v=>Math.round(v/step)),entries=[];
    const seenKeys=new Set();
    for (let x=-1;x<=1;x++) for(let y=-1;y<=1;y++) for(let z=-1;z<=1;z++) {
      const k=key(g[0]+x,g[1]+y,g[2]+z); if(seenKeys.has(k)) continue; seenKeys.add(k);
      const bucket=signatures.get(k); if (!bucket) continue;
      for (const entry of bucket) if (entry.lengths.every((n,a)=>Math.abs(n-l[a])<=2*tolerance)) entries.push(entry.face);
    }
    if (!entries.length) return unmatched('未找到相同尺度、相同三角形结构的参考位置');
    if (matches===null || entries.length<matches.length) { anchor={face,t}; matches=entries; }
  }
  if (!anchor) return unmatched('散件没有足够稳定的非退化三角形');
  const vertexIndex=new PointIndex(tolerance),centerIndex=new PointIndex(tolerance);
  for (let i=0;i<referencePositions.length;i+=3) vertexIndex.add(point(referencePositions,i));
  for (let f=0;f<referenceFaces;f++) {
    const t=triangle(referencePositions,f);
    centerIndex.add([0,1,2].map(a=>(t[0][a]+t[1][a]+t[2][a])/3));
  }
  const sampled=samples(sourcePositions,2048,512),tolerance2=tolerance*tolerance,candidates=[];
  let trials=0,checks=0,searchLimited=false;
  const anchorLengths=[length(sub(anchor.t[1],anchor.t[0])),length(sub(anchor.t[2],anchor.t[1])),length(sub(anchor.t[0],anchor.t[2]))];
  outer: for (const face of matches) {
    const target=triangle(referencePositions,face);
    for (const permutation of PERMUTATIONS) {
      const t=permutation.map(i=>target[i]);
      const lengthsOrdered=[length(sub(t[1],t[0])),length(sub(t[2],t[1])),length(sub(t[0],t[2]))];
      if (!lengthsOrdered.every((n,i)=>Math.abs(n-anchorLengths[i])<=2*tolerance)) continue;
      if (trials++>=maxTrials) { searchLimited=true; break outer; }
      const matrix=rigidMatrix(anchor.t,t);
      if (candidates.some(c=>c.matrix.every((v,i)=>Math.abs(v-matrix[i])< (i>=12 && i<=14 ? tolerance*.25 : 1e-6)))) continue;
      let sum2=0,maxError2=0,count=0,valid=true;
      for (const [points,index] of [[sampled.vertices,vertexIndex],[sampled.centers,centerIndex]]) {
        for (const p of points) {
          if (checks++>=maxChecks) { searchLimited=true; break outer; }
          const d=index.distance2(transformed(p,matrix));
          if (d>tolerance2) { valid=false; break; }
          count++; sum2+=d; maxError2=Math.max(maxError2,d);
        }
        if (!valid) break;
      }
      if (!valid) continue;
      candidates.push({matrix,score:1,rmsErrorMm:Math.sqrt(sum2/count),maxErrorMm:Math.sqrt(maxError2),matchedSamples:count,totalSamples:count,sourceTriangle:anchor.face,referenceTriangle:face});
      if (candidates.length>=maxCandidates) { searchLimited=true; break outer; }
    }
  }
  if (!candidates.length) return {...unmatched(searchLimited?'候选搜索达到上限，尚未核验可用位置':'三角形相似，但采样顶点和面心未通过刚性位置核验'),searchLimited,trials,checks};
  candidates.sort((a,b)=>a.rmsErrorMm-b.rmsErrorMm);
  const status=candidates.length>1 || searchLimited ? 'ambiguous' : 'matched';
  return {status,confidence:searchLimited?.75:.99,candidates,requiresConfirmation:true,searchLimited,trials,checks,tolerance,sampledVertices:sampled.vertices.length,sampledTriangles:sampled.centers.length,reason:status==='matched'?'找到一个通过采样核验的同源刚性候选，请目视确认':'存在重复、对称或未搜索完的位置，必须人工确认'};
}
