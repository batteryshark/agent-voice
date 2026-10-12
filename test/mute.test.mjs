import test from 'node:test';
import assert from 'node:assert/strict';
import {defaults,VoiceInput} from '../voice.mjs';
import {VoiceEngine} from '../engine.mjs';
import {OpenControlHub} from '../openchamber-control.mjs';

const host=(log=[])=>({log,submit:t=>log.push(['submit',t]),abort:()=>log.push(['abort']),isBusy:()=>false,status:t=>log.push(['status',t]),error:e=>log.push(['error',e.message])});

test('Mic mute drops audio without stopping replies; output mute silences replies without stopping the mic',()=>{
  const engine=new VoiceEngine(defaults),h=host(),spoken=[],pushed=[];let stops=0;
  const fake={enqueue:t=>spoken.push(t),stop(){stops++;},close:async()=>{}};
  engine.speaker=fake;engine.ensureSpeaker=()=>fake;
  engine.attach(h);engine.enabled=true;engine.readAloud=true;engine.acceptInput=true;
  engine.input={push:pcm=>pushed.push(pcm),discard(){pushed.push('discard');},stop(){}};
  engine.onPCM=pcm=>{if(engine.acceptInput&&!engine.micMuted)engine.input?.push(pcm);};
  engine.setMicMuted(true);
  engine.onPCM(Buffer.alloc(640));
  assert.deepEqual(pushed,['discard']);
  assert.equal(h.log.at(-1)[1],'Voice: microphone muted');
  engine.assistantStart();engine.assistantDelta('The agent keeps talking while your microphone is muted.');engine.assistantEnd(true);
  assert.deepEqual(spoken,['The agent keeps talking while your microphone is muted.']);
  engine.setMicMuted(false);engine.onPCM(Buffer.alloc(640));
  assert.equal(pushed.length,2);
  engine.setOutputMuted(true);assert(stops>0);
  engine.assistantStart();engine.assistantDelta('This reply should not be spoken because output is muted.');engine.assistantEnd(true);
  assert.equal(spoken.length,1);assert.equal(engine.enabled,true);
  assert.equal(h.log.at(-1)[1],'Voice: listening (agent voice muted)');
  engine.off();assert.equal(engine.micMuted,false);assert.equal(engine.outputMuted,false);
});

test('Discarding an utterance ignores its late errors and transcript',()=>{
  const calls=[];let rec;
  const input=new VoiceInput({...defaults,threshold:0},{start(){},transcript:t=>calls.push(['t',t]),idle:()=>calls.push(['idle']),error:e=>calls.push(['e',e.message])},
    (config,callbacks)=>rec={callbacks,start(){},write(){},end(){},cancel(){callbacks.error(new Error('closed early'));callbacks.done('late words');}});
  const loud=Buffer.alloc(640);for(let i=0;i<640;i+=2)loud.writeInt16LE(8000,i);
  for(let i=0;i<8;i++)input.push(loud);
  assert(rec);input.discard();
  assert.deepEqual(calls,[['idle']]);
});

test('Only the panel holding voice can mute it',async()=>{
  const calls=[],hub=new OpenControlHub();
  hub.add({directory:'/p',config:{},load:async()=>{},session:async id=>({id,location:{directory:'/p'}}),state:()=>({enabled:true}),pause(){},run:async(c,v,id)=>calls.push([c,v,id])});
  const input={directory:'/p',sessionID:'ses_one',clientID:'panel'};
  await assert.rejects(hub.request('POST','/command',{...input,command:'mic',value:'off'}),/another panel/);
  await hub.request('POST','/command',{...input,command:'on'});
  await hub.request('POST','/command',{...input,command:'mic',value:'off'});
  await hub.request('POST','/command',{...input,command:'speaker',value:'off'});
  await assert.rejects(hub.request('POST','/command',{...input,command:'mic',value:'loud'}),/Unknown/);
  await assert.rejects(hub.request('POST','/command',{...input,clientID:'other',command:'mic',value:'on'}),/another panel/);
  assert.deepEqual(calls.slice(1),[['mic','off','ses_one'],['speaker','off','ses_one']]);
});
