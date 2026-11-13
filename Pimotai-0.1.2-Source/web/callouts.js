import {Vector3} from './vendor/three.module.js';

export function formatPartNote(note){
  return String(note||'').replace(/来源类型 kind=([^；]+)；旧装配状态：([^。]+)。/g,(_,kind,status)=>
    ({standard:'标准分件',alternative:'备选分件',supplement:'自建试装件'}[kind]||'模型分件')+'；'+
    ({verified:'已按参考核对摆位',prototype:'试装设计，需确认',estimated:'摆位示意，需确认',internal:'内部结构件',unresolved:'待定位','needs-fit':'待定位'}[status]||'需确认')+'。');
}

// Cards retain the project order and identity, including parts outside the assembly.
export function calloutLanes(parts,mode='all',selected=null){
  const lanes=[[],[]];
  if(mode==='off')return lanes;
  parts.forEach((part,index)=>{if(mode==='all'||part.id===selected)lanes[index%2].push(part);});
  return lanes;
}

export function calloutLayout(width){
  const inset=Math.min(12,width*.025),gap=Math.min(16,width*.015),laneWidth=Math.min(226,Math.max(64,width*.245));
  return {inset,gap,laneWidth,modelWidth:Math.max(1,width-2*(inset+gap+laneWidth))};
}

export function projectPartAnchor(part,camera,width,height,target=new Vector3()){
  const mesh=part.mesh;
  if(part.visible===false||!mesh?.visible||!mesh.geometry.boundingBox)return null;
  for(let parent=mesh.parent;parent;parent=parent.parent)if(!parent.visible)return null;
  // matrixWorld contains the current exploded/manual transform and the root rotation.
  mesh.geometry.boundingBox.getCenter(target).applyMatrix4(mesh.matrixWorld).project(camera);
  if(![target.x,target.y,target.z].every(Number.isFinite)||Math.abs(target.x)>1||Math.abs(target.y)>1||Math.abs(target.z)>1)return null;
  return {x:(target.x+1)*width/2,y:(1-target.y)*height/2};
}

export function cardConnectorEnd(card,lane,viewport,side){
  const top=Math.max(card.top,lane.top,viewport.top),bottom=Math.min(card.bottom,lane.bottom,viewport.bottom);
  const left=Math.max(card.left,lane.left,viewport.left),right=Math.min(card.right,lane.right,viewport.right);
  if(bottom<=top||right<=left)return null;
  return {x:(side==='left'?right:left)-viewport.left,y:(top+bottom)/2-viewport.top};
}

export function createPartCallouts({host,modeControl,count,camera,onSelect,onTogglePrinted}){
  const lanes=[host.querySelector('#callout-left'),host.querySelector('#callout-right')];
  const svg=host.querySelector('svg'),cards=new Map(),anchor=new Vector3();
  let parts=[],selected=null,mode='all',dirty=true,visibleCards=[],viewport=null,lastDraw=0;
  const markDirty=()=>{dirty=true;};
  for(const lane of lanes)lane.addEventListener('scroll',markDirty,{passive:true});
  window.addEventListener('scroll',markDirty,{passive:true});

  function makeCard(part){
    const card=document.createElement('article');card.className='model-callout';card.dataset.partId=part.id;
    const select=document.createElement('button');select.type='button';select.className='callout-select';
    const image=document.createElement('img');image.alt='';image.width=44;image.height=44;
    const name=document.createElement('span');name.className='callout-name';
    select.append(image,name);select.onclick=()=>onSelect(part.id);
    const status=document.createElement('span');status.className='callout-status';
    const printed=document.createElement('button');printed.type='button';printed.className='callout-print';
    printed.onclick=event=>{event.stopPropagation();onTogglePrinted(part.id);};
    card.onclick=event=>{if(!event.target.closest('button'))onSelect(part.id);};
    card.append(select,status,printed);
    const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.dataset.partId=part.id;
    const dot=document.createElementNS('http://www.w3.org/2000/svg','circle');dot.setAttribute('r','2.6');
    path.style.display=dot.style.display='none';svg.append(path,dot);
    const entry={card,select,image,name,status,printed,path,dot,part,thumb:null};cards.set(part.id,entry);return entry;
  }

  function render(nextParts=parts,nextSelected=selected){
    parts=nextParts;selected=nextSelected;mode=modeControl.value;
    const ids=new Set(parts.map(part=>part.id));
    for(const [id,entry] of cards)if(!ids.has(id)){entry.card.remove();entry.path.remove();entry.dot.remove();cards.delete(id);}
    const groups=calloutLanes(parts,mode,selected),shown=new Set(groups.flat().map(part=>part.id));
    for(const part of parts){
      const entry=cards.get(part.id)||makeCard(part);entry.part=part;
      entry.card.hidden=!shown.has(part.id);entry.card.classList.toggle('selected',part.id===selected);entry.card.classList.toggle('printed',part.done);
      entry.card.classList.toggle('outside-assembly',part.visible===false);
      if(entry.name.textContent!==part.name)entry.name.textContent=part.name;
      entry.name.title=part.name;entry.select.setAttribute('aria-label',`选择部件：${part.name}`);entry.select.setAttribute('aria-pressed',String(part.id===selected));
      if(entry.thumb!==part.thumb){entry.image.src=part.thumb||'';entry.thumb=part.thumb;}
      entry.status.textContent=part.visible===false?'未加入装配':part.done?'已打印':'待打印';
      entry.printed.textContent=part.done?'✓ 已打印':'标为已打印';entry.printed.setAttribute('aria-pressed',String(part.done));
      entry.printed.setAttribute('aria-label',`${part.done?'取消已打印':'标为已打印'}：${part.name}`);
      entry.path.classList.toggle('selected',part.id===selected);entry.dot.classList.toggle('selected',part.id===selected);
    }
    groups.forEach((group,index)=>group.forEach((part,position)=>{
      const node=cards.get(part.id).card,lane=lanes[index];
      if(lane.children[position]!==node)lane.insertBefore(node,lane.children[position]||null);
    }));
    host.hidden=!parts.length||mode==='off';
    count.textContent=mode==='off'?`${parts.length} 件 · 卡片已关闭`:mode==='selected'?`所选 ${selected?1:0} / ${parts.length} 件`:`${parts.length} 件 · 两侧可滚动`;
    resize();markDirty();
  }

  function resize(){
    const width=host.parentElement.clientWidth,layout=calloutLayout(width);
    host.style.setProperty('--callout-lane-width',`${layout.laneWidth}px`);host.style.setProperty('--callout-inset',`${layout.inset}px`);
    markDirty();
  }

  function reveal(id){
    if(mode!=='all')return;
    const entry=cards.get(id);if(!entry||entry.card.hidden)return;
    const lane=entry.card.parentElement,cardRect=entry.card.getBoundingClientRect(),laneRect=lane.getBoundingClientRect();
    if(cardRect.top<laneRect.top)lane.scrollTop-=laneRect.top-cardRect.top+4;
    else if(cardRect.bottom>laneRect.bottom)lane.scrollTop+=cardRect.bottom-laneRect.bottom+4;
    markDirty();
  }

  function measure(){
    viewport=host.getBoundingClientRect();visibleCards=[];
    svg.setAttribute('viewBox',`0 0 ${viewport.width} ${viewport.height}`);
    for(const entry of cards.values())entry.path.style.display=entry.dot.style.display='none';
    lanes.forEach((lane,index)=>{
      const laneRect=lane.getBoundingClientRect();
      for(const card of lane.children){
        if(card.hidden)continue;
        const end=cardConnectorEnd(card.getBoundingClientRect(),laneRect,viewport,index?'right':'left');
        if(end)visibleCards.push({entry:cards.get(card.dataset.partId),end,side:index});
      }
    });dirty=false;
  }

  function draw(now=performance.now()){
    if(host.hidden||(!dirty&&now-lastDraw<40))return;
    lastDraw=now;if(dirty)measure();
    for(const {entry,end,side} of visibleCards){
      const point=projectPartAnchor(entry.part,camera,viewport.width,viewport.height,anchor);
      entry.path.style.display=entry.dot.style.display=point?'':'none';if(!point)continue;
      const elbow=end.x+(side?-1:1)*Math.min(22,Math.abs(point.x-end.x)*.25);
      const line=`M ${end.x.toFixed(1)} ${end.y.toFixed(1)} L ${elbow.toFixed(1)} ${end.y.toFixed(1)} L ${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
      if(entry.path.getAttribute('d')!==line)entry.path.setAttribute('d',line);
      entry.dot.setAttribute('cx',point.x.toFixed(1));entry.dot.setAttribute('cy',point.y.toFixed(1));
    }
  }

  function modelWidth(){const width=host.parentElement.clientWidth;return parts.length&&mode!=='off'?calloutLayout(width).modelWidth:width;}
  return {render,resize,reveal,draw,modelWidth};
}
