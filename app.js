'use strict';
const $ = id => document.getElementById(id);
const node = (tag,text,className) => Object.assign(document.createElement(tag),{textContent:text,className:className||''});
const button = (label,action) => {
  const item=node('button',label);
  item.type='button';
  item.onclick=action;
  return item;
};
const option = (label,value=label) => new Option(label,value);
const colors = {
  Pastel:['#e9a5b8','#facba7','#f5db8b','#b3d4b4','#a6cddd','#beb0df','#b25370'],
  Naturaleza:['#465b43','#77965b','#b8bf80','#dfc78a','#b17c54','#785543','#587882'],
  Vibrantes:['#f23f6c','#fb8341','#ffd339','#78ba4f','#009e9f','#4d7ce8','#9555c6'],
  Tinta:['#292332','#4b3b57','#755a80','#ad85a9','#d5afc9','#efdee9','#ffffff'],
  // Colores tradicionales: sakura, kurenai, yamabuki, moegi, ai, fuji, sumi
  'Japón':['#fedfe1','#cb1b45','#ffb11b','#7b8d42','#0d5661','#8b81c3','#1c1c1c']
};
const paletteStorageKey='libreta-ninja-palettes';
let customPalettes=loadCustomPalettes();
const modes = [['all','Todos'],['pending','Pendientes'],['done','Terminados'],['original','Colección'],['trash','Papelera']];
const tools = [['pencil','✎ Lápiz'],['marker','▰ Rotulador'],['wash','◒ Acuarela'],['air','◌ Aerógrafo'],['detail','✧ Detalle'],['bucket','◩ Relleno'],['eraser','◇ Borrador'],['pan','✋ Mover']];
const layerNames=['fills','paint'];
const contexts=Object.fromEntries([...layerNames,'ink'].map(key=>[key,$(key).getContext('2d',{willReadFrequently:true})]));
const strokeCanvas=document.createElement('canvas');
const strokeCtx=strokeCanvas.getContext('2d');
const previewCanvas=document.createElement('canvas');
const previewCtx=previewCanvas.getContext('2d',{willReadFrequently:true});
let folders=[], comparing=false, previousColorTool='pencil', zoomLevel=1;
let gradientSettings={colors:['#b25370','#f5db8b'],angle:0};
let db, drawings=[], mode='all', selectedTool='pencil', active=null, w=0, h=0, barrier, stroke, pan, undo=[], redo=[], opening=false, closing=false, saveQueue=Promise.resolve(), savingFailed=false, toastTimer, galleryURLs=[];

function toast(message,duration=4600){
  clearTimeout(toastTimer);
  $('toast').textContent=message;
  $('toast').hidden=false;
  toastTimer=setTimeout(()=>$('toast').hidden=true,duration);
}

function openDB(){
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open('libreta-ninja',2);
    request.onupgradeneeded=event=>{
      if(event.oldVersion<1)request.result.createObjectStore('drawings',{keyPath:'id'});
      if(event.oldVersion<2)request.result.createObjectStore('folders',{keyPath:'id'});
    };
    request.onblocked=()=>toast('Cierra otras pestañas de la libreta para completar la actualización.');
    request.onsuccess=()=>{
      request.result.onversionchange=()=>request.result.close();
      resolve(request.result);
    };
    request.onerror=()=>reject(request.error);
  });
}
function transaction(action,mode='readonly',storeName='drawings'){
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(storeName,mode);
    const req=action(tx.objectStore(storeName));
    tx.oncomplete=()=>resolve(req.result);
    tx.onabort=()=>reject(tx.error||new Error('Operación interrumpida'));
    tx.onerror=()=>reject(tx.error);
  });
}
// Safari en iPad a veces falla al guardar Blobs en IndexedDB ("Error preparing Blob").
// Guardamos las imágenes como ArrayBuffer, que Safari almacena sin problemas.
async function encodeRecord(record){
  const out={};
  for(const [key,value] of Object.entries(record)){
    out[key]=value instanceof Blob?{__blob:true,type:value.type,data:await value.arrayBuffer()}:value;
  }
  return out;
}
function decodeRecord(record){
  if(!record)return record;
  const out={};
  for(const [key,value] of Object.entries(record)){
    out[key]=value&&value.__blob?new Blob([value.data],{type:value.type}):value;
  }
  return out;
}
function storageMessage(error){
  const name=error?.name||'';
  if(name==='QuotaExceededError'||/quota|space|espacio/i.test(error?.message||''))
    return 'No hay espacio suficiente para guardar. Libera espacio en el iPad o vacía la papelera.';
  return 'No se pudo guardar. Tu dibujo sigue abierto.';
}
async function put(drawing){
  const stored=await encodeRecord(drawing);
  try{
    await transaction(store=>store.put(stored),'readwrite');
  }catch(error){
    console.warn('Reintentando guardado',error);
    try{db.close();}catch{}
    db=await openDB();
    await transaction(store=>store.put(stored),'readwrite');
  }
  const index=drawings.findIndex(item=>item.id===drawing.id);
  if(index<0)drawings.push(drawing);
  else drawings[index]=drawing;
}
function safe(action){
  return async (...args)=>{
    try{await action(...args);}catch(error){console.error(error);toast(error?.name==='QuotaExceededError'?storageMessage(error):'No se pudo completar la operación.');}
  };
}
function image(source){
  return new Promise((resolve,reject)=>{
    const blob=source instanceof Blob;
    const url=blob ? URL.createObjectURL(source) : source;
    const img=new Image();
    img.onload=()=>{if(blob)URL.revokeObjectURL(url);resolve(img);};
    img.onerror=()=>{if(blob)URL.revokeObjectURL(url);reject(new Error('Imagen inválida'));};
    img.src=url;
  });
}
const toBlob=(canvas,type='image/png',quality)=>new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('No se pudo generar la imagen')),type,quality));
function showDialog(title,content,label,submit){
  $('dialogTitle').textContent=title;
  $('dialogBody').replaceChildren(content);
  $('confirmDialog').textContent=label||'Aceptar';
  $('confirmDialog').hidden=!submit;
  $('dialogForm').onsubmit=event=>{
    event.preventDefault();
    $('dialog').close();
    if(submit)safe(submit)();
  };
  if(!$('dialog').open)$('dialog').showModal();
}
function cloneDrawing(drawing,title,blank=false){
  const {id,original,deleted,done,...rest}=drawing;
  return {...rest,id:crypto.randomUUID(),title,done:false,updated:Date.now(),...(blank?{fills:undefined,paint:undefined,thumb:undefined}:{})};
}
function render(){
  galleryURLs.forEach(url=>URL.revokeObjectURL(url));
  galleryURLs=[];
  const group=$('category').value;
  const folder=$('collectionFilter').value;
  $('tabs').replaceChildren(...modes.map(([key,title])=>{
    const tab=button(title,()=>{mode=key;render();});
    tab.setAttribute('aria-pressed',mode===key);
    return tab;
  }));
  const library=[...drawings.slice().sort((a,b)=>b.updated-a.updated),...collection].filter(d=>{
    if(group && group!==d.category)return false;
    if(folder && folder!==d.folderId)return false;
    if(mode==='trash')return d.deleted;
    if(d.deleted)return false;
    if(mode==='original')return d.original;
    if(mode==='done')return d.done;
    if(mode==='pending')return !d.done && !d.original;
    return true;
  });
  $('count').textContent=library.length+(library.length===1?' dibujo':' dibujos');
  $('cards').replaceChildren();
  library.forEach(d=>{
    const card=node('article','','card');
    const picture=button('',safe(()=>d.deleted?menu(d):openEditor(d)));
    picture.className='picture';
    picture.setAttribute('aria-label',(d.deleted?'Opciones de ':'Abrir ')+d.title);
    const thumb=document.createElement('img');
    thumb.alt='';
    thumb.loading='lazy';
    const source=d.thumb||d.base;
    if(source instanceof Blob){thumb.src=URL.createObjectURL(source);galleryURLs.push(thumb.src);}
    else thumb.src=source;
    picture.append(thumb);
    const more=button('•••',()=>menu(d));
    more.className='more';
    more.setAttribute('aria-label','Opciones de '+d.title);
    const meta=node('div');
    meta.append(node('h3',d.title),node('p',d.deleted?'En la papelera':d.original?'Original protegido':d.done?'Terminado':'Pendiente',
      'status '+(d.deleted?'trash':d.original?'original':d.done?'done':'')));
    const foot=node('div','','card-foot');
    const folderName=folders.find(folder=>folder.id===d.folderId)?.name;
    if(folderName)meta.append(node('p',folderName));
    meta.style.cursor='pointer';
    meta.style.flex='1';
    meta.onclick=picture.onclick;
    foot.append(meta,more);
    card.append(picture,foot);
    $('cards').append(card);
  });
  if(!library.length)$('cards').append(node('p',mode==='trash'?'La papelera está vacía.':'Aquí aparecerán tus dibujos.', 'empty'));
}
function menu(d){
  const list=node('div','','menu');
  const item=(label,action)=>list.append(button(label,safe(async()=>{$('dialog').close();await action();})));
  const change=async patch=>{await put({...d,...patch,updated:Date.now()});render();};
  if(d.deleted){
    item('Recuperar dibujo',()=>change({deleted:false}));
  } else {
    item(d.original?'Colorear una copia':'Abrir dibujo',()=>openEditor(d));
    item('Duplicar',async()=>{await put(cloneDrawing(d,d.title+' · copia'));mode='all';render();toast('Copia creada');});
    if(!d.original){
      item('Renombrar o cambiar categoría',()=>{
        const content=node('div'), title=node('label','Nombre'), category=node('label','Categoría');
        const field=document.createElement('input');
        field.value=d.title;
        field.required=true;
        field.maxLength=100;
        const select=document.createElement('select');
        select.append(...[...categories,'Importados'].map(v=>option(v)));
        select.value=d.category;
        title.append(field);category.append(select);content.append(title,category);
        showDialog('Editar dibujo',content,'Guardar',()=>field.value.trim() && change({title:field.value.trim(),category:select.value}));
      });
      if(d.sourcePhoto){
        item('Crear plantilla de contornos',()=>previewImport([d.sourcePhoto],{source:d}));
        item('Descargar foto original',()=>downloadFile(d.sourcePhoto,d.sourcePhoto.name||d.title));
      }
      item('Mover a colección',()=>moveToFolder(d,change));
      item(d.done?'Marcar pendiente':'Marcar terminado',()=>change({done:!d.done}));
      item('Mover a la papelera',()=>showDialog('¿Mover a la papelera?',node('p','Podrás recuperar «'+d.title+'» desde la galería.'),'Mover',()=>change({deleted:true})));
    }
  }
  showDialog(d.title,list,null,null);
}
function layout(){
  if(!active||stroke)return;
  const desk=$('desk');
  const scale=Math.max(.02,Math.min((desk.clientWidth-36)/w,(desk.clientHeight-36)/h))*zoomLevel;
  $('frame').style.width=Math.round(w*scale)+'px';
  $('frame').style.height=Math.round(h*scale)+'px';
  updateBrushPreview();
}
async function openEditor(drawing){
  if(opening || active)return;
  opening=true;
  try{
    let target=drawing;
    const original=await image(drawing.base);
    const savedLayers=await Promise.all(layerNames.map(key=>drawing[key]?image(drawing[key]):null));
    if(drawing.original){
      target=cloneDrawing(drawing,drawing.title);
      await put(target);
    }
    w=original.naturalWidth;h=original.naturalHeight;
    [...layerNames,'ink','decoration','gesture'].forEach(key=>{$(key).width=w;$(key).height=h;});
    strokeCanvas.width=w;strokeCanvas.height=h;
    previewCanvas.width=w;previewCanvas.height=h;
    contexts.ink.drawImage(original,0,0,w,h);
    const pixels=contexts.ink.getImageData(0,0,w,h).data;
    barrier=new Uint8Array(w*h);
    for(let i=0;i<barrier.length;i++){
      const p=i*4;
      const light=(pixels[p]*.2126+pixels[p+1]*.7152+pixels[p+2]*.0722);
      barrier[i]=(255-light)*pixels[p+3]/255>108?1:0;
    }
    savedLayers.forEach((img,i)=>{if(img)contexts[layerNames[i]].drawImage(img,0,0,w,h);});
    active=target;
    setComparison(false);
    refreshFrame();
    savingFailed=false;
    $('drawingName').textContent=target.title;
    $('saved').textContent='Guardado en este dispositivo';
    zoomLevel=1;
    $('layer').value='paint';
    setTool('pencil');
    undo=[];redo=[];
    updateHistory();
    $('gallery').hidden=true;
    $('editor').hidden=false;
    document.body.classList.add('editing');
    $('desk').scrollTo(0,0);
    layout();
  } finally {opening=false;}
}
function updateHistory(){
  $('undo').disabled=comparing||!undo.length;
  $('redo').disabled=comparing||!redo.length;
  $('clearDrawing').disabled=comparing;
}
function record(key,before){
  recordEdit([{key,pixels:before}]);
}
function recordEdit(layers){
  undo.push(layers);
  if(undo.length>8)undo.shift();
  redo=[];
  updateHistory();
  scheduleSave();
}
function history(from,to){
  if(!active||closing||comparing||stroke||!from.length)return;
  const layers=from.at(-1);
  to.push(snapshotLayers(layers.map(({key})=>key)));
  from.pop();
  layers.forEach(({key,pixels})=>contexts[key].putImageData(pixels,0,0));
  updateHistory();
  scheduleSave();
}
function snapshotLayers(keys){
  return keys.map(key=>({key,pixels:contexts[key].getImageData(0,0,w,h)}));
}
function clearDrawing(){
  if(!active||closing||comparing||stroke)return;
  const id=active.id;
  const message=node('p','Se borrarán los trazos, rellenos y efectos de este dibujo. El original, sus contornos y el marco se conservarán. Puedes usar Deshacer para recuperar el color mientras el dibujo esté abierto.');
  showDialog('¿Limpiar dibujo?',message,'Limpiar dibujo',()=>{
    if(active?.id!==id||closing||comparing||stroke)return;
    const before=snapshotLayers(layerNames);
    before.forEach(({key})=>contexts[key].clearRect(0,0,w,h));
    recordEdit(before);
  });
}
function composite(canvas,ctx,frameStyle=''){
  ctx.globalCompositeOperation='source-over';
  ctx.fillStyle='#ffffff';
  ctx.fillRect(0,0,canvas.width,canvas.height);
  layerNames.forEach(key=>ctx.drawImage($(key),0,0,canvas.width,canvas.height));
  ctx.globalCompositeOperation='multiply';
  ctx.drawImage($('ink'),0,0,canvas.width,canvas.height);
  ctx.globalCompositeOperation='source-over';
  drawDecoration(ctx,canvas.width,canvas.height,frameStyle);
}
function scheduleSave(){
  const target=active;
  $('saved').textContent='Guardando…';
  savingFailed=false;
  const thumb=document.createElement('canvas');
  const factor=240/Math.max(w,h);
  thumb.width=Math.max(1,Math.round(w*factor));thumb.height=Math.max(1,Math.round(h*factor));
  composite(thumb,thumb.getContext('2d'),target.frameStyle);
  const files=Promise.all([...layerNames.map(key=>toBlob($(key))),toBlob(thumb)]);
  files.catch(()=>{});
  const job=saveQueue.then(async()=>{
    const [fills,paint,thumb]=await files;
    await put({...target,fills,paint,thumb,updated:Date.now()});
  });
  saveQueue=job.then(()=>{
    if(active?.id===target.id && saveQueue===tail)$('saved').textContent='Guardado en este dispositivo';
  },error=>{
    console.error(error);
    if(active?.id===target.id && saveQueue===tail){savingFailed=true;$('saved').textContent='Error al guardar';toast(storageMessage(error));}
  });
  const tail=saveQueue;
}
function setTool(key){
  if(stroke)return;
  selectedTool=key;
  if(key==='bucket'||key==='gradient')$('layer').value='fills';
  const effectActive=effects.some(([id])=>id===key);
  if(['pencil','marker','wash','air','detail'].includes(key)||effectActive)$('layer').value='paint';
  document.querySelectorAll('#toolbar [data-tool]').forEach(item=>item.setAttribute('aria-pressed',item.dataset.tool===key));
  $('gradient').setAttribute('aria-pressed',key==='gradient');
  $('eyedrop').setAttribute('aria-pressed',key==='eyedrop');
  $('effectsBtn').setAttribute('aria-pressed',effectActive);
  document.querySelectorAll('#effectsPop [data-effect]').forEach(item=>item.setAttribute('aria-pressed',item.dataset.effect===key));
  $('intensityControl').hidden=!effectActive;
  $('gesture').style.cursor=key==='pan'?'grab':'crosshair';
  updateBrushPreview();
}
function rgba(){
  const value=$('color').value;
  return [1,3,5].map(offset=>parseInt(value.slice(offset,offset+2),16));
}
function fill(x,y,gradient){
  x=Math.floor(x);y=Math.floor(y);
  if(x<0||y<0||x>=w||y>=h)return;
  const seed=y*w+x;
  if(barrier[seed]){toast('Toca dentro de una zona del dibujo.');return;}
  const ctx=contexts.fills;
  const before=ctx.getImageData(0,0,w,h);
  const out=new ImageData(new Uint8ClampedArray(before.data),w,h);
  const seen=new Uint8Array(w*h);
  const queue=new Int32Array(w*h);
  const [r,g,b]=rgba();
  const a=Math.round(Number($('opacity').value)*255/100);
  const angle=(gradient?.angle??0)*Math.PI/180;
  const dx=Math.cos(angle),dy=Math.sin(angle);
  let min=Infinity,max=-Infinity;
  let head=0,tail=1;
  queue[0]=seed;seen[seed]=1;
  function visit(pos){
    if(!seen[pos]&&!barrier[pos]){seen[pos]=1;queue[tail++]=pos;}
  }
  while(head<tail){
    const pos=queue[head++], col=pos%w, p=pos*4;
    if(gradient){
      const projection=col*dx+Math.floor(pos/w)*dy;
      min=Math.min(min,projection);max=Math.max(max,projection);
    }else{
      out.data[p]=r;out.data[p+1]=g;out.data[p+2]=b;out.data[p+3]=a;
    }
    if(col>0)visit(pos-1);
    if(col<w-1)visit(pos+1);
    if(pos>=w)visit(pos-w);
    if(pos<w*(h-1))visit(pos+w);
  }
  if(gradient){
    const stops=gradient.colors.map(hex=>[1,3,5].map(offset=>parseInt(hex.slice(offset,offset+2),16)));
    for(let i=0;i<tail;i++){
      const pos=queue[i],p=pos*4;
      const projection=(pos%w)*dx+Math.floor(pos/w)*dy;
      const value=(max>min?(projection-min)/(max-min):0)*(stops.length-1);
      const left=Math.min(stops.length-2,Math.floor(value)), mix=value-left;
      for(let c=0;c<3;c++)out.data[p+c]=stops[left][c]*(1-mix)+stops[left+1][c]*mix;
      out.data[p+3]=a;
    }
  }
  ctx.putImageData(out,0,0);
  if(!gradient)rememberColor($('color').value);
  record('fills',before);
}
function point(event,bounds,previous){
  if(!bounds.width||!bounds.height||!Number.isFinite(event.clientX)||!Number.isFinite(event.clientY))return null;
  const pressure=(stroke?.type||event.pointerType)==='pen'
    ? (event.pressure>0?Math.min(1,event.pressure):previous?.pressure??.5)
    : .58;
  return {x:(event.clientX-bounds.left)*w/bounds.width,y:(event.clientY-bounds.top)*h/bounds.height,pressure};
}
function brushConfig(key){
  return {
    pencil:[.65,.88],marker:[1.25,.86],wash:[1.7,.38],air:[2.2,.55],detail:[.27,1],eraser:[1.2,1]
  }[key]||effects.find(([id])=>id===key)?.slice(2);
}
function dab(x,y,radius){
  const {key,color}=stroke;
  if(key==='air'||key==='wash'){
    const gradient=strokeCtx.createRadialGradient(x,y,0,x,y,radius);
    const [r,g,b]=color;
    gradient.addColorStop(0,'rgba('+[r,g,b,key==='air'?.23:.38].join(',')+')');
    gradient.addColorStop(key==='air'?.46:.72,'rgba('+[r,g,b,.13].join(',')+')');
    gradient.addColorStop(1,'rgba('+[r,g,b,0].join(',')+')');
    strokeCtx.fillStyle=gradient;
  }else strokeCtx.fillStyle=stroke.pattern||'rgb('+color.join(',')+')';
  strokeCtx.beginPath();strokeCtx.arc(x,y,radius,0,Math.PI*2);strokeCtx.fill();
  const left=Math.max(0,Math.floor(x-radius-1)), top=Math.max(0,Math.floor(y-radius-1));
  const right=Math.min(w,Math.ceil(x+radius+1)), bottom=Math.min(h,Math.ceil(y+radius+1));
  if(left>=right||top>=bottom)return;
  if(!stroke.dirty)stroke.dirty={left,top,right,bottom};
  else{
    const area=stroke.dirty;
    area.left=Math.min(area.left,left);area.top=Math.min(area.top,top);
    area.right=Math.max(area.right,right);area.bottom=Math.max(area.bottom,bottom);
  }
}
function segment(next){
  const prev=stroke.last||next;
  const length=Math.hypot(next.x-prev.x,next.y-prev.y);
  const steps=Math.max(1,Math.ceil(length/Math.max(.5,stroke.radius*(stroke.key==='air'?.24:.4))));
  for(let i=1;i<=steps;i++){
    const t=i/steps;
    const pressure=prev.pressure+(next.pressure-prev.pressure)*t;
    dab(prev.x+(next.x-prev.x)*t,prev.y+(next.y-prev.y)*t,Math.max(.65,stroke.radius*(.42+.95*pressure)));
  }
  stroke.last=next;
}
function showStroke(){
  if(!stroke?.dirty)return;
  const {left,top,right,bottom}=stroke.dirty;
  const area=[left,top,right-left,bottom-top];
  const ctx=contexts[stroke.layer];
  ctx.clearRect(...area);
  ctx.drawImage(previewCanvas,...area,...area);
  ctx.globalAlpha=stroke.alpha;
  ctx.globalCompositeOperation=stroke.key==='eraser'?'destination-out':'source-over';
  ctx.drawImage(strokeCanvas,...area,...area);
  ctx.globalAlpha=1;
  ctx.globalCompositeOperation='source-over';
  stroke.dirty=null;
}
function queueStrokeFrame(){
  if(stroke.frame)return;
  stroke.frame=requestAnimationFrame(()=>{
    stroke.frame=0;
    showStroke();
  });
}
function finishStroke(){
  if(!stroke)return;
  cancelAnimationFrame(stroke.frame);
  showStroke();
  const {layer}=stroke;
  const before=previewCtx.getImageData(0,0,w,h);
  stroke=null;
  record(layer,before);
  layout();
}

const surface=$('gesture');
let lastPen=-Infinity;
function capturePointer(event){
  try{$('desk').setPointerCapture(event.pointerId);}catch{
    // Window listeners still receive moves and release events without capture.
  }
}
function startStroke(event,p){
  const [width,opacity]=brushConfig(selectedTool);
  const layer=$('layer').value;
  previewCtx.clearRect(0,0,w,h);
  previewCtx.drawImage($(layer),0,0);
  strokeCtx.clearRect(0,0,w,h);
  stroke={
    id:event.pointerId,type:event.pointerType,layer,key:selectedTool,frame:0,
    radius:Number($('size').value)*width/2,alpha:Number($('opacity').value)/100*opacity,
    color:rgba(),sampleTime:event.timeStamp
  };
  if(effects.some(([key])=>key===selectedTool))stroke.pattern=effectPattern(strokeCtx,selectedTool,stroke.color,Number($('intensity').value)/100);
  if(selectedTool!=='eraser')rememberColor($('color').value);
  segment(p);
  showStroke();
  capturePointer(event);
}
function drawSamples(event){
  const bounds=surface.getBoundingClientRect();
  let samples;
  try{samples=event.getCoalescedEvents?.();}catch{}
  // The dispatched position can be newer than the last coalesced sample.
  for(const sample of [...(samples||[]),event]){
    if(sample.timeStamp<stroke.sampleTime)continue;
    const previous=stroke.last;
    const next=point(sample,bounds,previous);
    if(!next)continue;
    stroke.sampleTime=sample.timeStamp;
    if(next.x!==previous.x||next.y!==previous.y)segment(next);
  }
}
const desk=$('desk');
const touches=new Map();
let pinch=null, pendingTap=null, zoomBadgeTimer;
// A finger right after the Pencil is usually the palm.
const palmLikely=event=>event.pointerType==='touch'&&(performance.now()-lastPen<450||stroke?.type==='pen');

function cancelStroke(){
  if(!stroke)return;
  cancelAnimationFrame(stroke.frame);
  const ctx=contexts[stroke.layer];
  ctx.clearRect(0,0,w,h);
  ctx.drawImage(previewCanvas,0,0);
  stroke=null;
}
function touchCenter(){
  const [a,b=a]=[...touches.values()];
  return {x:(a.x+b.x)/2,y:(a.y+b.y)/2,dist:Math.hypot(a.x-b.x,a.y-b.y)};
}
function beginPinch(){
  // The first finger may have started a stroke: a second finger turns it into a gesture.
  if(stroke?.type==='touch')cancelStroke();
  pendingTap=null;pan=null;
  hideCursor();
  const c=touchCenter(), r=$('frame').getBoundingClientRect();
  const starts=[...touches.values()].map(item=>item.t);
  pinch={dist:Math.max(c.dist,1),zoom:zoomLevel,fx:(c.x-r.left)/r.width,fy:(c.y-r.top)/r.height,
    x:c.x,y:c.y,start:performance.now(),spread:Math.max(...starts)-Math.min(...starts),moved:false,fingers:touches.size};
}
function updatePinch(){
  const c=touchCenter();
  if(!pinch.moved&&(Math.abs(c.dist-pinch.dist)>12||Math.hypot(c.x-pinch.x,c.y-pinch.y)>12))pinch.moved=true;
  if(pinch.moved)setZoom(pinch.zoom*c.dist/pinch.dist,{fx:pinch.fx,fy:pinch.fy,x:c.x,y:c.y});
}
function endPinch(event){
  const now=performance.now();
  const tap=!pinch.moved&&event.type==='pointerup'&&now-pinch.start<350&&pinch.spread<200&&now-lastPen>1000;
  const fingers=pinch.fingers;
  pinch=null;
  if(!tap||comparing)return;
  if(fingers>=3){if(redo.length){history(redo,undo);toast('Rehecho',1100);}}
  else if(undo.length){history(undo,redo);toast('Deshecho',1100);}
}
function setZoom(value,anchor){
  if(!active)return;
  const frame=$('frame');
  if(!anchor){
    const d=desk.getBoundingClientRect(), r=frame.getBoundingClientRect();
    const x=d.left+d.width/2, y=d.top+d.height/2;
    anchor={fx:(x-r.left)/r.width,fy:(y-r.top)/r.height,x,y};
  }
  zoomLevel=Math.min(6,Math.max(1,value));
  layout();
  const r=frame.getBoundingClientRect();
  desk.scrollLeft+=r.left+anchor.fx*r.width-anchor.x;
  desk.scrollTop+=r.top+anchor.fy*r.height-anchor.y;
  $('zoomBadge').textContent=Math.round(zoomLevel*100)+' %';
  $('zoomBadge').hidden=false;
  clearTimeout(zoomBadgeTimer);
  zoomBadgeTimer=setTimeout(()=>$('zoomBadge').hidden=true,900);
}
function runTap(tap){
  if(!active||comparing)return;
  if(tap.tool==='eyedrop'){sampleColor(tap.p);return;}
  fill(tap.p.x,tap.p.y,tap.tool==='gradient'?gradientSettings:null);
}
function hideCursor(){$('cursorRing').hidden=true;}
function moveCursor(event){
  const config=brushConfig(selectedTool);
  if(!active||comparing||event.pointerType==='touch'||!config||(event.target!==surface&&!stroke)){hideCursor();return;}
  const ring=$('cursorRing');
  const size=Math.max(4,Number($('size').value)*config[0]*surface.getBoundingClientRect().width/w);
  ring.style.width=ring.style.height=size+'px';
  ring.style.left=event.clientX+'px';ring.style.top=event.clientY+'px';
  ring.hidden=false;
}
surface.addEventListener('pointerleave',()=>{if(!stroke)hideCursor();});

desk.addEventListener('pointerdown',event=>{
  if(!active||closing)return;
  if(event.pointerType==='mouse'&&event.button!==0)return;
  event.preventDefault();
  if(event.pointerType==='touch'){
    if(palmLikely(event))return;
    touches.set(event.pointerId,{x:event.clientX,y:event.clientY,t:performance.now()});
    if(pinch){pinch.fingers=Math.max(pinch.fingers,touches.size);return;}
    if(touches.size>=2){beginPinch();return;}
  }
  if(event.pointerType==='pen'){
    lastPen=performance.now();
    // A new Pencil contact wins over a palm, a gesture or an earlier contact without a release.
    if(pinch){pinch=null;touches.clear();}
    if(stroke)finishStroke();
    pan=null;pendingTap=null;
  }else if(stroke||pan)return;
  const onCanvas=event.target===surface;
  if(selectedTool==='pan'||!onCanvas||($('pencilOnly').checked&&event.pointerType==='touch')){
    pan={id:event.pointerId,x:event.clientX,y:event.clientY,left:desk.scrollLeft,top:desk.scrollTop};
    capturePointer(event);
    return;
  }
  const p=point(event,surface.getBoundingClientRect());
  if(!p||comparing)return;
  if(['eyedrop','bucket','gradient'].includes(selectedTool)){
    // With a finger, wait for the release: it might become a two-finger gesture.
    if(event.pointerType==='touch')pendingTap={id:event.pointerId,p,tool:selectedTool};
    else runTap({p,tool:selectedTool});
    return;
  }
  startStroke(event,p);
},{passive:false});
window.addEventListener('pointermove',event=>{
  if(touches.has(event.pointerId)){
    touches.set(event.pointerId,{...touches.get(event.pointerId),x:event.clientX,y:event.clientY});
    if(pinch){if(touches.size>=2)updatePinch();return;}
  }
  if(pan?.id===event.pointerId){
    desk.scrollTo(pan.left+pan.x-event.clientX,pan.top+pan.y-event.clientY);
    return;
  }
  if(active)moveCursor(event);
  if(!stroke&&active&&!closing&&event.pointerType==='pen'&&(event.buttons&1)&&event.target===surface
      &&!comparing&&brushConfig(selectedTool)){
    // Resume only with the Pencil still pressed, never during hover.
    const p=point(event,surface.getBoundingClientRect());
    if(p){lastPen=performance.now();startStroke(event,p);}
    return;
  }
  if(stroke?.id!==event.pointerId)return;
  if(stroke.type==='pen'){
    lastPen=performance.now();
    if(!(event.buttons&1)&&!(event.pressure>0)){finishStroke();return;}
  }
  drawSamples(event);
  queueStrokeFrame();
});
for(const type of ['pointerup','pointercancel']){
  window.addEventListener(type,event=>{
    if(touches.has(event.pointerId)){
      touches.delete(event.pointerId);
      if(pinch){if(!touches.size)endPinch(event);return;}
    }
    if(pendingTap?.id===event.pointerId){
      const tap=pendingTap;
      pendingTap=null;
      if(type==='pointerup')runTap(tap);
    }
    if(pan?.id===event.pointerId)pan=null;
    if(stroke?.id!==event.pointerId)return;
    if(stroke.type==='pen')lastPen=performance.now();
    if(type==='pointerup')drawSamples(event);
    finishStroke();
  });
}
desk.addEventListener('lostpointercapture',event=>{
  if(stroke?.id===event.pointerId||pan?.id===event.pointerId){
    // Capture loss does not end contact. The window still handles move and release.
    showStroke();
  }
});
desk.addEventListener('contextmenu',event=>event.preventDefault());
// Safari's own page zoom would fight with the drawing zoom.
for(const type of ['gesturestart','gesturechange'])document.addEventListener(type,event=>{if(active)event.preventDefault();});
function finishInteraction(){
  finishStroke();
  pan=null;pinch=null;pendingTap=null;touches.clear();
}
window.addEventListener('blur',finishInteraction);
document.addEventListener('visibilitychange',()=>{if(document.hidden)finishInteraction();});

/* ---------- Colores, recientes y vista previa del pincel ---------- */
const recentKey='libreta-ninja-recientes';
let recentColors=(()=>{
  try{
    const data=JSON.parse(localStorage.getItem(recentKey)||'[]');
    return Array.isArray(data)?data.filter(hex=>/^#[0-9a-f]{6}$/i.test(hex)).slice(0,6):[];
  }catch{return [];}
})();
const japaneseNames={
  '#fedfe1':'桜色 さくらいろ · sakura-iro · rosa cerezo',
  '#cb1b45':'紅 くれない · kurenai · rojo carmesí',
  '#ffb11b':'山吹色 やまぶきいろ · yamabuki-iro · amarillo dorado',
  '#7b8d42':'萌黄 もえぎ · moegi · verde brote',
  '#0d5661':'藍色 あいいろ · ai-iro · añil',
  '#8b81c3':'藤色 ふじいろ · fuji-iro · lila glicina',
  '#1c1c1c':'墨色 すみいろ · sumi-iro · negro tinta'
};
function swatchButton(hex,label){
  const jp=japaneseNames[hex.toLowerCase()];
  const item=button('',()=>{$('color').value=hex;paintSwatches();if(jp)toast(jp,2600);});
  item.className='swatch';item.style.background=hex;
  if(jp)item.title=jp;
  item.setAttribute('aria-label',(jp||label)+' '+hex.toUpperCase());
  item.setAttribute('aria-pressed',$('color').value.toLowerCase()===hex.toLowerCase());
  return item;
}
function rememberColor(hex){
  hex=hex.toLowerCase();
  if(recentColors[0]===hex)return;
  recentColors=[hex,...recentColors.filter(item=>item!==hex)].slice(0,6);
  try{localStorage.setItem(recentKey,JSON.stringify(recentColors));}catch{}
  paintSwatches();
}
function paintSwatches(){
  const selected=$('palette').value;
  const swatches=colors[selected]||customPalettes.find(palette=>palette.id===selected)?.colors||[];
  $('swatches').replaceChildren(...swatches.map(hex=>swatchButton(hex,'Color')));
  $('recents').replaceChildren(...recentColors.map(hex=>swatchButton(hex,'Reciente')));
  $('recentDivider').hidden=!recentColors.length;
  updateBrushPreview();
}
function updateBrushPreview(){
  const config=brushConfig(selectedTool)||[1,1];
  const scale=active&&w?$('frame').getBoundingClientRect().width/w:.6;
  const size=Math.max(3,Math.min(40,Number($('size').value)*config[0]*scale));
  const dot=$('sizePreview').firstElementChild;
  const eraser=selectedTool==='eraser';
  dot.style.width=dot.style.height=size+'px';
  dot.style.background=eraser?'transparent':$('color').value;
  dot.style.boxShadow=eraser?'inset 0 0 0 1.5px var(--secondary)':'none';
  dot.style.opacity=eraser?1:Math.max(.15,Number($('opacity').value)/100*(config[1]||1));
  $('sizeValue').textContent=$('size').value;
  $('opacityValue').textContent=$('opacity').value+' %';
  $('intensityValue').textContent=$('intensity').value+' %';
}
for(const id of ['size','opacity','intensity'])$(id).addEventListener('input',updateBrushPreview);

const toolNames=Object.fromEntries([...tools.map(([key,label])=>[key,label.replace(/^\S+\s/,'')]),
  ['gradient','Degradado'],['eyedrop','Cuentagotas'],...effects.map(([key,label])=>[key,label])]);
function toolHint(key){if(toolNames[key])toast(toolNames[key],900);}

/* ---------- Menús flotantes ---------- */
function closePopovers(){
  document.querySelectorAll('.popover').forEach(item=>item.hidden=true);
  document.querySelectorAll('[data-popover]').forEach(item=>item.setAttribute('aria-expanded','false'));
}
function buildEffects(){
  const color=rgba();
  $('effectsPop').replaceChildren(...effects.map(([key,label])=>{
    const item=button('',()=>{
      closePopovers();
      setComparison(false);
      setTool(key);
      toolHint(key);
    });
    item.className='row';
    item.dataset.effect=key;
    item.setAttribute('aria-pressed',selectedTool===key);
    const sample=document.createElement('canvas');
    sample.width=sample.height=26;
    sample.className='effect-swatch';
    const ctx=sample.getContext('2d');
    ctx.fillStyle=effectPattern(ctx,key,color,1)||'rgb('+color.join(',')+')';
    ctx.beginPath();ctx.arc(13,13,13,0,Math.PI*2);ctx.fill();
    item.append(sample,label);
    return item;
  }));
}
function openPopover(anchor){
  const pop=$(anchor.dataset.popover);
  const wasOpen=!pop.hidden;
  closePopovers();
  if(wasOpen||!active)return;
  if(pop.id==='effectsPop')buildEffects();
  pop.hidden=false;
  anchor.setAttribute('aria-expanded','true');
  const r=anchor.getBoundingClientRect(), box=pop.getBoundingClientRect();
  let left, top;
  if(anchor.closest('.toolbar')&&innerWidth>700){
    left=r.right+12;top=Math.min(r.top-6,innerHeight-box.height-12);
  }else{
    left=Math.min(Math.max(10,r.right-box.width),innerWidth-box.width-10);
    top=r.bottom+8;
    if(top+box.height>innerHeight-10)top=r.top-box.height-8;
  }
  pop.style.left=left+'px';
  pop.style.top=Math.max(10,top)+'px';
}
document.querySelectorAll('[data-popover]').forEach(item=>item.addEventListener('click',()=>openPopover(item)));
document.addEventListener('pointerdown',event=>{
  if(!event.target.closest('.popover,[data-popover]'))closePopovers();
},true);
$('morePop').addEventListener('click',event=>{if(event.target.closest('button'))closePopovers();});
$('fitScreen').onclick=()=>{
  if(!active)return;
  zoomLevel=1;layout();desk.scrollTo(0,0);
  $('zoomBadge').textContent='100 %';$('zoomBadge').hidden=false;
  clearTimeout(zoomBadgeTimer);zoomBadgeTimer=setTimeout(()=>$('zoomBadge').hidden=true,900);
};
document.addEventListener('keydown',event=>{
  if(!active||$('dialog').open||event.target.matches('input:not([type=range]),select,textarea'))return;
  const mod=event.metaKey||event.ctrlKey, key=event.key.toLowerCase();
  if(mod&&key==='z'){event.preventDefault();event.shiftKey?history(redo,undo):history(undo,redo);}
  else if(mod&&(key==='+'||key==='=')){event.preventDefault();setZoom(zoomLevel*1.25);}
  else if(mod&&key==='-'){event.preventDefault();setZoom(zoomLevel/1.25);}
  else if(mod&&key==='0'){event.preventDefault();$('fitScreen').click();}
  else if(key==='escape')closePopovers();
});
document.querySelectorAll('#toolbar [data-tool]').forEach(item=>{
  if(tools.some(([key])=>key===item.dataset.tool))item.onclick=()=>{setTool(item.dataset.tool);toolHint(item.dataset.tool);};
});
refreshPaletteOptions();
$('palette').onchange=paintSwatches;
$('color').oninput=paintSwatches;
$('undo').onclick=()=>history(undo,redo);
$('redo').onclick=()=>history(redo,undo);
$('clearDrawing').onclick=clearDrawing;
$('back').onclick=safe(async()=>{
  if(!active||closing)return;
  closing=true;
  $('back').disabled=true;
  try{
    finishStroke();
    if(savingFailed)scheduleSave();
    await saveQueue;
    if(savingFailed)return;
    active=null;pan=null;undo=[];redo=[];
    $('editor').hidden=true;$('gallery').hidden=false;document.body.classList.remove('editing');
    render();
  }finally{
    closing=false;
    $('back').disabled=false;
  }
});
$('png').onclick=openExport;
$('import').onclick=chooseImport;
for(const [id,camera] of [['files',false],['camera',true]]){
  $(id).onchange=safe(async event=>{
    const files=[...event.target.files];
    event.target.value='';
    if(files.length)await previewImport(files,{camera});
  });
}
$('cancelDialog').onclick=()=>$('dialog').close();
$('category').append(option('Todas las categorías',''),...[...categories,'Importados'].map(v=>option(v)));
$('category').onchange=render;
new ResizeObserver(layout).observe($('desk'));
paintSwatches();
$('import').disabled=true;
(async()=>{
  db=await openDB();
  if(navigator.storage?.persist)navigator.storage.persist().catch(()=>{});
  [drawings,folders]=await Promise.all([transaction(store=>store.getAll()),transaction(store=>store.getAll(),'readonly','folders')]);
  drawings=drawings.map(decodeRecord);
  refreshFolders();
  $('manageCollections').disabled=false;
  $('import').disabled=false;
  render();
})().catch(error=>{
  console.error(error);
  $('cards').append(node('p','No se pudo abrir la libreta. Comprueba que Safari permite guardar datos para este sitio.','empty'));
});
if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js').catch(console.warn);

function updateComparisonSplit(){
  const range=$('comparisonSplit');
  $('frame').style.setProperty('--split',range.value+'%');
  range.setAttribute('aria-valuetext',range.value+' % original');
}
function setComparison(enabled){
  comparing=enabled;
  $('frame').classList.toggle('comparing',enabled);
  $('compare').querySelector('span').textContent=enabled?'Cerrar comparación':'Comparar con el original';
  $('compare').setAttribute('aria-pressed',enabled);
  $('comparisonControls').hidden=!enabled;
  if(enabled){
    $('comparisonSplit').value=50;
    updateComparisonSplit();
  }
  updateHistory();
  layout();
}
$('comparisonSplit').oninput=updateComparisonSplit;
$('compare').onclick=()=>{
  if(!active||stroke)return;
  setComparison(!comparing);
};

function refreshFrame(){
  const ctx=$('decoration').getContext('2d');
  ctx.clearRect(0,0,w,h);
  drawDecoration(ctx,w,h,active.frameStyle);
}
$('chooseFrame').onclick=()=>{
  if(!active||stroke)return;
  const content=node('div'), select=document.createElement('select');
  select.setAttribute('aria-label','Estilo de marco');
  select.append(...frames.map(([key,label])=>option(label,key)));
  select.value=active.frameStyle||'';
  const preview=document.createElement('canvas');
  preview.width=180;preview.height=180;
  preview.className='frame-preview';
  preview.setAttribute('aria-hidden','true');
  const ctx=preview.getContext('2d');
  const refresh=()=>{
    ctx.clearRect(0,0,180,180);
    drawDecoration(ctx,180,180,select.value);
  };
  select.onchange=refresh;refresh();
  content.append(select,preview);
  showDialog('Marco del dibujo',content,'Aplicar',()=>{
    if(!active||active.frameStyle===select.value)return;
    active={...active,frameStyle:select.value};
    setComparison(false);
    refreshFrame();
    scheduleSave();
  });
};

function sampleColor(p){
  const x=Math.floor(p.x),y=Math.floor(p.y);
  if(x<0||x>=w||y<0||y>=h)return;
  const canvas=document.createElement('canvas');
  canvas.width=canvas.height=1;
  const ctx=canvas.getContext('2d');
  ctx.fillStyle='#fff';ctx.fillRect(0,0,1,1);
  for(const key of layerNames)ctx.drawImage($(key),x,y,1,1,0,0,1,1);
  ctx.globalCompositeOperation='multiply';
  ctx.drawImage($('ink'),x,y,1,1,0,0,1,1);
  ctx.globalCompositeOperation='source-over';
  ctx.drawImage($('decoration'),x,y,1,1,0,0,1,1);
  const rgb=ctx.getImageData(0,0,1,1).data.slice(0,3);
  const hex='#'+Array.from(rgb,value=>value.toString(16).padStart(2,'0')).join('');
  $('color').value=hex;
  paintSwatches();
  const next=previousColorTool==='gradient'?'bucket':
    ['pan','eraser'].includes(previousColorTool)?'pencil':previousColorTool;
  setTool(next);
  toast('Color capturado '+hex.toUpperCase());
}
$('eyedrop').onclick=()=>{
  if(!active||stroke)return;
  if(selectedTool==='eyedrop'){setTool(previousColorTool);return;}
  previousColorTool=selectedTool;
  setComparison(false);
  setTool('eyedrop');
};
function loadCustomPalettes(){
  try{
    const data=JSON.parse(localStorage.getItem(paletteStorageKey)||'[]');
    return Array.isArray(data)?data.filter(palette=>palette&&typeof palette.id==='string'
      &&typeof palette.name==='string'&&Array.isArray(palette.colors)): [];
  }catch{return [];}
}
function refreshPaletteOptions(selected=$('palette').value){
  $('palette').replaceChildren(...Object.keys(colors).map(name=>option(name)),
    ...customPalettes.map(palette=>option(palette.name,palette.id)));
  if([...$('palette').options].some(item=>item.value===selected))$('palette').value=selected;
  paintSwatches();
}
function storePalettes(next){
  localStorage.setItem(paletteStorageKey,JSON.stringify(next));
  customPalettes=next;
}
const paletteFile=Object.assign(document.createElement('input'),{type:'file',accept:'.json,application/json',hidden:true});
document.body.append(paletteFile);
function paletteTransfer(){
  const box=node('div','','menu');
  if(customPalettes.length)box.append(button('Exportar mis paletas',()=>{
    const data={app:'colorear',tipo:'paletas',version:1,paletas:customPalettes.map(({name,colors})=>({name,colors}))};
    const file=new File([JSON.stringify(data,null,2)],'paletas-colorear.json',{type:'application/json'});
    $('dialog').close();
    offerExport(file);
  }));
  box.append(button('Importar paletas',()=>paletteFile.click()));
  return box;
}
paletteFile.onchange=async()=>{
  const file=paletteFile.files[0];
  paletteFile.value='';
  if(!file)return;
  try{
    const data=JSON.parse(await file.text());
    const incoming=(Array.isArray(data)?data:data.paletas||data.palettes||[])
      .map(item=>({name:String(item?.name||'').trim().slice(0,50),
        colors:[...new Set((Array.isArray(item?.colors)?item.colors:[]).map(hex=>String(hex).toLowerCase()).filter(hex=>/^#[0-9a-f]{6}$/.test(hex)))]}))
      .filter(item=>item.name&&item.colors.length);
    if(!incoming.length){toast('El archivo no contiene paletas válidas.');return;}
    let next=[...customPalettes], added=0, merged=0;
    for(const item of incoming){
      const same=next.find(palette=>palette.name.toLocaleLowerCase('es')===item.name.toLocaleLowerCase('es'));
      if(same){
        next=next.map(palette=>palette===same?{...palette,colors:[...new Set([...palette.colors.map(hex=>hex.toLowerCase()),...item.colors])]}:palette);
        merged++;
      }else{
        const name=Object.keys(colors).some(key=>key.toLocaleLowerCase('es')===item.name.toLocaleLowerCase('es'))?item.name+' (mía)':item.name;
        next.push({id:crypto.randomUUID(),name,colors:item.colors});
        added++;
      }
    }
    storePalettes(next);
    refreshPaletteOptions();
    if($('dialog').open)$('dialog').close();
    toast((added?added+(added===1?' paleta nueva':' paletas nuevas'):'')+(added&&merged?' · ':'')+(merged?merged+(merged===1?' paleta combinada':' paletas combinadas'):''));
  }catch(error){
    console.error(error);
    toast('No se pudo leer el archivo de paletas.');
  }
};
function managePalettes(){
  if(!customPalettes.length){
    const empty=node('div');
    empty.append(node('p','Aún no tienes paletas propias. Elige un color y toca ＋ junto a los colores para crear una, o importa un archivo de paletas.'),paletteTransfer());
    showDialog('Mis paletas',empty,null,null);
    return;
  }
  const content=node('div','','palette-fields');
  const pick=node('label','Paleta');
  const select=document.createElement('select');
  select.append(...customPalettes.map(palette=>option(palette.name,palette.id)));
  if(customPalettes.some(palette=>palette.id===$('palette').value))select.value=$('palette').value;
  pick.append(select);
  const nameLabel=node('label','Nombre');
  const field=document.createElement('input');
  field.maxLength=50;field.required=true;
  nameLabel.append(field);
  const list=node('div','','swatch-row');
  list.style.flexWrap='wrap';list.style.gap='10px';list.style.margin='6px 0';
  let draft=[];
  function renderColors(){
    list.replaceChildren(...draft.map(hex=>{
      const item=button('',()=>{draft=draft.filter(value=>value!==hex);renderColors();});
      item.className='swatch';item.style.background=hex;
      item.title='Quitar '+hex.toUpperCase();
      item.setAttribute('aria-label','Quitar '+hex.toUpperCase());
      return item;
    }));
    if(!draft.length)list.append(node('p','La paleta está vacía.'));
    add.disabled=draft.includes($('color').value.toLowerCase());
  }
  const add=button('＋ Añadir el color actual',()=>{
    const hex=$('color').value.toLowerCase();
    if(!draft.includes(hex))draft.push(hex);
    renderColors();
  });
  function load(){
    const palette=customPalettes.find(item=>item.id===select.value);
    field.value=palette.name;
    draft=palette.colors.map(hex=>hex.toLowerCase());
    renderColors();
  }
  select.onchange=load;
  const remove=button('Eliminar paleta',()=>{
    const palette=customPalettes.find(item=>item.id===select.value);
    showDialog('¿Eliminar paleta?',node('p','«'+palette.name+'» y sus colores desaparecerán. Tus dibujos no cambian.'),'Eliminar paleta',()=>{
      storePalettes(customPalettes.filter(item=>item.id!==palette.id));
      refreshPaletteOptions();
      toast('Paleta eliminada');
    });
  });
  load();
  content.append(pick,nameLabel,node('p','Toca un color para quitarlo.'),list,add,remove,document.createElement('hr'),node('p','Copia de seguridad o pasar a otro dispositivo'),paletteTransfer());
  showDialog('Mis paletas',content,'Guardar cambios',()=>{
    const name=field.value.trim();
    if(!name){toast('Escribe un nombre para la paleta.');return;}
    if(Object.keys(colors).some(key=>key.toLocaleLowerCase('es')===name.toLocaleLowerCase('es'))
      ||customPalettes.some(item=>item.id!==select.value&&item.name.toLocaleLowerCase('es')===name.toLocaleLowerCase('es'))){
      toast('Ya existe una paleta con ese nombre.');return;
    }
    storePalettes(customPalettes.map(item=>item.id===select.value?{...item,name,colors:draft}:item));
    refreshPaletteOptions(select.value);
    toast('Paleta «'+name+'» guardada');
  });
}
$('managePalettes').onclick=()=>{if(active&&!stroke)managePalettes();};
$('saveColor').onclick=()=>{
  if(!active||stroke)return;
  const hex=$('color').value;
  const content=node('div','','palette-fields');
  const destination=node('label','Paleta de destino');
  const select=document.createElement('select');
  select.append(option('Crear una paleta',''),...customPalettes.map(palette=>option(palette.name,palette.id)));
  if(customPalettes.some(palette=>palette.id===$('palette').value))select.value=$('palette').value;
  destination.append(select);
  const nameLabel=node('label','Nombre de la paleta');
  const field=document.createElement('input');
  field.maxLength=50;
  nameLabel.append(field);
  function updateDestination(){
    nameLabel.hidden=Boolean(select.value);
    field.required=!select.value;
  }
  select.onchange=updateDestination;
  updateDestination();
  content.append(node('p','Color '+hex.toUpperCase()),destination,nameLabel);
  showDialog('Guardar color en paleta',content,'Guardar color',()=>{
    let target=customPalettes.find(palette=>palette.id===select.value);
    if(!target){
      const name=field.value.trim();
      if(!name){toast('Escribe un nombre para la paleta.');return;}
      target=customPalettes.find(palette=>palette.name.toLocaleLowerCase('es')===name.toLocaleLowerCase('es'))
        ||{id:crypto.randomUUID(),name,colors:[]};
    }
    const updated={...target,colors:[...new Set([...target.colors,hex])]};
    const next=customPalettes.some(palette=>palette.id===updated.id)
      ?customPalettes.map(palette=>palette.id===updated.id?updated:palette)
      :[...customPalettes,updated];
    localStorage.setItem(paletteStorageKey,JSON.stringify(next));
    customPalettes=next;
    refreshPaletteOptions(updated.id);
    toast('Color guardado en '+updated.name);
  });
};

$('gradient').onclick=()=>{
  if(!active||stroke)return;
  const content=node('div','','gradient-options');
  const list=node('div','','gradient-colors');
  const stops=[...gradientSettings.colors];
  const preview=node('div','','gradient-preview');
  preview.setAttribute('aria-hidden','true');
  const direction=node('label','Dirección');
  const select=document.createElement('select');
  select.append(...[['Izquierda a derecha','0'],['Arriba a abajo','90'],['Diagonal descendente','45'],
    ['Diagonal ascendente','315'],['Derecha a izquierda','180'],['Abajo a arriba','270']].map(([label,value])=>option(label,value)));
  select.value=String(gradientSettings.angle);
  function refreshPreview(){
    preview.style.background='linear-gradient('+(90+Number(select.value))+'deg,'+stops.join(',')+')';
  }
  select.onchange=refreshPreview;
  direction.append(select);
  const add=button('＋ Añadir color',()=>{stops.push($('color').value);renderStops();});
  const remove=button('Quitar último color',()=>{stops.pop();renderStops();});
  function renderStops(){
    list.replaceChildren(...stops.map((hex,index)=>{
      const label=node('label','Color '+(index+1));
      const input=document.createElement('input');
      input.type='color';input.value=hex;
      input.oninput=()=>{stops[index]=input.value;refreshPreview();};
      label.append(input);return label;
    }));
    add.disabled=stops.length>=6;
    remove.disabled=stops.length<=2;
    refreshPreview();
  }
  renderStops();
  content.append(preview,list,add,remove,direction,
    node('p','Para cambiar un degradado, ajusta los colores o la dirección y toca otra vez la misma zona. Puedes deshacer el cambio.'));
  showDialog('Relleno con degradado',content,'Usar degradado',()=>{
    gradientSettings={colors:stops,angle:Number(select.value)};
    setComparison(false);
    setTool('gradient');
    toast('Toca una zona cerrada para aplicar o sustituir el degradado.');
  });
};

function refreshFolders(){
  const selected=$('collectionFilter').value;
  $('collectionFilter').replaceChildren(option('Todas las colecciones',''),
    ...folders.map(folder=>option(folder.name,folder.id)));
  if(folders.some(folder=>folder.id===selected))$('collectionFilter').value=selected;
}
async function saveFolder(folder){
  await transaction(store=>store.put(folder),'readwrite','folders');
  folders=[...folders.filter(item=>item.id!==folder.id),folder].sort((a,b)=>a.name.localeCompare(b.name,'es'));
  refreshFolders();render();
}
function editFolder(folder){
  const label=node('label','Nombre de la colección'), input=document.createElement('input');
  input.required=true;input.maxLength=60;input.value=folder?.name||'';
  label.append(input);
  showDialog(folder?'Renombrar colección':'Nueva colección',label,'Guardar',async()=>{
    const name=input.value.trim();
    if(!name){toast('Escribe un nombre para la colección.');return;}
    if(folders.some(item=>item.id!==folder?.id&&item.name.toLocaleLowerCase('es')===name.toLocaleLowerCase('es'))){
      toast('Ya existe una colección con ese nombre.');return;
    }
    await saveFolder({id:folder?.id||crypto.randomUUID(),name});
  });
}
async function deleteFolder(folder){
  await new Promise((resolve,reject)=>{
    const tx=db.transaction(['drawings','folders'],'readwrite');
    const store=tx.objectStore('drawings');
    tx.objectStore('folders').delete(folder.id);
    store.openCursor().onsuccess=event=>{
      const cursor=event.target.result;
      if(!cursor)return;
      if(cursor.value.folderId===folder.id)cursor.update({...cursor.value,folderId:''});
      cursor.continue();
    };
    tx.oncomplete=resolve;
    tx.onabort=()=>reject(tx.error);
  });
  folders=folders.filter(item=>item.id!==folder.id);
  drawings=drawings.map(drawing=>drawing.folderId===folder.id?{...drawing,folderId:''}:drawing);
  refreshFolders();render();
  toast('Colección eliminada. Tus dibujos siguen en la galería.');
}
function moveToFolder(drawing,change){
  const select=document.createElement('select');
  select.setAttribute('aria-label','Colección de destino');
  select.append(option('Sin colección',''),...folders.map(folder=>option(folder.name,folder.id)));
  select.value=drawing.folderId||'';
  showDialog('Mover a colección',select,'Mover',()=>change({folderId:select.value}));
}
$('collectionFilter').onchange=render;
$('manageCollections').disabled=true;
$('manageCollections').onclick=()=>{
  const content=node('div','','collection-menu');
  const select=document.createElement('select');
  select.setAttribute('aria-label','Colección que quieres gestionar');
  select.append(...folders.map(folder=>option(folder.name,folder.id)));
  if($('collectionFilter').value)select.value=$('collectionFilter').value;
  const selected=()=>folders.find(folder=>folder.id===select.value);
  content.append(button('＋ Nueva colección',()=>editFolder()));
  if(folders.length)content.append(select,
    button('Renombrar colección',()=>editFolder(selected())),
    button('Eliminar colección',()=>{
      const folder=selected();
      showDialog('¿Eliminar colección?',node('p','«'+folder.name+'» desaparecerá. Sus dibujos seguirán en la galería o en la papelera.'),'Eliminar colección',()=>deleteFolder(folder));
    }));
  showDialog('Mis colecciones',content,null,null);
};
