import {preflight3mf,LIMITS} from './project.js';
// Three r180 ignores 3MF units and production cross-file components. Reject
// unsupported structures explicitly before the loader allocates/clones meshes.
export function checked3mf(data){
  const archive=preflight3mf(data);
  if(archive.models.length!==1)throw new Error('首版支持单模型文档的标准3MF；多文档模型请先从切片软件导出STL');
  const text=archive.models[0].text;
  if(/<!DOCTYPE|<!ENTITY/i.test(text))throw new Error('3MF中含不支持的XML实体');
  const doc=new DOMParser().parseFromString(text,'application/xml');
  if(doc.querySelector('parsererror')||doc.documentElement.localName!=='model')throw new Error('3MF模型XML无效');
  const units={micron:.001,millimeter:1,centimeter:10,inch:25.4,foot:304.8,meter:1000};
  const factor=units[doc.documentElement.getAttribute('unit')||'millimeter'];
  if(!factor)throw new Error('3MF单位不支持');
  for(const node of doc.querySelectorAll('[transform]')){const v=node.getAttribute('transform').trim().split(/\s+/).map(Number);if(v.length!==12||!v.every(Number.isFinite))throw new Error('3MF变换矩阵无效');}
  const nodes=[...doc.getElementsByTagNameNS('*','object')],objects=new Map();
  if(nodes.length>5000)throw new Error('3MF对象过多，请分批导入');
  for(const node of nodes){const id=node.getAttribute('id');if(!id||objects.has(id))throw new Error('3MF对象标识重复或无效');objects.set(id,node);}
  let faces=0,vertices=0,expandedTotal=0,instanceTotal=0;
  for(const node of nodes){faces+=node.getElementsByTagNameNS('*','triangle').length;vertices+=node.getElementsByTagNameNS('*','vertex').length;}
  if(faces>LIMITS.faces||vertices>LIMITS.faces*3)throw new Error('3MF网格过大，请分批导入');
  const cache=new Map(),stack=new Set();
  function visit(id,depth=0){
    if(depth>64||stack.has(id))throw new Error('3MF装配包含循环或过深的嵌套');
    if(cache.has(id))return cache.get(id);
    const node=objects.get(id);if(!node)throw new Error('3MF引用了缺失对象');stack.add(id);
    let count=node.getElementsByTagNameNS('*','triangle').length,instances=1;
    for(const c of node.getElementsByTagNameNS('*','component')){
      if([...c.attributes].some(a=>a.localName==='path'))throw new Error('首版暂不支持跨文档3MF装配，请导出STL后导入');
      const child=visit(c.getAttribute('objectid'),depth+1);count+=child.count;instances+=child.instances;
      if(count>LIMITS.faces||instances>20000)throw new Error('3MF装配展开后过大');
    }
    stack.delete(id);const result={count,instances};cache.set(id,result);return result;
  }
  for(const id of objects.keys()){const c=visit(id);expandedTotal+=c.count;instanceTotal+=c.instances;if(expandedTotal>LIMITS.faces||instanceTotal>20000)throw new Error('3MF嵌套装配过大，请简化后导入');}
  let built=0,builtInstances=0;
  for(const item of doc.getElementsByTagNameNS('*','item')){const c=visit(item.getAttribute('objectid'));built+=c.count;builtInstances+=c.instances;}
  if(built>LIMITS.faces||builtInstances>20000)throw new Error('3MF摆盘实例过多，请分批导入');
  return {files:archive.files,factor};
}
