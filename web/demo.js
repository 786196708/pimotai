import * as T from 'three';
export function createDemo(){
  const parts=[];
  const add=(name,g,p,color='#d8e1e7',rotation=[0,0,0])=>{
    const m=new T.Matrix4().compose(new T.Vector3(...p),new T.Quaternion().setFromEuler(new T.Euler(...rotation)),new T.Vector3(1,1,1));
    const geometry=(g.index?g.toNonIndexed():g).clone();geometry.applyMatrix4(m);
    parts.push({name,positions:new Float32Array(geometry.attributes.position.array),color});g.dispose();geometry.dispose();
  };
  add('01 · 主底盘',new T.BoxGeometry(78,112,19),[0,0,28],'#c8d5e0');
  add('02 · 上盖',new T.BoxGeometry(72,93,9),[0,0,45],'#53d9bd');
  add('03 · 前防护梁',new T.BoxGeometry(78,8,14),[0,-63,29],'#354b6b');
  add('04 · 后防护梁',new T.BoxGeometry(78,8,14),[0,63,29],'#354b6b');
  add('05 · 传感器支柱',new T.CylinderGeometry(5,7,27,24),[0,-7,65],'#ced8df',[Math.PI/2,0,0]);
  add('06 · 传感器外壳',new T.SphereGeometry(12,28,18),[0,-7,91],'#dfe7ed');
  add('07 · 镜头',new T.CylinderGeometry(7.5,7.5,4,32),[0,-21,91],'#47dfcf');
  let i=8;
  for(const [x,side] of [[-49,'左'],[49,'右']])for(const [y,axle] of [[-37,'前'],[37,'后']]){
    add(`${String(i++).padStart(2,'0')} · ${side}${axle}轮`,new T.CylinderGeometry(19,19,13,40),[x,y,20],'#263a54',[0,0,Math.PI/2]);
    add(`${String(i++).padStart(2,'0')} · ${side}${axle}轮毂`,new T.CylinderGeometry(10,10,2,32),[x+Math.sign(x)*9,y,20],'#55d7bd',[0,0,Math.PI/2]);
  }
  return parts;
}
