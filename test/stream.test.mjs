import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {defaults,Speaker,PcmStream,synthesizeStream} from '../voice.mjs';
import {PcmToFloat48} from '../native-audio.mjs';

const s16=samples=>{const b=Buffer.alloc(samples.length*2);samples.forEach((v,i)=>b.writeInt16LE(Math.round(v*32767),i*2));return b;};
const f32=buf=>Array.from(new Float32Array(buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.length)));
const body=chunks=>new ReadableStream({async pull(c){if(!chunks.length)return c.close();const next=chunks.shift();if(next instanceof Error)return c.error(next);c.enqueue(next);}});

test('24 kHz PCM upsamples to exactly twice the samples, keeps the input samples and interpolates a sine',()=>{
  const n=2400,x=Array.from({length:n},(_,i)=>0.5*Math.sin(2*Math.PI*1000*i/24000));
  const conv=new PcmToFloat48(24000),pcm=s16(x);
  // odd-sized chunks split samples across chunk boundaries
  const out=[];for(let i=0;i<pcm.length;i+=777)out.push(...f32(conv.push(pcm.subarray(i,i+777))));out.push(...f32(conv.flush()));
  assert.equal(out.length,2*n);
  for(let i=0;i<n;i+=97)assert.ok(Math.abs(out[2*i]-Math.round(x[i]*32767)/32768)<1e-6);
  let err=0;for(let m=200;m<2*n-200;m++)err=Math.max(err,Math.abs(out[m]-0.5*Math.sin(2*Math.PI*1000*m/48000)));
  assert.ok(err<2e-3,`max interpolation error ${err}`);
});
test('48 kHz PCM is converted without resampling; other rates are refused',()=>{
  assert.deepEqual(f32(new PcmToFloat48(48000).push(s16([0.5,-0.5]))).map(v=>Math.round(v*100)/100),[0.5,-0.5]);
  assert.throws(()=>new PcmToFloat48(22050),/Unsupported/);
});
test('PcmStream yields chunks as they arrive and rethrows a body failure',async()=>{
  const ok=new PcmStream(body([new Uint8Array([1,2]),new Uint8Array([3])]));
  const got=[];for await(const c of ok)got.push(...c);assert.deepEqual(got,[1,2,3]);
  const bad=new PcmStream(body([new Uint8Array([1]),new Error('terminated')]));
  await assert.rejects(async()=>{for await(const _ of bad);},/terminated/);
  await bad.finished;
});
test('synthesizeStream asks for pcm and refuses a WAV reply',async()=>{
  const fetch0=globalThis.fetch;let sent;
  try{
    globalThis.fetch=async(_url,init)=>{sent=JSON.parse(init.body);return new Response(new Uint8Array([0,0]),{headers:{'content-type':'audio/pcm','x-sample-rate':'24000'}});};
    const stream=await synthesizeStream({...defaults,ttsUrl:'http://tts',voice:'v',ttsModel:'m'},'Hi.');
    assert.equal(sent.response_format,'pcm');assert.equal(stream.sampleRate,24000);
    globalThis.fetch=async()=>new Response(new Uint8Array(44),{headers:{'content-type':'audio/wav'}});
    await assert.rejects(synthesizeStream({...defaults,ttsUrl:'http://tts'},'Hi.'),/ttsStream/);
  }finally{globalThis.fetch=fetch0;}
});
test('Streaming speaker plays streams in order and stop() aborts the body still being generated',async()=>{
  const played=[],signals=[];let release;
  const synthStream=async(_c,text,signal)=>{signals.push(signal);
    return new PcmStream(new ReadableStream({start(c){c.enqueue(new Uint8Array([text.length]));signal.addEventListener('abort',()=>c.error(new DOMException('aborted','AbortError')));if(!text.startsWith('Long'))c.close();}}));};
  const speaker=new Speaker({...defaults,ttsStream:true},assert.fail,{synthStream,synth:assert.fail,
    playStream:async(_c,stream,onPlayer,onPlaying)=>{onPlaying();const chunks=[];onPlayer({kill:()=>release?.()});for await(const c of stream)chunks.push(...c);played.push(chunks);}});
  speaker.enqueue('One.');speaker.enqueue('Two!');
  while(played.length<2)await delay(5);
  assert.deepEqual(played,[[4],[4]]);
  assert.equal(speaker.controllers.size,0,'finished streams release their abort controllers');
  speaker.enqueue('Long reply still generating.');await delay(20);
  assert.equal(speaker.controllers.size,1,'an open stream stays cancellable');
  speaker.stop();await speaker.running;
  assert.ok(signals.at(-1).aborted);assert.equal(played.length,2);await speaker.close();
});
test('Without ttsStream (or on hosts without streaming playback) the WAV path is unchanged',async()=>{
  const speaker=new Speaker({...defaults,ttsStream:true},assert.fail,{synth:async()=>Buffer.from('wave'),synthStream:assert.fail,
    play:async()=>{}});
  assert.equal(speaker.streaming,false);speaker.enqueue('Hi.');await delay(20);await speaker.close();
});
