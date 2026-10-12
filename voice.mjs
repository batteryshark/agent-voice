import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,unlink,rmdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import path from 'node:path';
import {WebSocket} from 'ws';
import {audioDevices} from './native-audio.mjs';

// asrUrl: streaming recognition websocket; ttsUrl: OpenAI-compatible /v1/audio/speech.
export const defaults={asrUrl:'',ttsUrl:'',ttsModel:'tts-1',voice:'alloy',
  ffmpeg:'ffmpeg',ffplay:'ffplay',pauseMs:1100,threshold:0.012,duplex:process.platform==='darwin',inputDevice:'default',outputDevice:'default'};

// GUI-launched hosts (desktop apps, daemons) often lack Homebrew in PATH.
export function resolveBinary(name,env=process.env,platform=process.platform){
  if(!name||path.isAbsolute(name)||name.includes('/')||name.includes('\\'))return name;
  const extra=platform==='win32'?[]:['/opt/homebrew/bin','/usr/local/bin','/opt/local/bin',path.join(homedir(),'.local','bin')];
  const dirs=[...(env.PATH||'').split(path.delimiter),...extra].filter(Boolean);
  const names=platform==='win32'?[name,name+'.exe']:[name];
  for(const dir of dirs)for(const candidate of names){const full=path.join(dir,candidate);if(existsSync(full))return full;}
  return name;
}
export function captureArgs(device,platform=process.platform) {
  const input=platform==='darwin'?['-f','avfoundation','-i',`:${device||'default'}`]
    :platform==='win32'?['-f','dshow','-i',`audio=${device}`]:['-f','pulse','-i',device||'default'];
  return ['-hide_banner','-loglevel','error','-nostdin',...input,'-ar','16000','-ac','1','-f','s16le','pipe:1'];
}
export async function devices(config) {
  if(process.platform==='darwin')return audioDevices();
  const args=process.platform==='darwin'?['-f','avfoundation','-list_devices','true','-i','']
    :process.platform==='win32'?['-list_devices','true','-f','dshow','-i','dummy']:['-sources','pulse'];
  return new Promise((resolve,reject)=>{
    const child=spawn(config.ffmpeg,['-hide_banner',...args],{windowsHide:true,stdio:['ignore','ignore','pipe']});
    let output='';const timer=setTimeout(()=>child.kill(),10000);
    child.stderr.on('data',data=>output+=data);child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',()=>{clearTimeout(timer);resolve(output);});
  });
}
export function windowsMicrophones(output) {return [...output.matchAll(/"([^"]+)"\s*\(audio\)/g)].map(match=>match[1]);}

export class AudioCapture extends EventEmitter {
  constructor(config){super();this.config=config;}
  start(){
    this.child=spawn(this.config.ffmpeg,captureArgs(this.config.device),{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let error='';this.child.stdout.on('data',pcm=>this.emit('pcm',pcm));
    this.child.stderr.on('data',data=>error=(error+data).slice(-2000));
    this.child.on('error',e=>this.emit('failure',e));
    this.child.on('exit',code=>{if(!this.stopping)this.emit('failure',new Error(error.trim()||`Microphone capture exited (${code}).`));});
  }
  stop(){this.stopping=true;this.child?.kill();}
}

export class Recognition {
  constructor(config,callbacks){this.config=config;this.callbacks=callbacks;this.queue=[];this.text='';this.failed=false;}
  start(){
    const headers=this.config.asrApiKey?{Authorization:'Bearer '+this.config.asrApiKey}:undefined;
    this.ws=new WebSocket(this.config.asrUrl,{headers,handshakeTimeout:10000,maxPayload:1024*1024});
    this.timer=setTimeout(()=>this.cancel(new Error('Recognition timed out.')),120000);
    this.ws.on('open',()=>{for(const chunk of this.queue)this.ws.send(chunk);this.queue=[];if(this.ended)this.ws.send(JSON.stringify({type:'input_audio.end'}));});
    this.ws.on('message',data=>{
      let event;try{event=JSON.parse(data.toString());}catch{return;}
      if(event.type==='transcript'){this.text+=event.text;this.callbacks.partial?.(this.text.trim());}
      if(event.type==='error')this.cancel(new Error(event.message||'Recognition failed.'));
    });
    this.ws.on('error',e=>{this.failed=true;this.callbacks.error(e);});
    this.ws.on('close',()=>{clearTimeout(this.timer);this.callbacks.done(this.failed?'':this.text.trim());});
  }
  write(pcm){if(this.ws.readyState===WebSocket.OPEN)this.ws.send(pcm);else if(this.ws.readyState===WebSocket.CONNECTING)this.queue.push(pcm);}
  end(){this.ended=true;if(this.ws.readyState===WebSocket.OPEN)this.ws.send(JSON.stringify({type:'input_audio.end'}));}
  cancel(error){this.failed=true;clearTimeout(this.timer);if(error)this.callbacks.error(error);this.ws?.close();}
}

export class VoiceInput {
  constructor(config,callbacks,createRecognition=(config,callbacks)=>new Recognition(config,callbacks)) {
    this.config=config;this.callbacks=callbacks;this.createRecognition=createRecognition;this.buffer=Buffer.alloc(0);this.preroll=[];this.voiced=0;this.silent=0;this.frames=0;this.waiting=false;
  }
  push(bytes){
    if(this.closed)return;
    this.buffer=Buffer.concat([this.buffer,bytes]);
    while(this.buffer.length>=640){const frame=Buffer.from(this.buffer.subarray(0,640));this.buffer=this.buffer.subarray(640);this.frame(frame);}
  }
  frame(frame){
    if(this.waiting)return;
    if(!this.recognition && this.callbacks.muted?.()){this.preroll=[];this.voiced=0;return;}
    let sum=0;for(let i=0;i<640;i+=2){const sample=frame.readInt16LE(i)/32768;sum+=sample*sample;}
    const voiced=Math.sqrt(sum/320)>this.config.threshold;
    if(!this.recognition){
      this.preroll.push(frame);if(this.preroll.length>15)this.preroll.shift();this.voiced=voiced?this.voiced+1:0;
      if(this.voiced<8)return;
      this.callbacks.start?.();
      const recognition=this.createRecognition(this.config,{partial:text=>{if(this.recognition===recognition)this.callbacks.partial?.(text);},error:e=>{if(this.recognition===recognition)this.callbacks.error(e);},done:text=>{
        if(this.recognition!==recognition)return;this.recognition=null;this.waiting=false;this.voiced=0;this.silent=0;
        if(!this.closed&&text)this.callbacks.transcript(text);
        this.callbacks.idle?.();
      }});
      this.recognition=recognition;recognition.start();for(const pcm of this.preroll)recognition.write(pcm);this.preroll=[];this.frames=0;this.silent=0;
    }else{
      this.recognition.write(frame);this.frames++;this.silent=voiced?0:this.silent+1;
      if(this.silent*20>=this.config.pauseMs||this.frames>=4500){this.waiting=true;this.recognition.end();}
    }
  }
  /** Drop the utterance in progress (for a mic mute) and keep listening afterwards. */
  discard(){const recognition=this.recognition;this.recognition=null;this.waiting=false;this.voiced=0;this.silent=0;this.frames=0;this.buffer=Buffer.alloc(0);this.preroll=[];if(recognition){recognition.cancel();this.callbacks.idle?.();}}
  stop(){this.closed=true;this.recognition?.cancel();this.recognition=null;this.buffer=Buffer.alloc(0);this.preroll=[];}
}

export async function synthesize(config,text,signal) {
  if(!config.ttsUrl)throw new Error('Set "ttsUrl" in agent-voice.json (see /voice status).');
  const headers={'Content-Type':'application/json'};if(config.ttsApiKey)headers.Authorization='Bearer '+config.ttsApiKey;
  const response=await fetch(config.ttsUrl,{method:'POST',headers,body:JSON.stringify({model:config.ttsModel,voice:config.voice,input:text,response_format:'wav'}),signal});
  if(!response.ok)throw new Error(`Speech service returned ${response.status}: ${(await response.text()).slice(0,200)}`);
  return Buffer.from(await response.arrayBuffer());
}
export function playFile(config,file,onChild,onPlaying=()=>{}){
  const command=process.platform==='darwin'?'afplay':config.ffplay;
  const args=process.platform==='darwin'?[file]:['-nodisp','-autoexit','-loglevel','error',file];
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{windowsHide:true,stdio:'ignore'});onChild(child);
    child.once('spawn',onPlaying);
    child.once('error',reject);child.once('exit',(code,signal)=>code===0||signal?resolve():reject(new Error(`Audio playback exited (${code}).`)));
  });
}
export class Speaker {
  constructor(config,onError=()=>{},options={}){this.config=config;this.onError=onError;this.synth=options.synth||synthesize;this.play=options.play||playFile;this.playAudio=options.playAudio;this.queue=[];this.controllers=new Set();this.epoch=0;this.playing=false;}
  // Start synthesis while the selected devices initialize. The ticket stays in
  // memory, shares normal cancellation, and is only queued once audio is ready.
  prefetch(text){
    const abort=new AbortController();this.controllers.add(abort);
    const promise=this.synth(this.config,text,abort.signal).finally(()=>this.controllers.delete(abort));promise.catch(()=>{});
    return {text,epoch:this.epoch,promise};
  }
  enqueue(text,{prepared,onPlaying}={}){if(!text.trim())return;this.queue.push({...prepared,text,epoch:prepared?.epoch??this.epoch,onPlaying});this.prepare();this.startPump();}
  startPump(){if(!this.running)this.running=this.pump().finally(()=>{this.running=null;if(this.prepared||this.queue.length)this.startPump();});}
  prepare(){if(this.prepared||!this.queue.length)return;const item=this.queue.shift();this.prepared=item.promise?item:{...this.prefetch(item.text),onPlaying:item.onPlaying};}
  async pump(){
    while(this.prepared){
      const item=this.prepared;
      try{
        const audio=await item.promise;
        if(item.epoch!==this.epoch)continue;
        this.prepared=null;this.prepare();
        if(this.playAudio){
          this.playing=true;
          try{await this.playAudio(this.config,audio,child=>this.player=child,()=>{if(item.epoch===this.epoch)item.onPlaying?.();});}
          finally{this.playing=false;this.player=null;}
        }else{
        this.directory??=await mkdtemp(path.join(tmpdir(),'agent-voice-'));
        const file=path.join(this.directory,`${Date.now()}-${Math.random().toString(16).slice(2)}.wav`);
        await writeFile(file,audio);
        try{if(item.epoch===this.epoch){this.playing=true;await this.play(this.config,file,child=>this.player=child,()=>{if(item.epoch===this.epoch)item.onPlaying?.();});}}
        finally{this.playing=false;this.player=null;await unlink(file).catch(()=>{});}
        }
      }catch(error){if(item.epoch===this.epoch && error.name!=='AbortError')this.onError(error);}
      finally{if(this.prepared===item)this.prepared=null;this.prepare();}
    }
  }
  stop(){this.epoch++;this.queue=[];this.prepared=null;for(const abort of this.controllers)abort.abort();this.player?.kill();this.playing=false;}
  async close(){this.stop();await this.running; if(this.directory)await rmdir(this.directory).catch(()=>{});}
}
