import {LIMITS} from './project.js';
export function checkSTL(data,maxFaces=LIMITS.faces){
  const a=new Uint8Array(data);if(a.length<84)throw new Error('STL文件不完整');
  const count=new DataView(data).getUint32(80,true);
  if(84+50*count===a.length){if(count>maxFaces)throw new Error('STL超过200万面，请分批导入');return;}
  const head=new TextDecoder().decode(a.subarray(0,10));
  if(!/^.{0,4}solid/i.test(head))throw new Error('二进制STL长度与声明面数不一致');
  const text=new TextDecoder().decode(data);let faces=0,vertices=0;
  for(const _ of text.matchAll(/\bfacet\s+normal\b/gi))if(++faces>maxFaces)throw new Error('STL面数超限');
  for(const _ of text.matchAll(/\bvertex\s/gi))if(++vertices>maxFaces*3)throw new Error('STL顶点数超限');
  if(!faces||vertices!==faces*3)throw new Error('STL三角面数据不完整');
}
export function checkOBJ(text,maxFaces=LIMITS.faces){
  text=text.replace(/\r\n/g,'\n').replace(/\\\n/g,'');let faces=0,vertices=0;
  for(const line of text.split('\n')){
    const s=line.trim();if(/^v\s/.test(s)&&++vertices>maxFaces*3)throw new Error('OBJ顶点过多');
    if(/^f\s/.test(s)){const n=s.split('#')[0].trim().split(/\s+/).length-1;if(n<3)throw new Error('OBJ面数据无效');faces+=n-2;if(faces>maxFaces)throw new Error('OBJ超过200万面，请分批导入');}
  }
  if(!faces)throw new Error('OBJ中没有三角网格');return text;
}
