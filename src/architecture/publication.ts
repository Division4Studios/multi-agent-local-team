import { createHash } from 'node:crypto';
import type { Diagram, Part, Wire } from './diagram';

const colors = ['frontend','backend','database','cloud','security','messagebus','external'];
const uml: Readonly<Record<string,string>> = { implements:'realization',inherits:'inheritance',composition:'composition',aggregation:'aggregation',association:'association',dependency:'dependency' };
const names: Readonly<Record<string,string>>={er:'erd',classes:'class'};
export const publicationKind=(d:Diagram):string=>names[d.kind]??d.kind;
interface Context { id: (s:string)=>string; group: (p:Part)=>string; groups:string[]; color:(p:Part)=>string }
type Entry = Record<string,unknown>;
const idMap = (d: Diagram): Context => {
  const ids = new Map(d.items.map(p=>[p.id,`n${createHash('sha256').update(p.id).digest('hex').slice(0,24)}`]));
  const group = (p: Part): string => p.group ?? 'Components';
  const groups = [...new Set(d.items.map(group))];
  return { id:s=>ids.get(s) ?? 'missing',group,groups,color:p=>colors[groups.indexOf(group(p)) % 7] ?? 'external' };
};
const wire = (w: Wire, c: Context, i: number): Entry => ({id:`r${String(i+1)}`,from:c.id(w.from),to:c.id(w.to),label:w.label});
const pair = (p:Part,c:Context): Entry => ({id:c.id(p.id),label:p.label});
const source = (p:Part, d:Diagram, paths:ReadonlyMap<string,string>): Entry => {
  const path = paths.get(p.ref ?? '') ?? d.path;
  return path === '' ? {} : {sources:[{path,...(p.line === undefined ? {} : {line:p.line})}]};
};
const linkKind=(w:Wire):string=>uml[w.kind ?? ''] ?? 'dependency';
const dates=(d:Diagram,c:Context):Entry=>({events:d.items.map(p=>({id:c.id(p.id),title:p.label,at:new Date(required(p.start)).toISOString(),detail:p.detail ?? ''}))});
const timeModel=(d:Diagram,c:Context,parent:(p:Part)=>Entry):Entry=>{
  if(d.kind==='timeline'){return dates(d,c);}
  return {spans:d.items.map(p=>({id:c.id(p.id),name:p.label,service:c.group(p),start:required(p.start),end:required(p.end),...parent(p)}))};
};
const data = (d:Diagram,c:Context,paths:ReadonlyMap<string,string>): Entry => {
  const nodes=d.items, edges=d.links.map((l,i)=>wire(l,c,i));
  const groups=c.groups.map((label,i)=>({id:`g${String(i)}`,label}));
  const groupId=(p:Part):string=>`g${String(c.groups.indexOf(c.group(p)))}`;
  const parent=(p:Part):Entry=> p.parent !== undefined && c.id(p.parent)!=='missing' ? {parent:c.id(p.parent)} : {};
  const typed=(p:Part):Entry=>({...pair(p,c),type:c.color(p),...source(p,d,paths)});
  const formats:Record<Diagram['kind'],()=>Entry>={
    architecture:()=>({layout:{mode:'grid',gapX:120,gapY:100},components:nodes.map((p,i)=>({...typed(p),row:Math.floor(i/4),col:i%4})),connections:edges}),
    workflow:()=>({lanes:groups,nodes:nodes.map((p,i)=>({...typed(p),lane:groupId(p),col:i})),edges}),
    sequence:()=>({participants:nodes.map(typed),messages:d.links.map((l,i)=>({...wire(l,c,i),y:170+i*55,variant:l.kind==='return'?'return':'default'}))}),
    dataflow:()=>({stages:c.groups.map(label=>({label})),nodes:nodes.map((p,i)=>({...typed(p),stage:c.groups.indexOf(c.group(p)),row:i})),flows:edges}),
    lifecycle:()=>({mainPath:mainPath(d,c),states:nodes.map(p=>({...pair(p,c),type:stateType(p),...source(p,d,paths)})),transitions:edges}),

    er:()=>({layout:{mode:'grid'},entities:nodes.map((p,i)=>({...pair(p,c),row:Math.floor(i/3),col:i%3,attributes:(p.fields??[]).map(f=>({name:f})),...source(p,d,paths)})),
      relationships:d.links.map((l,i)=>({...wire(l,c,i),...cardinality('from',l.fromEnd),...cardinality('to',l.toEnd)}))}),
    classes:()=>({layout:{mode:'grid'},types:nodes.map((p,i)=>({...pair(p,c),row:Math.floor(i/3),col:i%3,kind:classKind(p),attributes:(p.fields??[]).map(f=>({name:f})),...source(p,d,paths)})),
      relationships:d.links.map((l,i)=>({...wire(l,c,i),kind:linkKind(l)}))}),
    tree:()=>({nodes:nodes.map(p=>({...pair(p,c),...parent(p),...source(p,d,paths)}))}),
    timeline:()=>timeModel(d,c,parent), waterfall:()=>timeModel(d,c,parent),
  };
  return formats[d.kind]();
};
const required=(n:number|undefined):number=>{if(n===undefined||!Number.isFinite(n)){throw new Error('Missing clock value.');}return n;};
const classKind=(p:Part):string=>['interface','enum','record','abstract'].includes(p.group ?? '') ? String(p.group) : 'class';
const stateType=(p:Part):string=>p.id==='[start]'?'start':p.id==='[end]'?'success':'active';
const cardinality=(side:string,v:string|undefined):Entry=>{
  if(!['1','0..1','0..*','1..*'].includes(v ?? '')){throw new Error('Both ends of each relationship need a cardinality.');}
  return {[`${side}Cardinality`]:v?.endsWith('*')===true?'many':'one',[`${side}Optional`]:v?.startsWith('0')===true};
};
const mainPath=(d:Diagram,c:Context):string[]=>{
  const start=d.items.find(p=>!d.links.some(l=>l.to===p.id))??d.items[0];if(start===undefined){return [];}
  const visited=new Set([start.id]);let current=start.id;
  while(visited.size<=d.items.length){const next=d.links.find(l=>l.from===current&&!visited.has(l.to));if(next===undefined){break;}current=next.to;visited.add(current);}
  return [...visited].map(c.id);
};
const showRoleLegend=(d:Diagram,c:Context):boolean=>['architecture','workflow'].includes(d.kind)&&c.groups.length<=7;
const timingEvidence=(d:Diagram):string=>d.path.endsWith('.malt-model.json')?'illustrative':d.kind==='waterfall'?'measured':'observed';
const schemaVersion=(d:Diagram):number=>d.kind==='workflow'?2:d.kind==='lifecycle'?3:1;
interface PublicationOptions { output:string; locale:string; paths:ReadonlyMap<string,string>; repository?:{url:string;revision:string} }
export const publication = (d:Diagram,o:PublicationOptions):Entry=>{
  if(d.items.length===0){throw new Error('This view has no evidence to publish.');}
  const c=idMap(d);
  if(d.links.some(l=>c.id(l.from)==='missing'||c.id(l.to)==='missing')){throw new Error('A relationship references an unresolved item. Include all its endpoints before publishing.');}
  const meta:Entry={title:d.title,output:o.output,locale:o.locale};
  if(o.repository!==undefined){meta['repository']=o.repository;}
  if(d.kind==='timeline'||d.kind==='waterfall'){meta['evidence']=timingEvidence(d);}
  if(d.kind==='waterfall'){meta['unit']='ms';}
  if(showRoleLegend(d,c)){
    meta['legend']={mode:'auto',entries:Object.fromEntries(c.groups.map((label,i)=>[colors[i]??'external',{label:label.slice(0,80)}] as const))};
  }
  return {schema_version:schemaVersion(d),diagram_type:publicationKind(d),meta,...data(d,c,o.paths)};
};
