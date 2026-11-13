import { analyzeTriangles, suggestAlignment } from './mesh.js';

// A module worker can be terminated by the caller to cancel expensive work.
// Input ownership is transferred in; only analysis result arrays are transferred out.
self.onmessage = ({data}) => {
  const id=data?.id;
  try {
    if (!data || !(data.positions instanceof ArrayBuffer) || data.positions.byteLength%4) throw new TypeError('positions 必须是 Float32 坐标 ArrayBuffer');
    const positions=new Float32Array(data.positions);
    let result;
    const transfer=[];
    if (data.type==='analyze') {
      result=analyzeTriangles(positions,data.options);
      for (const c of result.components) transfer.push(c.triangleIndices.buffer);
    } else if (data.type==='align') {
      if (!(data.reference instanceof ArrayBuffer) || data.reference.byteLength%4) throw new TypeError('reference 必须是 Float32 坐标 ArrayBuffer');
      result=suggestAlignment(positions,new Float32Array(data.reference),data.options);
    } else throw new RangeError(`未知几何任务类型：${String(data.type)}`);
    self.postMessage({id,result},transfer);
  } catch (error) {
    self.postMessage({id,error:error instanceof Error ? error.message : String(error)});
  }
};
