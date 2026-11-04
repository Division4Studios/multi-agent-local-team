import * as vscode from 'vscode';
import { basename, isAbsolute, join } from 'node:path';
import { isView } from './diagram';
import { catalog } from './catalog';
import { exportScope } from './exportScope';
import { diagramKey } from './diagram';
import { digest } from './extract';
import type { Atlas } from './navigation';
import { publication, publicationKind } from './publication';
import { mapDirectory, saveMapFile } from './storage';
import type { Diagram } from './diagram';
import type { Snapshot } from './graph';

const pickTool = async (key:string,title:string):Promise<string|undefined>=>{
  const cfg=vscode.workspace.getConfiguration('malt.architecture');
  const global=cfg.inspect<string>(key)?.globalValue;
  if(global!==undefined&&isAbsolute(global)){return global;}
  const choice=await vscode.window.showOpenDialog({title,canSelectMany:false,canSelectFolders:false});
  const path=choice?.[0]?.fsPath;
  if(path!==undefined){await cfg.update(key,path,vscode.ConfigurationTarget.Global);}
  return path;
};
export const pinnedRepository=(remote:string,sha:string):{url:string;revision:string}|undefined=>{
  const m=/^(?:https:\/\/|git@)(github\.com|gitlab\.com)[:/]([\w.-]+(?:\/[\w.-]+)+?)\/?$/iu.exec(remote);
  if(m===null||!/^[a-f0-9]{40}$/u.test(sha)){return undefined;}
  return {url:`https://${String(m[1])}/${(m[2]??'').replace(/\.git$/u,'')}`,revision:sha};
};
const locale=():string=>{
  const lang=vscode.env.language.toLowerCase();
  if(lang.startsWith('zh')){return /tw|hant|hk/u.test(lang)?'zh-TW':'zh-CN';}
  return ['es','ko','ar'].find(l=>lang.startsWith(l))??'en';
};
const run=async(folder:vscode.WorkspaceFolder,args:string[]):Promise<void>=>{
  if(!vscode.workspace.isTrusted){return;}
  const cli=await pickTool('archifyPath','Select the trusted Archify installation’s bin/archify.mjs');
  if(cli===undefined){return;}
  const node=await pickTool('nodePath','Select the Node.js executable for diagram publication');
  if(node===undefined){return;}
  const task=new vscode.Task({type:'malt-diagram'},folder,'Finalize architecture artifact','MALT',
    new vscode.ProcessExecution(node,[cli,...args],{cwd:folder.uri.fsPath}));
  task.presentationOptions={reveal:vscode.TaskRevealKind.Always,panel:vscode.TaskPanelKind.Dedicated};
  await vscode.tasks.executeTask(task);
};
const pinned=(a:Atlas):boolean=>a.side==='base'||a.target!==undefined;
const repositoryAt=(a:Atlas,s:Snapshot):ReturnType<typeof pinnedRepository>=>{
  const repo=a.tracker.repository;
  const remote=repo?.state.remotes?.[0]?.fetchUrl??'';
  const clean=repo!==undefined&&[...repo.state.indexChanges,...repo.state.workingTreeChanges,...(repo.state.untrackedChanges??[])].length===0;
  return pinned(a)||s===a.base||clean?pinnedRepository(remote,s.commit):undefined;
};
const modelFile=async(a:Atlas,raw:Diagram,s:Snapshot,output:string):Promise<string>=>{
  const d=exportScope(s,raw,a.place.item);
  const repository=repositoryAt(a,s);
  const paths=new Map(s.nodes.filter(n=>n.path!=='').map(n=>[n.id,n.path]));
  const ir=publication(d,{output:basename(output),locale:locale(),paths,...(repository===undefined?{}:{repository})});
  const name=`export-${digest(JSON.stringify(ir))}.json`;
  await saveMapFile(a.tracker.folder.uri.fsPath,name,ir,()=>true);
  return join(a.tracker.folder.uri.fsPath,mapDirectory,name);
};
export const finalizeView=async(a:Atlas):Promise<void>=>{
  const d=a.model,s=a.snapshot;
  if(d===undefined||s===undefined||!isView(d.kind)){return;}
  const folder=a.tracker.folder;
  const output=await vscode.window.showSaveDialog({title:'Finalize diagram and browser-check the delivered HTML',filters:{HTML:['html']},defaultUri:vscode.Uri.joinPath(folder.uri,`${d.kind}.html`)});
  if(output===undefined){return;}
  const input=await modelFile(a,d,s,output.fsPath);
  if(a.base!==undefined&&d.kind==='architecture'){
    const choice=await vscode.window.showQuickPick(['Finalize displayed side','Export branch delta and receipt'],{title:'Architecture publication'});
    if(choice===undefined){return;}
    if(choice==='Export branch delta and receipt'){await exportDelta(a,d,output.fsPath);return;}
  }
  await run(folder,['finalize',publicationKind(d),input,output.fsPath,'--repo-root',folder.uri.fsPath,'--browser-check']);
};
const exportDelta=async(a:Atlas,d:Diagram,output:string):Promise<void>=>{
  const base=a.base,target=a.target??a.tracker.snapshot;
  if(base===undefined||target===undefined){return;}
  const matching=(s:Snapshot):Diagram=>catalog(s).find(m=>diagramKey(m)===diagramKey(d))??{...d,items:[],links:[]};
  const before=await modelFile(a,matching(base),base,output);
  const after=await modelFile(a,matching(target),target,output);
  await run(a.tracker.folder,['compare','architecture',before,after,output,'--repo-root',a.tracker.folder.uri.fsPath]);
};
/** Native Archify inputs retain custom design, translations, source cards and panel metadata verbatim. */
export const finalizeFile=async():Promise<void>=>{
  if(!vscode.workspace.isTrusted){return;}
  const chosen=await vscode.window.showOpenDialog({title:'Select a diagram or one-page answer JSON',filters:{JSON:['json']}});
  const uri=chosen?.[0];if(uri===undefined){return;}
  const folder=vscode.workspace.getWorkspaceFolder(uri);if(folder===undefined){throw new Error('Choose a model in an open workspace folder.');}
  const kind=await vscode.window.showQuickPick(['architecture','workflow','sequence','dataflow','lifecycle','erd','class','tree','timeline','waterfall','explainer'],{title:'Publication type'});
  if(kind===undefined){return;}
  const out=await vscode.window.showSaveDialog({filters:{HTML:['html']},defaultUri:vscode.Uri.file(uri.fsPath.replace(/\.json$/iu,'.html'))});if(out===undefined){return;}
  const browser=kind==='explainer'?await vscode.window.showQuickPick(['Include browser check','Skip browser check'],{title:'Check the one-page answer in Chrome?'}):'Include browser check';
  if(browser!==undefined){await run(folder,['finalize',kind,uri.fsPath,out.fsPath,'--repo-root',folder.uri.fsPath,...(browser==='Include browser check'?['--browser-check']:[])]);}
};
