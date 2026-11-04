import { newDiagram, isView } from './diagram';
import type { Diagram } from './diagram';
import type { MapNode } from './graph';
import type { ModelClaim } from '../shared/understanding';

const addClaim=(models:Map<string,Diagram>,n:MapNode,claim:ModelClaim):void=>{
  if(!isView(claim.view)){return;}
  const key=JSON.stringify([claim.view,claim.title]);
  const d=models.get(key)??newDiagram('',claim.view,claim.title,`agent:${claim.title}`);
  for(const name of [claim.from,claim.to]){
    if(!d.items.some(i=>i.id===name)){d.items.push({id:name,label:name,ref:`concept:${name}`,detail:n.path,group:n.understanding?.role??'Agent interpretation'});}
  }
  const kind=claim.evidence===''?'Hypothesis':'Matched excerpt';
  d.links.push({from:claim.from,to:claim.to,label:`${claim.label} · ${kind}`,kind});
  models.set(key,d);
};
export const agentModels=(nodes:readonly MapNode[]):Diagram[]=>{
  const models=new Map<string,Diagram>();
  for(const node of nodes){for(const claim of node.understanding?.claims??[]){addClaim(models,node,claim);}}
  return [...models.values()];
};
