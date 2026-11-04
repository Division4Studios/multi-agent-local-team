window.startMaltViews = function (send,graphVisit) {
  const el=id=>document.getElementById(id);
  const kind=el('modelKind'),subject=el('modelSubject'),info=el('modelDetail');
  let state,zoom=1,offset=0,playing,step=0,last='',trail=[];
  const controls=(parent,label,fn)=>{const b=document.createElement('button');b.textContent=label;b.addEventListener('click',fn);parent.append(b);};
  const option=(list,value,label)=>{const o=document.createElement('option');o.value=value;o.textContent=label;list.append(o);};
  const visit=(item,key=state.place.key,k=state.place.kind)=>send({action:'perspective',kind:k,key,item});
  function stop(){window.clearInterval(playing);playing=undefined;el('modelPlay').textContent='Play route';}
  function draw(){
    if(!state){return;} const d=state.model;const sel=state.place.item;
    const original=d&&d.kind==='architecture'&&d.id==='project'&&!d.path;
    el('connectionMap').hidden=!original;el('modelScreen').hidden=Boolean(original);
    if(original){if(sel){graphVisit(sel);}return;}
    info.replaceChildren();el('relatedModels').replaceChildren();
    if(!d){el('modelSvg').replaceChildren();el('modelCount').textContent=state.empty;return;}
    const q=el('modelSearch').value.toLowerCase();
    let matches=d.items.filter(p=>!q||(p.label+' '+(p.group||'')+' '+(p.detail||'')).toLowerCase().includes(q));
    const p=d.items.find(i=>i.id===sel);
    if((d.kind==='tree'||d.kind==='architecture')&&d.items.some(i=>i.parent)&&!q){
      matches=matches.filter(i=>p?i.id===p.id||i.parent===p.id:!i.parent);
    }
    if(offset>=matches.length){offset=0;}
    const subset=matches.slice(offset,offset+60);
    window.drawMaltPerspective(el('modelSvg'),d,subset,id=>visit(id),{selected:q?'':sel,zoom,fields:el('modelFields').checked,zone:el('modelZone').value,search:Boolean(q)});
    el('modelCount').textContent=matches.length?String(offset+1)+'–'+String(Math.min(offset+60,matches.length))+' of '+String(matches.length):'No matching items.';
    el('modelPrev').disabled=!offset;el('modelNext').disabled=offset+60>=matches.length;
    el('modelUp').disabled=!p;el('modelZone').hidden=d.kind!=='timeline';
    el('modelFieldsWrap').hidden=d.kind!=='er'&&d.kind!=='classes';
    el('modelLegend').textContent=[...new Set(d.items.map(i=>i.group).filter(Boolean))].join(' · ');
    if(p){
      const heading=document.createElement('h3');heading.textContent=p.label;info.append(heading);
      for(const value of [p.group,p.detail,...(p.fields||[])].filter(Boolean)){
        const entry=document.createElement('div');entry.textContent=value;info.append(entry);
      }
      for(const w of d.links.filter(l=>l.from===p.id||l.to===p.id)){
        const peer=d.items.find(i=>i.id===(w.from===p.id?w.to:w.from));
        if(peer){controls(info,(w.from===p.id?'→ ':'← ')+peer.label+' · '+[w.fromEnd,w.label,w.toEnd].filter(Boolean).join(' '),()=>visit(peer.id));}
      }
      if(state.source){controls(info,'Open source',()=>send({action:'viewSource'}));}
      if(state.discuss){controls(info,'Discuss this panel',()=>send({action:'viewDiscuss'}));}
    }
    for(const link of state.related){controls(el('relatedModels'),link.label,()=>visit(link.place.item,link.place.key,link.place.kind));}
    el('modelRoute').textContent=trail.map(id=>d.items.find(i=>i.id===id)?.label||id).join(' → ');
  }
  kind.addEventListener('change',()=>visit('','',kind.value));
  subject.addEventListener('change',()=>visit('',subject.value));
  el('modelBack').addEventListener('click',()=>send({action:'viewBack'}));
  el('modelTray').addEventListener('click',()=>send({action:'viewTray'}));
  el('modelSide').addEventListener('click',()=>send({action:'viewSide'}));
  el('modelExport').addEventListener('click',()=>send({action:'viewExport'}));
  el('modelPrev').addEventListener('click',()=>{offset=Math.max(0,offset-60);draw();});
  el('modelNext').addEventListener('click',()=>{offset+=60;draw();});
  el('modelZoom').addEventListener('change',()=>{zoom=Number(el('modelZoom').value);draw();});
  el('modelUp').addEventListener('click',()=>visit(state.model?.items.find(i=>i.id===state.place.item)?.parent||''));
  el('modelSearch').addEventListener('input',()=>{offset=0;draw();});
  for(const id of ['modelFields','modelZone']){el(id).addEventListener('change',draw);}
  el('modelPlay').addEventListener('click',()=>{
    if(playing){stop();return;}if(!state?.model){return;}
    const d=state.model,first=d.links.find(w=>w.from===state.place.item)||d.links[0];
    if(!first){return;}trail=[first.from,first.to];const used=new Set([first]);
    let next;
    while((next=d.links.find(w=>w.from===trail.at(-1)&&!used.has(w)))){used.add(next);trail.push(next.to);}
    step=0;el('modelPlay').textContent='Pause';visit(trail[step++]);
    playing=window.setInterval(()=>{if(step>=trail.length){stop();}else{visit(trail[step++]);}},950);
  });
  return m=>{
    state=m;if(last!==m.place.key){stop();trail=[];offset=0;el('modelSearch').value='';last=m.place.key;}
    kind.replaceChildren();for(const [k,label] of m.kinds){option(kind,k,label);}
    kind.value=m.place.kind;subject.replaceChildren();for(const item of m.menu){option(subject,item.key,item.title);}
    subject.value=m.place.key;el('modelQuestion').textContent=m.question;el('modelSide').hidden=!m.compare;
    el('modelSide').textContent=m.side==='base'?'Showing base · switch to target':'Showing target · switch to base';
    draw();
  };
};
