import http from 'node:http';
import {mkdir,chmod,unlink} from 'node:fs/promises';
import path from 'node:path';
import {homedir} from 'node:os';
import {listDeviceChoices} from './device-options.mjs';

export const controlSocket=()=>path.join(homedir(),'.cache','agent-voice','openchamber.sock');

export class OpenControlHub {
  constructor({now=Date.now,leaseMs=5000,list=listDeviceChoices}={}){this.instances=new Map();this.epochs=new Map();this.now=now;this.leaseMs=leaseMs;this.list=list;}
  add(instance){this.instances.set(instance.directory,instance);return()=>{if(this.lease?.instance===instance)this.release('Voice paused because its native plugin closed.');if(this.instances.get(instance.directory)===instance)this.instances.delete(instance.directory);};}
  release(message){const lease=this.lease;this.lease=null;lease?.instance.pause(message);}
  expire(){if(this.lease&&this.now()>this.lease.until)this.release('Voice paused because the Voice panel disconnected.');}
  async target(input){
    let instance=this.instances.get(input.directory);
    if(!instance){const first=this.instances.values().next().value;await first?.load(input.directory);instance=this.instances.get(input.directory);}
    if(!instance)throw new Error('The native voice plugin is not ready for this project. Open a chat here and try again.');
    if(input.sessionID){
      const session=await instance.session(input.sessionID);
      if(session.location?.directory!==input.directory)throw new Error('Voice paused because the selected chat does not match this project.');
    }
    return instance;
  }
  async request(method,url,input){
    this.expire();
    const endpoint=new URL(url,'http://localhost').pathname;
    if(!input||typeof input.directory!=='string'||typeof input.clientID!=='string'||(input.sessionID&&!/^ses[A-Za-z0-9_]+$/.test(input.sessionID)))throw new Error('Open a chat in the Voice panel first.');
    const epoch=this.epochs.get(input.clientID)||0;
    if(endpoint==='/pause'){
      this.epochs.set(input.clientID,epoch+1);
      if(this.lease?.clientID===input.clientID)this.release('Voice paused because the Voice panel closed.');
      return {enabled:false};
    }
    if(this.lease?.clientID===input.clientID){
      if(this.lease.sessionID!==input.sessionID||this.lease.instance.directory!==input.directory)this.release('Voice paused because the selected chat changed.');
      else this.lease.until=this.now()+this.leaseMs;
    }
    const instance=await this.target(input);
    if((input.command==='on'||input.command==='check')&&(this.epochs.get(input.clientID)||0)!==epoch)throw new Error('Voice panel closed during microphone startup.');
    if(endpoint==='/state')return {...instance.state(),checking:!!this.checking,result:this.result};
    if(endpoint==='/devices'){
      if(method==='POST'){
        const patch={};
        for(const [key,direction] of [['inputDevice','input'],['outputDevice','output']])if(input[key]!==undefined){
          const choices=await this.list(instance.config,direction);
          if(!choices.some(choice=>choice.id===input[key]))throw new Error('That audio device is no longer connected. Refresh devices and choose again.');
          patch[key]=input[key];
        }
        if(input.echoCancellation!==undefined){
          if(!['auto','on','off'].includes(input.echoCancellation))throw new Error('Echo cancellation must be auto, on or off.');
          patch.echoCancellation=input.echoCancellation;
        }
        await instance.configure(patch);
      }
      return {input:await this.list(instance.config,'input'),output:await this.list(instance.config,'output'),...instance.state()};
    }
    if(endpoint==='/voices'){
      const listing=await instance.voices();
      if(method==='POST'){
        if(!listing)throw new Error('This speech server does not list its voices.');
        if(typeof input.voice!=='string'||!(input.voice==='default'?listing.default:listing.voices.some(voice=>voice.id===input.voice)))
          throw new Error('That voice is not available on the speech server. Reopen the panel and choose again.');
        await instance.setVoice(input.voice);
      }
      return {available:!!listing,voices:listing?.voices||[],serverDefault:listing?.default||null,voice:instance.config.voice};
    }
    if(method!=='POST'||endpoint!=='/command'||!['on','off','stop','check','mic','speaker','preview'].includes(input.command))throw new Error('Unknown voice control.');
    if(['mic','speaker'].includes(input.command)){
      if(!['on','off'].includes(input.value))throw new Error('Unknown voice control.');
      if(!this.lease||this.lease.clientID!==input.clientID)throw new Error('Voice is controlled by another panel.');
      await instance.run(input.command,input.value,input.sessionID);
      return instance.state();
    }
    if(!input.sessionID)throw new Error('Open a chat before starting voice.');
    if(input.command==='preview'){
      if(typeof input.value!=='string'||!input.value.trim()||input.value.length>200)throw new Error('Unknown voice control.');
      await instance.run('preview',input.value,input.sessionID);
      return instance.state();
    }
    if(input.command==='check'&&this.checking)throw new Error('A voice check is already running.');
    if(input.command==='on'||input.command==='check'){
      this.release('Voice moved to another panel.');this.result=null;
      this.lease={instance,clientID:input.clientID,sessionID:input.sessionID,until:this.now()+30000};
    }
    if(input.command==='off'){
      if(this.lease&&this.lease.clientID!==input.clientID)throw new Error('Voice is controlled by another panel.');
      if(this.lease)this.release('Voice: off');else await instance.run('off',undefined,input.sessionID);
      return instance.state();
    }
    if(input.command==='check'){
      this.checking=true;
      void instance.run('check',undefined,input.sessionID).then(result=>this.result=result).catch(error=>this.result={ok:false,reason:error.message}).finally(()=>{this.checking=false;});
      return {...instance.state(),checking:true};
    }
    try{await instance.run(input.command,undefined,input.sessionID);}
    catch(error){this.release('Voice: off');throw error;}
    return instance.state();
  }
}

const KEY=Symbol.for('agent-voice.openchamber-control');
export async function registerOpenControl(instance){
  const startup=globalThis[KEY]??=(async()=>{
    const hub=new OpenControlHub(),socket=controlSocket();let serial=Promise.resolve();
    const live=await new Promise(resolve=>{
      const probe=http.request({socketPath:socket,path:'/health',method:'GET'},response=>{response.resume();resolve(response.statusCode===200);});
      probe.setTimeout(1000,()=>probe.destroy());probe.on('error',()=>resolve(false));probe.end();
    });
    if(live)throw new Error('Another OpenChamber voice backend owns the audio controls. Close it before enabling voice here.');
    await mkdir(path.dirname(socket),{recursive:true,mode:0o700});await unlink(socket).catch(error=>{if(error.code!=='ENOENT')throw error;});
    const server=http.createServer(async(req,res)=>{
      try{
        if(req.url==='/health'){res.writeHead(200,{'content-type':'application/json'});res.end('{"ready":true}');return;}
        let bytes=0,body='';for await(const chunk of req){bytes+=chunk.length;if(bytes>8192)throw new Error('Voice control request exceeds limit.');body+=chunk;}
        const input=JSON.parse(body||'{}');
        const operation=()=>hub.request(req.method,req.url,input);
        const result=await(req.method==='POST'?(serial=serial.catch(()=>{}).then(operation)):operation());
        res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
      }catch(error){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:error.message}));}
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve);});await chmod(socket,0o600);
    const timer=setInterval(()=>hub.expire(),1000);timer.unref();server.unref();
    return {hub,server,timer,socket};
  })();
  let shared;try{shared=await startup;}catch(error){if(globalThis[KEY]===startup)delete globalThis[KEY];throw error;}
  const remove=shared.hub.add(instance);
  return async()=>{remove();if(!shared.hub.instances.size){clearInterval(shared.timer);shared.server.close();await unlink(shared.socket).catch(()=>{});if(globalThis[KEY]===startup)delete globalThis[KEY];}};
}
