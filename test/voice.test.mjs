import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {defaults,captureArgs,windowsMicrophones,VoiceInput,Speaker} from '../voice.mjs';

test('Native capture selects audio-only Mac and Windows devices without a shell',()=>{
  assert(captureArgs(undefined,'darwin').includes(':default'));
  assert(captureArgs('USB microphone','win32').includes('audio=USB microphone'));
  assert.deepEqual(windowsMicrophones('[dshow] "USB microphone" (audio)\nAlternative name "@device"'),['USB microphone']);
});
test('PCM framing and pause detection submit one utterance with pre-roll',()=>{
  const voice=Buffer.alloc(640);for(let i=0;i<640;i+=2)voice.writeInt16LE(8000,i);
  const silent=Buffer.alloc(640),sent=[],transcripts=[];let end,started=0;
  const input=new VoiceInput({...defaults,pauseMs:200},{start:()=>started++,transcript:text=>transcripts.push(text),error:assert.fail},(_config,callbacks)=>({
    start(){},write(pcm){sent.push(pcm)},end(){end=()=>callbacks.done('Native voice works.')},cancel(){}
  }));
  const pcm=Buffer.concat([...Array(12).fill(voice),...Array(10).fill(silent)]);
  for(let i=0;i<pcm.length;i+=377)input.push(pcm.subarray(i,i+377));
  assert.equal(started,1);assert.equal(sent.length,22);assert.equal(input.waiting,true);end();
  assert.deepEqual(transcripts,['Native voice works.']);input.stop();input.push(pcm);assert.equal(started,1);
});
test('Speaker prefetches next sentence and interruption drops stale audio',async()=>{
  const synthesized=[],played=[];let finish;
  const speaker=new Speaker(defaults,assert.fail,{synth:async(_config,text)=>{synthesized.push(text);return Buffer.from('wave');},
    play:async(_config,file,onChild)=>{played.push(file);await new Promise(resolve=>{finish=resolve;onChild({kill:resolve});});}});
  speaker.enqueue('First sentence.');
  while(!finish)await delay(5);
  speaker.enqueue('Second sentence.');await delay(5);assert.deepEqual(synthesized,['First sentence.','Second sentence.']);
  speaker.stop();await speaker.running;assert.equal(played.length,1);await speaker.close();
});
