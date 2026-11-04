import { newDiagram } from './diagram';
import type { Diagram } from './diagram';
import type { FileFacts } from './extract';
import type { MapEdge, MapNode } from './graph';

const typeKinds = new Set(['class','interface','record','struct','trait','enum']);
const typeName = (n: MapNode): string => {
  const ids: unknown = JSON.parse(n.id);
  return Array.isArray(ids) && typeof ids[1] === 'string' ? ids[1] : n.label;
};
type Names=ReadonlyMap<string,MapNode[]>;
const declaredTarget=(signature:string,names:Names,language:string|undefined):{node:MapNode;kind:string}|undefined=>{
  const construction=/=\s*new\s+([A-Z][\w$]*)/u.exec(signature)?.[1];
  const annotation=/:\s*([A-Z][\w$]*)|\b([A-Z][\w$]*)\s+\w+\s*[;=]/u.exec(signature);
  const name=construction??annotation?.[1]??annotation?.[2];
  const matches=names.get(name??'')?.filter(n=>typeKinds.has(n.kind)&&n.tags[0]===language);
  const node=matches?.length===1?matches[0]:undefined;
  return node===undefined?undefined:{node,kind:construction===undefined?'dependency':'composition'};
};
const classes = (file: FileFacts, nodes: Map<string,MapNode>, edges: readonly MapEdge[],names:Names): Diagram[] => {
  const types = file.symbols.filter((s) => typeKinds.has(s.kind));
  if (types.length === 0) { return []; }
  const d = newDiagram(file.path,'classes',file.path);
  const add = (n: MapNode): void => {
    if (!d.items.some((i) => i.id === n.id)) {
      d.items.push({ id:n.id, label:n.label, ref:n.id, line:n.line, group:n.kind, fields: n.path === file.path ? file.members?.get(typeName(n)) ?? [] : [] });
    }
  };
  const owner = (id: string): MapNode | undefined => {
    let n = nodes.get(id);
    while (n !== undefined && !typeKinds.has(n.kind)) { n = nodes.get(n.parent); }
    return n;
  };
  for (const t of types) {
    const n = nodes.get(JSON.stringify([file.path,t.qualified])); if (n !== undefined) { add(n); }
  }
  const linked = new Set<string>();
  for(const t of types){
    const from=JSON.stringify([file.path,t.qualified]);
    for(const sig of file.members?.get(t.qualified)??[]){
      const target=declaredTarget(sig,names,file.tags[0]);
      if(target!==undefined&&target.node.id!==from){
        add(target.node);const edge={from,to:target.node.id,kind:target.kind,label:target.kind};
        const key=JSON.stringify([from,edge.to,edge.kind]);if(!linked.has(key)){d.links.push(edge);linked.add(key);}
      }
    }
  }
  for (const e of edges) {
    const from = owner(e.from), to = owner(e.to);
    if (from === undefined || to === undefined || from === to) { continue; }
    const kind = e.kind === 'calls' ? 'dependency' : e.kind;
    const id = JSON.stringify([from.id,to.id,kind]); if (linked.has(id)) { continue; }
    add(from); add(to); linked.add(id); d.links.push({ from:from.id,to:to.id,label:kind,kind });
  }
  return [d];
};
export const codeDiagrams = (file: FileFacts, nodes: Map<string,MapNode>, edges: readonly MapEdge[],names:Names): Diagram[] => {
  const models = new Map<string,Diagram>();
  for (const e of edges) {
    const from = nodes.get(e.from), to = nodes.get(e.to);
    if (e.kind !== 'calls' || from === undefined || to === undefined) { continue; }
    const d = models.get(from.id) ?? newDiagram(file.path,'sequence',`${from.label  } · ${  file.path}`,from.id);
    for (const n of [from,to]) {
      if (!d.items.some((i) => i.id === n.id)) { d.items.push({ id:n.id,label:n.label,ref:n.id,group:n.path,line:n.line }); }
    }
    d.links.push({ from:from.id,to:to.id,label:`${to.label  } · L${  String(e.line)}`,kind:'call' });
    models.set(from.id,d);
  }
  return [...classes(file,nodes,edges,names), ...models.values()];
};
