import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {VoiceEngine} from '../engine.mjs';
import {defaults} from '../voice.mjs';
class Capture extends EventEmitter{start(){}stop(){}}
class Input {constructor(config,callbacks){this.callbacks=callbacks;}stop(){}push(){}}
function fixture(){
 const calls=[],host={submit:async text=>calls.push(['submit',text]),abort:()=>new Promise(resolve=>host.finishAbort=resolve),isBusy:()=>true,status(){},error:e=>calls.push(['error',e.message])};
 const engine=new VoiceEngine({...defaults,asrUrl:'wss://example.invalid',ttsUrl:'https://example.invalid',duplex:true},()=>{},{platform:'linux',Capture,Input});
 engine.speaker={playing:true,stop:()=>calls.push(['stop']),prefetch:text=>({text}),enqueue:(text,options)=>{calls.push(['speak',text]);options?.onPlaying?.();},close:async()=>{}};engine.ensureSpeaker=()=>engine.speaker;
 return {engine,host,calls};
}
test('new utterance waits for confirmed agent interruption',async()=>{
 const f=fixture();await f.engine.start(f.host);f.engine.input.callbacks.start();assert.equal(f.calls.at(-1)[0],'stop');f.engine.input.callbacks.transcript('Replace the instruction');
 await new Promise(resolve=>setImmediate(resolve));assert(!f.calls.some(c=>c[0]==='submit'));
 f.host.finishAbort();await new Promise(resolve=>setImmediate(resolve));assert(f.calls.some(c=>c[0]==='submit'));f.engine.halt();
});
test('spoken interruption cancels native work even if the busy notification is late',async()=>{
 const f=fixture();f.host.isBusy=()=>false;await f.engine.start(f.host);
 f.engine.input.callbacks.start();f.engine.input.callbacks.transcript('Use the new instruction');
 await new Promise(resolve=>setImmediate(resolve));assert.equal(typeof f.host.finishAbort,'function');assert(!f.calls.some(c=>c[0]==='submit'));
 f.host.finishAbort();await new Promise(resolve=>setImmediate(resolve));assert(f.calls.some(c=>c[0]==='submit'));f.engine.halt();
});
test('late reply deltas cannot restart speech after talking interrupts it',async()=>{
 const f=fixture();await f.engine.start(f.host);f.engine.input.callbacks.start();
 f.engine.assistantDelta('This is a late sentence from the cancelled reply.');f.engine.assistantEnd();
 assert(!f.calls.some(c=>c[0]==='speak'));await Promise.resolve();f.host.finishAbort();f.engine.halt();
});

test('failed cancellation does not submit a spoken instruction',async()=>{
 const f=fixture();f.host.abort=async()=>{throw new Error('cannot cancel');};await f.engine.start(f.host);
 f.engine.input.callbacks.start();f.engine.input.callbacks.transcript('Unsafe to send');
 await new Promise(resolve=>setImmediate(resolve));assert(!f.calls.some(c=>c[0]==='submit'));assert(f.calls.some(c=>c[0]==='error'));f.engine.halt();
});
test('changing devices saves the choices and restarts capture without duplicate listeners',async()=>{
 const f=fixture(),saved=[];f.engine.save=patch=>saved.push(patch);await f.engine.start(f.host);
 await f.engine.configureDevices({inputDevice:'mic',outputDevice:'speaker'});
 assert.equal(f.engine.capture.listenerCount('pcm'),1);assert.deepEqual(saved,[{inputDevice:'mic',outputDevice:'speaker'}]);f.engine.halt();
});
test('speaker check keeps the mic live, never submits to the agent, and restores duplex preference',async()=>{
 const f=fixture();f.engine.config.duplex=false;
 const check=f.engine.check(f.host);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.engine.input.callbacks.muted(),false);
 f.engine.input.callbacks.start();f.engine.input.callbacks.transcript('pineapple');
 assert.deepEqual(await check,{ok:true});
 assert(!f.calls.some(c=>c[0]==='submit'));assert.equal(f.engine.config.duplex,false);assert.equal(f.engine.enabled,false);
});
test('stopping the diagnostic ends it immediately and leaves the microphone off',async()=>{
 const f=fixture();const check=f.engine.check(f.host);await new Promise(resolve=>setImmediate(resolve));
 f.engine.off();assert.deepEqual(await check,{ok:false,reason:'Voice check was stopped.'});assert.equal(f.engine.enabled,false);
});
test('audio-route failure reaches the diagnostic result instead of being reported as a manual stop',async()=>{
 const f=fixture();const check=f.engine.check(f.host);await new Promise(resolve=>setImmediate(resolve));
 f.engine.capture.emit('failure',new Error('Audio engine stopped after Bluetooth format change'));
 assert.deepEqual(await check,{ok:false,reason:'Audio engine stopped after Bluetooth format change'});assert.equal(f.engine.enabled,false);
});
test('changing devices cancels a speaker check without restarting its temporary microphone',async()=>{
 const f=fixture();const check=f.engine.check(f.host);await new Promise(resolve=>setImmediate(resolve));
 await f.engine.configureDevices({inputDevice:'new-microphone'});
 assert.equal(f.engine.enabled,false);assert.equal(f.engine.readAloud,false);
 assert.match((await check).reason,/devices changed/);
});
