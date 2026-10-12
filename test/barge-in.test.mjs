import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import plugin from '../server.js';
import piExtension from '../index.ts';
import {VoiceEngine,shared} from '../engine.mjs';
import {defaults,VoiceInput} from '../voice.mjs';
class Capture extends EventEmitter{start(){}stop(){}}
class Input{constructor(config,callbacks){this.callbacks=callbacks;}stop(){}push(){}discard(){}}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const config={...defaults,asrUrl:'wss://example.invalid',ttsUrl:'https://example.invalid',duplex:true};
// Engine with a fake clock, stub capture/recognition and a fake speaker that never plays audio.
function fixture(overrides={}){
 let now=10000;const calls=[];
 const host={submit:async text=>calls.push(['submit',text]),abort:async()=>calls.push(['abort']),isBusy:()=>true,status(){},error:e=>calls.push(['error',e.message])};
 const engine=new VoiceEngine({...config,...overrides},()=>{},{platform:'linux',Capture,Input,now:()=>now});
 engine.speaker={playing:false,stop:()=>calls.push(['stop']),prefetch:text=>({text}),enqueue:text=>calls.push(['speak',text]),close:async()=>{}};engine.ensureSpeaker=()=>engine.speaker;
 // halt() on (re)start also stops the speaker; stops() counts only those since the last mark().
 let base=0;const stops=()=>calls.filter(c=>c[0]==='stop').length-base,mark=()=>base=calls.filter(c=>c[0]==='stop').length;
 return {engine,host,calls,stops,mark,advance:ms=>now+=ms,input:()=>engine.input.callbacks};
}
test('speech onset while the agent works silently never aborts the turn',async()=>{
 const f=fixture();await f.engine.start(f.host);f.advance(2000);
 f.input().start();f.input().speaking();f.input().transcript('Also check the tests');await tick();
 assert(!f.calls.some(c=>c[0]==='abort'));assert.deepEqual(f.calls.at(-1),['submit','Also check the tests']);f.engine.halt();
});
test('sustained speech or a first partial stops playback and silences the rest of that reply',async()=>{
 const f=fixture();await f.engine.start(f.host);f.engine.readAloud=true;f.advance(2000);f.mark();
 f.engine.assistantStart();f.engine.assistantDelta('The first sentence of this reply is spoken aloud. ');
 assert.equal(f.calls.filter(c=>c[0]==='speak').length,1);
 f.input().start();assert.equal(f.stops(),0,'onset alone is only a candidate');
 f.input().partial('');assert.equal(f.stops(),0,'an empty partial is not speech');
 f.input().partial('wait');assert.equal(f.stops(),1);
 f.input().speaking();assert.equal(f.stops(),1,'one barge-in per utterance');
 f.engine.assistantDelta('This later sentence belongs to the interrupted reply. ');f.engine.userMessage();
 f.engine.assistantDelta('Still the interrupted reply after the steer lands. ');f.engine.assistantEnd(true);
 assert.equal(f.calls.filter(c=>c[0]==='speak').length,1);
 f.engine.assistantStart();f.engine.assistantDelta('The steered reply is spoken again from its start. ');
 assert.equal(f.calls.filter(c=>c[0]==='speak').length,2);assert(!f.calls.some(c=>c[0]==='abort'));f.engine.halt();
});
test('onset right after capture (re)starts is ignored, including after changing devices',async()=>{
 const f=fixture();f.engine.save=()=>{};await f.engine.start(f.host);f.mark();
 f.input().start();f.input().speaking();assert.equal(f.stops(),0);
 f.input().idle();f.advance(1300);f.input().start();f.input().speaking();assert.equal(f.stops(),1);
 await f.engine.configureDevices({inputDevice:'other-mic'});f.mark();
 f.advance(500);f.input().start();f.input().speaking();f.input().partial('noise');assert.equal(f.stops(),0);
 f.input().idle();f.advance(800);f.input().start();f.input().speaking();assert.equal(f.stops(),1);assert(!f.calls.some(c=>c[0]==='abort'));f.engine.halt();
});
test('onsetGraceMs and bargeInAborts are configurable',async()=>{
 const f=fixture({onsetGraceMs:0,bargeInAborts:true});await f.engine.start(f.host);
 f.input().start();f.input().speaking();await tick();assert.deepEqual(f.calls.slice(-2),[['stop'],['abort']]);f.engine.halt();
});
test('VoiceInput reports sustained speech after bargeInMs of voiced frames',()=>{
 const loud=Buffer.alloc(640);for(let i=0;i<640;i+=2)loud.writeInt16LE(8000,i);
 const events=[],input=new VoiceInput({...defaults,bargeInMs:300},{start:()=>events.push('start'),speaking:()=>events.push('speaking'),transcript(){},error:assert.fail},
  ()=>({start(){},write(){},end(){},cancel(){}}));
 for(let i=0;i<14;i++)input.push(loud);assert.deepEqual(events,['start']);
 input.push(loud);assert.deepEqual(events,['start','speaking']);
 for(let i=0;i<20;i++)input.push(loud);assert.deepEqual(events,['start','speaking']);input.stop();
});

function opencodeContext(){
 const calls=[],queue=[];let wake,command;
 const ctx={
  command:{transform:async fn=>{fn({add:definition=>command=definition});return {dispose:async()=>{}};}},
  session:{synthetic:async input=>calls.push(['synthetic',input.text]),prompt:async input=>calls.push(['prompt',input]),interrupt:async input=>calls.push(['interrupt',input.sessionID])},
  event:{subscribe:({signal}={})=>({async *[Symbol.asyncIterator](){
   while(!signal?.aborted){if(queue.length)yield queue.shift();else await new Promise(resolve=>{wake=resolve;signal?.addEventListener('abort',resolve,{once:true});});}
  }})},
 };
 return {ctx,calls,command:()=>command,emit:event=>{queue.push(event);wake?.();}};
}
test('opencode: a transcript during a busy turn steers it; only explicit stop interrupts',async()=>{
 const fake=opencodeContext(),cleanup=await plugin.setup(fake.ctx),voice=fake.command(),f=fixture();
 shared().engine=f.engine;
 await voice.execute({sessionID:'s1',prompt:{text:'on'}});f.advance(2000);
 fake.emit({type:'session.execution.started',data:{sessionID:'s1'}});await delay(5);
 f.input().start();f.input().speaking();f.input().transcript('Use the other folder instead');await delay(5);
 assert(!fake.calls.some(c=>c[0]==='interrupt'));
 assert.deepEqual(fake.calls.at(-1),['prompt',{sessionID:'s1',text:'Use the other folder instead',delivery:'steer'}]);
 await voice.execute({sessionID:'s1',prompt:{text:'stop'}});assert.deepEqual(fake.calls.at(-1),['interrupt','s1']);
 await cleanup();assert.equal(shared().engine,null);
});
test('Pi: a transcript during a busy turn is sent as a steer; Ctrl+Alt+X and /voice stop abort',async()=>{
 const commands={},shortcuts={},sent=[];let aborts=0;
 piExtension({registerCommand:(name,options)=>commands[name]=options,registerShortcut:(key,options)=>shortcuts[key]=options,on(){},sendUserMessage:(text,options)=>sent.push([text,options])});
 const context={hasUI:true,mode:'tui',isIdle:()=>false,abort:()=>aborts++,ui:{setStatus(){},notify(){}},sessionManager:{getSessionFile:()=>'s',getSessionId:()=>'s'}};
 const f=fixture();shared().engine=f.engine;
 await commands.voice.handler('on',context);f.advance(2000);
 f.input().start();f.input().speaking();f.input().transcript('Skip the docs for now');await tick();
 assert.equal(aborts,0);assert.deepEqual(sent,[['Skip the docs for now',{deliverAs:'steer',expandPromptTemplates:false}]]);
 shortcuts['ctrl+alt+x'].handler(context);assert.equal(aborts,1);
 await commands.voice.handler('stop',context);assert.equal(aborts,2);
 await f.engine.close();shared().engine=null;
});
