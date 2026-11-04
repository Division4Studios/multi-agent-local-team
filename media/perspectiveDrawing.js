/* Layout coordinates are shared by live and still display. All repository strings are text nodes. */
window.drawMaltPerspective = function (svg, d, visible, select, settings) {
  const ns='http://www.w3.org/2000/svg';
  const element=(type,attrs,text,parent=svg)=>{
    const n=document.createElementNS(ns,type);
    for(const [k,v] of Object.entries(attrs)){n.setAttribute(k,String(v));}
    if(text!==undefined){n.textContent=text;} parent.append(n); return n;
  };
  const line=(x1,y1,x2,y2,cls='wire')=>element('line',{x1,y1,x2,y2,class:cls});
  const text=(x,y,value,cls='caption')=>element('text',{x,y,class:cls},value);
  const palette=group=>{let h=0;for(const c of group||'component'){h=(31*h+c.charCodeAt(0))|0;}return 'role'+String(Math.abs(h)%7);};
  function hit(part,x,y,width,height,lines){
    const g=element('g',{class:'model-card '+palette(part.group)+(settings.selected===part.id?' selected':''),role:'button',tabindex:0,'aria-label':part.label});
    element('title',{},[part.label,part.detail,...(part.fields||[])].filter(Boolean).join('\n'),g);
    element('rect',{x,y,width,height,rx:5},undefined,g);
    for(const [i,value] of lines.entries()){
      const limit=Math.max(4,Math.floor((width-18)/7));
      element('text',{x:x+9,y:y+18+17*i,class:i?'caption':'card-title'},value.length>limit?value.slice(0,limit-1)+'…':value,g);
    }
    g.addEventListener('click',()=>select(part.id));
    g.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select(part.id);}});
  }
  let width=900,height=100;
  const places=new Map();
  function linkLabel(w){return [w.fromEnd,w.label||w.kind,w.toEnd].filter(Boolean).join(' · ');}
  function route(w,i){
    const a=places.get(w.from),b=places.get(w.to);if(!a||!b){return;}
    const x=a.x+a.w,y=a.y+a.h/2,end=b.x+b.w,ey=b.y+b.h/2;
    const channel=Math.max(x,end)+24+(i%12)*14;
    width=Math.max(width,channel+175);
    const bend = a===b ? ey+18 : ey;
    const p=element('path',{class:'wire '+(w.kind||''),d:'M '+x+' '+y+' H '+channel+' V '+bend+' H '+end,fill:'none'});
    element('title',{},linkLabel(w),p);
    const glyph=d.kind==='er'?({'0..*':'○<','1..*':'|<','0..1':'○|','1':'||'}[w.toEnd]||'?'):
      ({inherits:'△',implements:'△',realization:'△',inheritance:'△',composition:'◆',dependency:'›'}[w.kind]||'◀');
    text(end+2,bend-3,glyph);if(d.kind==='er'){text(x+2,y-4,({'0..*':'○<','1..*':'|<','0..1':'○|','1':'||'}[w.fromEnd]||'?'));}
    text(channel+4,(y+bend)/2,linkLabel(w).slice(0,42));
  }
  function cards(){
    let y=25;
    visible.forEach(p=>{
      const fields=settings.fields?(p.fields||[]):[];
      const h=32+17*fields.length;
      const x=d.kind==='dataflow'?35+85*(Math.max(0,[...new Set(visible.map(i=>i.group))].indexOf(p.group))%4):35;
      const w=d.kind==='er'||d.kind==='classes'?440:250;
      places.set(p.id,{x,y,w,h});y+=h+30;
    });
    d.links.forEach(route);
    for(const p of visible){const a=places.get(p.id);hit(p,a.x,a.y,a.w,a.h,[p.label,...(settings.fields?(p.fields||[]):[])]);}
    height=y+15;
  }
  function lanes(){
    const groups=[...new Set(visible.map(p=>p.group||'Stage'))];
    const top=new Map(groups.map((g,i)=>[g,i]));
    const counts=new Map();
    const ranks=new Map();
    for(const p of visible){
      const group=p.group||'Stage';
      const incoming=d.links.filter(l=>l.to===p.id&&ranks.has(l.from)).map(l=>ranks.get(l.from)+1);
      const col=Math.max(counts.get(group)||0,...incoming),x=145+col*194,y=38+top.get(group)*94;
      ranks.set(p.id,col);counts.set(group,col+1);places.set(p.id,{x,y,w:158,h:36});width=Math.max(width,x+195);
    }
    groups.forEach((g,i)=>{text(10,58+i*94,g);line(5,88+i*94,width-8,88+i*94,'lane');});
    for(const w of d.links){const a=places.get(w.from),b=places.get(w.to);if(a&&b){line(a.x+a.w,a.y+17,b.x,b.y+17);text(b.x-15,b.y+14,'›');}}
    visible.forEach(p=>{const a=places.get(p.id);hit(p,a.x,a.y,a.w,a.h,[p.label]);});height=groups.length*94+25;
  }
  function sequence(){
    const participants=new Map(visible.map((p,i)=>[p.id,105+i*185]));
    const messages=d.links.filter(l=>participants.has(l.from)&&participants.has(l.to));
    width=Math.max(width,visible.length*185+55);height=100+messages.length*47;
    for(const p of visible){const x=participants.get(p.id);line(x,54,x,height-12,'lifeline');hit(p,x-78,12,156,37,[p.label]);}
    messages.forEach((m,i)=>{const a=participants.get(m.from),b=participants.get(m.to),y=86+47*i;
      if(a===b){element('path',{class:'wire',fill:'none',d:'M '+a+' '+y+' h 42 v 14 h -42'});}
      else {line(a,y,b,y,m.kind==='return'?'lifeline':'wire');}
      text(b+(a<b?-12:3),y-2,a<b?'›':'‹');text(Math.min(a,b)+7,y-7,(i+1)+'. '+m.label);
    });
  }
  function hierarchy(){
    const parent=settings.selected&&d.items.find(p=>p.id===settings.selected);
    const level=settings.search?visible:visible.filter(p=>parent?p.id===parent.id||p.parent===parent.id:!p.parent);
    let y=20;
    for(const p of level){const indent=parent&&p.id!==parent.id?90:28;if(indent>30){line(45,y+15,indent,y+15,'wire');}
      hit(p,indent,y,355,38,[p.label]);y+=55;}
    height=y+15;
  }
  function timeAxis(){
    const ordered=[...visible].sort((a,b)=>a.start-b.start);if(!ordered.length){return;}
    const spans=d.kind==='waterfall',first=ordered[0].start,last=Math.max(...ordered.map(p=>spans?p.end:p.start));
    const range=Math.max(1,last-first);const gaps=[];
    for(let i=1;i<ordered.length;i++){const gap=ordered[i].start-ordered[i-1].start;if(!spans&&gap>86400000*7){gaps.push([ordered[i-1].start,gap]);}}
    const project=t=>t-first-gaps.reduce((sum,[start,gap])=>sum+Math.min(Math.max(0,t-start),gap)*(1-86400000/gap),0);
    const pos=t=>240+590*project(t)/Math.max(1,project(last));
    const fmt=t=>spans?String(Math.round((t-first)*100)/100)+' ms':new Date(t).toLocaleString(undefined,{timeZone:settings.zone==='UTC'?'UTC':undefined});
    text(235,22,fmt(first));text(690,22,fmt(last));line(238,35,835,35,'wire');
    gaps.forEach(([start,gap])=>{text(pos(start)+3,52,'// '+Math.round(gap/86400000)+'d');});
    ordered.forEach((p,i)=>{const y=65+i*38,x=pos(p.start);
      hit(p,p.parent?25:8,y-7,p.parent?198:215,30,[p.label]);line(235,y+7,835,y+7,'lane');
      const g=element('rect',{x,y,width:spans?Math.max(3,590*(p.end-p.start)/range):7,height:15,class:'timebar '+palette(p.group)});
      g.addEventListener('click',()=>select(p.id));element('title',{},spans?String(p.end-p.start)+' ms':fmt(p.start),g);
    });height=95+ordered.length*38;
  }
  svg.replaceChildren();
  if(d.kind==='workflow'){lanes();}else if(d.kind==='sequence'){sequence();}
  else if(d.kind==='waterfall'||d.kind==='timeline'){timeAxis();}
  else if(d.kind==='tree'||(d.kind==='architecture'&&visible.some(p=>p.parent))){hierarchy();}else{cards();}
  svg.setAttribute('viewBox','0 0 '+width+' '+height);svg.setAttribute('width',String(width*settings.zoom));svg.setAttribute('height',String(height*settings.zoom));
};
