import {EventEmitter} from 'node:events';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {stat,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';
import path from 'node:path';
const run=promisify(execFile);
const root=fileURLToPath(new URL('./',import.meta.url));
export async function helperPath(){
 const source=path.join(root,'native/audio.swift'),binary=path.join(root,'bin/audio-macos');
 let binaryTime=0;try{binaryTime=(await stat(binary)).mtimeMs;}catch{}
 if(binaryTime<(await stat(source)).mtimeMs){
  await mkdir(path.dirname(binary),{recursive:true});
  try{await run('/usr/bin/xcrun',['swiftc',source,'-o',binary,'-framework','AVFoundation','-framework','CoreAudio','-module-cache-path',path.join(process.env.TMPDIR||'/tmp','agent-voice-swift-cache')],{timeout:60000,maxBuffer:1024*1024});}
  catch{throw new Error('Could not build native audio. Install Xcode Command Line Tools, then reload voice.');}
 }
 return binary;
}
export async function audioDevices(){const binary=await helperPath();const {stdout}=await run(binary,['--devices'],{timeout:5000,maxBuffer:1024*1024});return JSON.parse(stdout);}

export function decodeWave(config,wave,signal){return new Promise((resolve,reject)=>{
 const child=spawn(config.ffmpeg,['-hide_banner','-loglevel','error','-i','pipe:0','-f','f32le','-ar','48000','-ac','1','pipe:1'],{stdio:['pipe','pipe','pipe']});
 const buffers=[];let count=0,done=false;
 const timer=setTimeout(()=>finish(new Error('Speech conversion timed out')),30000);
 function finish(error,value){if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(error)child.kill();error?reject(error):resolve(value);}
 const abort=()=>finish(new Error('Speech cancelled'));
 if(signal?.aborted){abort();return;}signal?.addEventListener('abort',abort,{once:true});
 child.stderr.resume();child.on('error',finish);child.stdin.on('error',finish);
 child.stdout.on('data',chunk=>{count+=chunk.length;if(count>32*1024*1024)return finish(new Error('Speech audio exceeds limit'));buffers.push(chunk);});
 child.on('close',code=>code===0?finish(null,Buffer.concat(buffers)):finish(new Error('Speech audio conversion failed')));
 child.stdin.end(wave);
});}

export class MacAudio extends EventEmitter {
 constructor(config){super();this.config=config;this.next=0;this.acks=new Map();this.capture=false;this.epoch=0;}
 async start(capture){
  if(this.child&&(this.capture||!capture))return this.ready;
  this.close();this.capture=capture;const epoch=this.epoch;
  const binary=await helperPath();
  if(this.epoch!==epoch)throw new Error('Audio startup cancelled');
  const args=['--input',this.config.inputDevice||this.config.device||'default','--output',this.config.outputDevice||'default',...(capture?['--capture']:[])];
  const child=this.child=spawn(binary,args,{stdio:['pipe','pipe','pipe']});
  child.stderr.resume();child.stdin.on('error',()=>{});
  const lines=createInterface({input:child.stdout});
  this.ready=new Promise((resolve,reject)=>{
   let settled=false;
   this.rejectReady=error=>{if(!settled){settled=true;clearTimeout(timer);reject(error);}};
   const timer=setTimeout(()=>failure(new Error('Native audio startup timed out')),15000);
   const failure=error=>{if(child!==this.child)return;clearTimeout(timer);if(!settled){settled=true;reject(error);}else this.emit('failure',error);this.rejectReady=null;this.close();};
   child.on('error',failure);child.on('exit',code=>{if(child===this.child)failure(new Error('Native audio stopped ('+code+')'));});
   lines.on('line',line=>{
    if(child!==this.child)return;
    let event;try{event=JSON.parse(line);}catch{return failure(new Error('Native audio protocol failed'));}
    if(event.type==='ready'){
     if(capture&&event.echoCancellation!==true)return failure(new Error('Echo cancellation is unavailable'));
     clearTimeout(timer);settled=true;this.rejectReady=null;this.format=event;resolve(event);
    }
    if(event.type==='error')failure(new Error(event.message));
    if(event.type==='pcm'&&this.capture)this.emit('pcm',Buffer.from(event.data,'base64'));
    if(event.type==='playing'){const ack=this.acks.get(event.id);ack?.onPlaying?.();if(ack)ack.onPlaying=null;}
    if(event.type==='played'){this.acks.get(event.id)?.resolve();this.acks.delete(event.id);}
   });
  });
  return this.ready;
 }
 command(event){if(this.child&&!this.child.killed)this.child.stdin.write(JSON.stringify(event)+'\n');}
 async play(config,wave,onPlayer,onPlaying=()=>{}){
  const controller=new AbortController();onPlayer({kill:()=>{controller.abort();this.stopPlayback();}});
  await this.start(false);
  if(controller.signal.aborted)return;
  const pcm=await decodeWave(config,wave,controller.signal);
  if(controller.signal.aborted)return;
  const id=++this.next;
  await new Promise((resolve,reject)=>{
   const timeout=setTimeout(()=>{this.acks.delete(id);reject(new Error('Selected output device stopped playing'));},Math.ceil(pcm.length/4/48000*1000)+5000);
   this.acks.set(id,{onPlaying,resolve:()=>{clearTimeout(timeout);resolve();}});this.command({type:'play',id,data:pcm.toString('base64')});
  });
 }
 stopPlayback(){this.command({type:'stop'});for(const ack of this.acks.values())ack.resolve();this.acks.clear();}
 close(){this.epoch++;this.rejectReady?.(new Error('Audio startup cancelled'));this.rejectReady=null;this.stopPlayback();const child=this.child;this.child=null;this.ready=null;child?.stdin.end();child?.kill();this.capture=false;}
}
