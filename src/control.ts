import { connect } from 'node:net';
import { RequestSchema, type Request } from './models.js';
import { paths, ROOT } from './config.js';

export const MAX_MESSAGE=1024*1024;
export async function send(request: Request, root=ROOT): Promise<unknown> {
  RequestSchema.parse(request);
  return new Promise((resolve,reject)=>{
    const socket=connect(paths(root).socket);const chunks:Buffer[]=[];let bytes=0;
    socket.setTimeout(120_000,()=>socket.destroy(new Error('Supervisor request timed out')));
    socket.on('connect',()=>socket.end(JSON.stringify(request)+'\n'));
    socket.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>MAX_MESSAGE)socket.destroy(new Error('Supervisor response too large'));else chunks.push(chunk);});
    socket.on('error',reject);
    socket.on('end',()=>{
      try {const reply=JSON.parse(Buffer.concat(chunks).toString()) as {ok:boolean;result?:unknown;error?:string};
        if(!reply.ok)reject(new Error(reply.error??'Supervisor request failed'));else resolve(reply.result);
      }catch(e){reject(e);}
    });
  });
}
export function parseCommand(args: string[]): Request {
  const [cmd,...rest]=args;
  if(!cmd) return {command:'status'};
  if(cmd==='plan')return RequestSchema.parse({command:cmd,issue:rest[0]});
  if(['health','status','pause','resume','cancel','cleanup','shutdown'].includes(cmd))return RequestSchema.parse({command:cmd,...(rest[0]?{run:rest[0]}:{})});
  const [run,...flags]=rest;
  const field=(name:string):string|undefined=>{const index=flags.indexOf(`--${name}`);return index>=0?flags[index+1]:undefined;};
  const messageIndex=flags.indexOf('--message');const message=messageIndex>=0?flags.slice(messageIndex+1).join(' '):undefined;
  if(cmd==='approve'){
    const plan=field('plan');const candidate=field('candidate');
    if(Boolean(plan)===Boolean(candidate))throw new Error('Specify exactly one --plan HASH or --candidate HASH');
    return RequestSchema.parse({command:cmd,run,gate:plan?'plan':'candidate',hash:plan??candidate});
  }
  if(['revise','steer','answer'].includes(cmd))return RequestSchema.parse({command:cmd,run,message,...(cmd==='answer'?{request:field('request')}:{})});
  if(cmd==='resend')return RequestSchema.parse({command:cmd,run,...(field('request')?{request:field('request')}:{})});
  throw new Error(`Unknown factory command: ${cmd}`);
}
