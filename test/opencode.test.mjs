import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import plugin from '../server.js';
import {shared,VoiceEngine} from '../engine.mjs';
import {defaults} from '../voice.mjs';

function fakeContext(){
  const calls=[],queue=[];let wake,command;
  const ctx={
    command:{transform:async fn=>{fn({add:definition=>command=definition});return {dispose:async()=>{}};}},
    session:{
      synthetic:async input=>calls.push(['synthetic',input.text]),
      prompt:async input=>calls.push(['prompt',input]),
      interrupt:async input=>calls.push(['interrupt',input.sessionID]),
    },
    event:{subscribe:({signal}={})=>({async *[Symbol.asyncIterator](){
      while(!signal?.aborted){if(queue.length)yield queue.shift();else await new Promise(resolve=>{wake=resolve;signal?.addEventListener('abort',resolve,{once:true});});}
    }})},
  };
  return {ctx,calls,command:()=>command,emit:event=>{queue.push(event);wake?.();}};
}

test('opencode plugin registers /voice and routes the session event stream to the engine',async()=>{
  assert.equal(plugin.id,'agent-voice');
  const fake=fakeContext(),cleanup=await plugin.setup(fake.ctx);
  const voice=fake.command();assert.equal(voice.name,'voice');

  await voice.execute({sessionID:'s1',prompt:{text:'status'},delivery:'steer'});
  assert.match(fake.calls.at(-1)[1],/^\[voice\] Voice: off;/);

  // Fake speaker so the test never calls the speech service or plays audio.
  const spoken=[],engine=shared().engine=new VoiceEngine(defaults);
  engine.speaker={enqueue:t=>spoken.push(t),stop(){},close:async()=>{},playing:false};
  await voice.execute({sessionID:'s1',prompt:{text:'read on'},delivery:'steer'});
  assert.deepEqual(spoken,['Reading replies aloud.']);spoken.length=0;

  const text='Here is the answer you asked for, spoken aloud.';
  fake.emit({type:'session.execution.started',data:{sessionID:'s1'}});
  fake.emit({type:'session.text.started',data:{sessionID:'s1'}});
  fake.emit({type:'session.text.delta',data:{sessionID:'s1',delta:text.slice(0,20)}});
  fake.emit({type:'session.text.delta',data:{sessionID:'other',delta:'Ignored text from a different session entirely.'}});
  fake.emit({type:'session.text.delta',data:{sessionID:'s1',delta:text.slice(20)}});
  fake.emit({type:'session.text.ended',data:{sessionID:'s1',text}});
  await delay(10);
  assert.deepEqual(spoken,[text]);

  // A finished utterance while the agent is busy steers into the running turn.
  engine.host.submit('Wait, use the other folder.');
  assert.deepEqual(fake.calls.at(-1),['prompt',{sessionID:'s1',text:'Wait, use the other folder.',delivery:'steer'}]);
  fake.emit({type:'session.execution.succeeded',data:{sessionID:'s1'}});await delay(5);
  engine.host.submit('Thanks.');
  assert.equal(fake.calls.at(-1)[1].delivery,undefined);

  await voice.execute({sessionID:'s1',prompt:{text:'stop'},delivery:'steer'});
  assert.deepEqual(fake.calls.at(-1),['interrupt','s1']);
  await cleanup();
  assert.equal(shared().engine,null);
});
