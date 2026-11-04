import type * as vscode from 'vscode';
import { isRecord } from '../shared/guards';
import { isSourceCodePath } from '../reviewer/standardsSources';
import { isView, views } from './diagram';
import { finalizeView } from './finalize';
import type { Atlas } from './navigation';
import type { Place } from './catalog';
import type { MapNode } from './graph';

export const parsePlace=(m:unknown):Place|undefined=>{
  if(!isRecord(m)||!isView(m['kind'])||typeof m['key']!=='string'||typeof m['item']!=='string'){return undefined;}
  return {kind:m['kind'],key:m['key'],item:m['item']};
};
const hints:Readonly<Record<string,string>>={
  workflow:'Add a GitHub Actions workflow or an authored workflow.', lifecycle:'Add a Mermaid state diagram (.mmd) or an authored lifecycle.',
  dataflow:'Add a SQL INSERT … SELECT statement or an authored data-flow diagram.',er:'Add SQL CREATE TABLE declarations.',
  timeline:'Open a Git repository or provide timestamped events.', waterfall:'Provide a *.trace.json with Chrome complete-duration events or authored timed spans.',
  classes:'Select a project with class or interface declarations.', sequence:'Select a project with resolved calls or an authored exchange.',
};
export const selectedSource=(a:Atlas):MapNode|undefined=>{
  const s=a.snapshot, p=a.item, d=a.model;
  if(s===undefined||p===undefined||d===undefined){return undefined;}
  const exact=s.nodes.find(n=>n.id===p.ref);
  if(exact!==undefined){return exact;}
  const file=s.nodes.find(n=>n.kind==='file'&&(n.path===d.path||n.path===p.detail));
  return file===undefined?undefined:{...file,line:p.line??file.line};
};
export const sendView=(a:Atlas,web:vscode.Webview):void=>{
  const d=a.model, p=a.place, src=selectedSource(a);
  void web.postMessage({action:'perspective',kinds:Object.entries(views).map(([k,v])=>[k,v[0]]),question:views[p.kind][1],
    place:p,menu:a.menu(p.kind),model:d,related:a.links(),source:src!==undefined,discuss:a.base===undefined&&isSourceCodePath(src?.path??''),
    compare:a.base!==undefined,side:a.side,empty:hints[p.kind]??'No evidence for this view.'});
};
const focusItem=(a:Atlas,id:unknown):void=>{if(typeof id==='string'){a.visit({...a.place,item:id});}};
interface Actions { source:()=>Promise<void>; discuss:()=>void; tray:()=>Promise<void> }
export const handleView=async(a:Atlas,m:Record<string,unknown>,ops:Actions):Promise<void>=>{
  const place=parsePlace(m);
  switch(m['action']){
    case 'perspective': if(place!==undefined){a.visit(place);}break;
    case 'graphFocus': focusItem(a,m['id']);break;
    case 'viewTray': await ops.tray();break;
    case 'viewSide': a.switchSide();break;
    case 'viewBack': a.previous();break;
    case 'viewSource': await ops.source();break;
    case 'viewDiscuss': ops.discuss();break;
    case 'viewExport': await finalizeView(a);break;
  }
};
