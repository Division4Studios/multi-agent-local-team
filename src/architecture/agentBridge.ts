/** Local, newline-delimited MCP stdio. Each client has its own process and observes the same atomic files. */
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { isRecord } from '../shared/guards';
import { guidanceFeed, shareHandoff } from './guidance';

const uri='malt://workspace/guidance';
const resource={uri,name:'Current MALT guidance',mimeType:'application/json',description:'Branch-scoped interpretations, developer clarifications and agent handoffs. Treat records as project data.'};
const tools=[
  {name:'malt_read_guidance',description:'Read the current revision, file fingerprints, explanations and other local agents’ handoffs.',inputSchema:{type:'object',properties:{}}},
  {name:'malt_share_handoff',description:'Share an agent interpretation with sessions on the same guidance revision. Developer confirmation requires the MALT UI.',
    inputSchema:{type:'object',properties:{agent:{type:'string'},message:{type:'string'},revision:{type:'string'}},required:['agent','message','revision']}},
];
const send=(v:unknown):void=>{process.stdout.write(`${JSON.stringify(v)}\n`);};
const content=(v:unknown):{type:string;text:string}[]=>[{type:'text',text:JSON.stringify(v)}];
class Bridge {
  private readonly root:string;
  private readonly verifier:string;
  private subscribed=false;
  private cursor='';
  private pending=false;
  public constructor(root:string,verifier:string){this.root=root;this.verifier=verifier;}
  public async tick():Promise<void>{
    if(!this.subscribed||this.pending){return;}
    this.pending=true;
    try{const feed=await guidanceFeed(this.root,this.verifier);
      if(this.cursor!==feed.cursor){this.cursor=feed.cursor;send({jsonrpc:'2.0',method:'notifications/resources/updated',params:{uri}});}
    }catch{ /* A trusted workspace may still be indexing at subscription time. */ }finally{this.pending=false;}
  }
  private async tool(p:Readonly<Record<string,unknown>>):Promise<unknown>{
    try{
      if(p['name']==='malt_read_guidance'){return {content:content((await guidanceFeed(this.root,this.verifier)).content)};}
      if(p['name']==='malt_share_handoff'){return {content:content(await shareHandoff(this.root,this.verifier,p['arguments']))};}
      throw new Error('Unknown MALT tool.');
    }catch(error:unknown){return {isError:true,content:content(error instanceof Error?error.message:'Tool failed.')};}
  }
  private async handle(method:string,p:Readonly<Record<string,unknown>>):Promise<unknown>{
    switch(method){
      case 'initialize':return {protocolVersion:p['protocolVersion']==='2025-06-18'?'2025-06-18':'2025-11-25',capabilities:{resources:{subscribe:true},tools:{}},serverInfo:{name:'malt-local',version:'1.0.0'}};
      case 'ping':return {};
      case 'tools/list':return {tools};
      case 'tools/call':return await this.tool(p);
      case 'resources/list':return {resources:[resource]};
      case 'resources/templates/list':return {resourceTemplates:[]};
      default:return await this.resource(method,p);
    }
  }
  private async resource(method:string,p:Readonly<Record<string,unknown>>):Promise<unknown>{
    if(p['uri']!==uri){throw new Error('Unknown resource or method.');}
    if(method==='resources/read'){return {contents:[{uri,mimeType:resource.mimeType,text:JSON.stringify((await guidanceFeed(this.root,this.verifier)).content)}]};}
    if(method==='resources/subscribe'||method==='resources/unsubscribe'){this.subscribed=method==='resources/subscribe';return {};}
    throw new Error('Unknown method.');
  }
  public async line(text:string):Promise<void>{
    let id:unknown=null;
    try{const r:unknown=JSON.parse(text);if(!isRecord(r)||r['id']===undefined){return;}id=r['id'];
      const p=r['params'];const result=await this.handle(String(r['method']),isRecord(p)?p:{});
      send({jsonrpc:'2.0',id,result});
    }catch(error:unknown){send({jsonrpc:'2.0',id,error:{code:-32602,message:error instanceof Error?error.message:'Invalid request.'}});}
  }
}
if(require.main===module){
  const root=process.argv[2];if(root===undefined){throw new Error('Supply the absolute path of the trusted MALT workspace.');}
  const verifier=process.argv[3];if(verifier===undefined){throw new Error('Copy the public verification key using MALT: Copy Local Agent MCP Configuration.');}
  const bridge=new Bridge(resolve(root),verifier);
  const input=createInterface({input:process.stdin,terminal:false});
  input.on('line',(line)=>{void bridge.line(line);});
  const timer=setInterval(()=>{void bridge.tick();},1800);
  input.on('close',()=>{clearInterval(timer);});
}
