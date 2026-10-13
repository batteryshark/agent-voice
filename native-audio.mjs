import {EventEmitter} from 'node:events';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {stat,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';
import path from 'node:path';
const run=promisify(execFile);
const root=fileURLToPath(new URL('./',import.meta.url));
// Build against a fixed minimum macOS so APIs deprecated in newer SDKs stay usable (and quiet)
// on every supported release.
export const SWIFT_TARGET=`${process.arch==='x64'?'x86_64':'arm64'}-apple-macos13`;
export async function helperPath(){
 const source=path.join(root,'native/audio.swift'),binary=path.join(root,'bin/audio-macos');
 let binaryTime=0;try{binaryTime=(await stat(binary)).mtimeMs;}catch{}
 if(binaryTime<(await stat(source)).mtimeMs){
  await mkdir(path.dirname(binary),{recursive:true});
  try{await run('/usr/bin/xcrun',['swiftc',source,'-o',binary,'-target',SWIFT_TARGET,'-framework','AVFoundation','-framework','CoreAudio','-module-cache-path',path.join(process.env.TMPDIR||'/tmp','agent-voice-swift-cache')],{timeout:60000,maxBuffer:1024*1024});}
  catch{throw new Error('Could not build native audio. Install Xcode Command Line Tools, then reload voice.');}
 }
 return binary;
}
// echoCancellation: "auto" | "on" | "off" (booleans accepted). Unknown values fall back to auto.
export const echoSetting=value=>value===true||value==='on'?'on':value===false||value==='off'?'off':'auto';
// Auto turns Apple's voice processing off for headphones, where there is no speaker-to-mic echo path and the call-style
// processing only muffles playback: Bluetooth / Bluetooth LE transports, or built-in output on its headphones data source.
export function headphoneOutput(device){
 if(['blue','blea'].includes(device?.transport))return 'Bluetooth output';
 if(device?.transport==='bltn'&&device?.dataSource==='hdpn')return 'headphones';
 return null;
}
export function selectedOutput(list,id='default'){
 return Array.isArray(list)?list.find(device=>device.output&&(!id||id==='default'?device.defaultOutput:device.id===id||device.name===id)):undefined;
}
/** {setting, effective, reason}: effective is whether voice processing runs for capture on that output. */
export function resolveEcho(value,list,outputId){
 const setting=echoSetting(value);
 if(setting!=='auto')return {setting,effective:setting==='on',reason:'setting'};
 const headphones=headphoneOutput(selectedOutput(list,outputId));
 return {setting,effective:!headphones,reason:headphones||'speakers'};
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

// The helper plays 48 kHz mono float32. Streamed speech is usually 24 kHz s16le (OpenAI's pcm format), so it is
// upsampled 2x with a 63-tap Blackman-windowed half-band filter: even outputs are the input samples, odd outputs
// interpolate from 32 neighbours. 16 input samples (0.7 ms) of delay; state carries across chunks.
const HALF=16,TAPS=(()=>{const c=[];for(let j=-HALF;j<HALF;j++){const k=2*j+1,x=k/2,m=2*HALF;
  c.push(Math.sin(Math.PI*x)/(Math.PI*x)*(0.42+0.5*Math.cos(Math.PI*k/m)+0.08*Math.cos(2*Math.PI*k/m)));}
  const sum=c.reduce((a,b)=>a+b,0);return Float64Array.from(c,v=>v/sum);})();
export class PcmToFloat48 {
  constructor(sampleRate){
    if(sampleRate!==24000&&sampleRate!==48000)throw new Error(`Unsupported speech sample rate ${sampleRate}`);
    this.double=sampleRate===24000;this.carry=null;this.history=new Float32Array(2*HALF-1);this.skip=HALF;
  }
  samples(chunk){
    if(this.carry){chunk=Buffer.concat([this.carry,chunk]);this.carry=null;}
    if(chunk.length%2){this.carry=chunk.subarray(chunk.length-1);chunk=chunk.subarray(0,chunk.length-1);}
    const x=new Float32Array(chunk.length/2);for(let i=0;i<x.length;i++)x[i]=chunk.readInt16LE(i*2)/32768;return x;
  }
  upsample(x){
    const h=this.history.length,ext=new Float32Array(h+x.length);ext.set(this.history);ext.set(x,h);
    const out=new Float32Array(2*x.length);let n=0;
    for(let t=h;t<ext.length;t++){
      if(this.skip>0){this.skip--;continue;}
      const p=t-HALF;let odd=0;for(let j=-HALF;j<HALF;j++)odd+=TAPS[j+HALF]*ext[p-j];
      out[n++]=ext[p];out[n++]=odd;
    }
    this.history=ext.slice(ext.length-h);
    return Buffer.from(out.buffer,0,n*4);
  }
  push(chunk){const x=this.samples(chunk);return this.double?this.upsample(x):Buffer.from(x.buffer);}
  flush(){return this.double?this.upsample(new Float32Array(HALF)):Buffer.alloc(0);}  // emits the delayed tail
}

export class MacAudio extends EventEmitter {
 constructor(config){super();this.config=config;this.next=0;this.acks=new Map();this.capture=false;this.epoch=0;}
 async start(capture){
  if(this.child&&(this.capture||!capture))return this.ready;
  this.close();this.capture=capture;const epoch=this.epoch;
  const binary=await helperPath();
  if(this.epoch!==epoch)throw new Error('Audio startup cancelled');
  // Decided each time capture starts, so a device change re-evaluates auto.
  if(capture){
   const setting=echoSetting(this.config.echoCancellation),list=setting==='auto'?await audioDevices().catch(()=>null):null;
   this.echo=resolveEcho(setting,list,this.config.outputDevice);
   if(this.epoch!==epoch)throw new Error('Audio startup cancelled');
  }
  const args=['--input',this.config.inputDevice||this.config.device||'default','--output',this.config.outputDevice||'default',
   ...(capture?['--capture','--echo-cancellation',this.echo.effective?'on':'off']:[])];
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
     if(capture&&this.echo.effective&&event.echoCancellation!==true)return failure(new Error('Echo cancellation is unavailable'));
     // A helper built before this setting ignores the flag and always runs voice processing.
     if(capture&&!this.echo.effective&&event.echoCancellation===true)this.echo={...this.echo,effective:true,reason:'the native helper predates this setting; rebuild bin/audio-macos'};
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
 // Schedule streamed PCM chunk by chunk: the native player queues buffers back to back, so playback starts with
 // the first chunk and continues while the rest is still being generated.
 async playStream(config,stream,onPlayer,onPlaying=()=>{}){
  const controller=new AbortController();onPlayer({kill:()=>{controller.abort();this.stopPlayback();}});
  await this.start(false);
  if(controller.signal.aborted)return;
  const convert=new PcmToFloat48(stream.sampleRate),pending=[],ids=[];let seconds=0,first=true;const t0=Date.now();
  const send=pcm=>{
   if(!pcm.length||controller.signal.aborted)return;
   const id=++this.next;ids.push(id);seconds+=pcm.length/4/48000;
   pending.push(new Promise(resolve=>this.acks.set(id,{onPlaying:first?onPlaying:null,resolve})));first=false;
   this.command({type:'play',id,data:pcm.toString('base64')});
  };
  for await(const chunk of stream){if(controller.signal.aborted)return;send(convert.push(chunk));}
  if(controller.signal.aborted)return;
  send(convert.flush());
  await new Promise((resolve,reject)=>{
   const timeout=setTimeout(()=>{for(const id of ids)this.acks.delete(id);reject(new Error('Selected output device stopped playing'));},Math.max(0,seconds*1000-(Date.now()-t0))+5000);
   Promise.all(pending).then(()=>{clearTimeout(timeout);resolve();});
  });
 }
 stopPlayback(){this.command({type:'stop'});for(const ack of this.acks.values())ack.resolve();this.acks.clear();}
 close(){this.epoch++;this.rejectReady?.(new Error('Audio startup cancelled'));this.rejectReady=null;this.stopPlayback();const child=this.child;this.child=null;this.ready=null;child?.stdin.end();child?.kill();this.capture=false;}
}
