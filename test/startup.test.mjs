import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {VoiceEngine} from '../engine.mjs';
import {Speaker,defaults} from '../voice.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
  const calls=[],statuses=[],config={...defaults,asrUrl:'wss://example.invalid',ttsUrl:'https://example.invalid'};
  let readyAudio,failAudio,readySpeech,startPlayback;
  class Audio extends EventEmitter{
    start(){calls.push('audio-start');return new Promise((resolve,reject)=>{readyAudio=resolve;failAudio=reject;});}
    close(){failAudio?.(new Error('Audio startup cancelled'));}
  }
  class Input{
    constructor(_config,callbacks){this.callbacks=callbacks;this.frames=0;}
    push(){this.frames++;this.callbacks.start();this.callbacks.transcript('pineapple');}
    stop(){}
  }
  const host={submit:async text=>calls.push(['submitted',text]),abort:async()=>{},status:text=>statuses.push(text),error:()=>{}};
  const engine=new VoiceEngine(config,()=>{},{platform:'darwin',NativeAudio:Audio,Input});
  const speaker=engine.speaker=new Speaker(config,host.error,{
    synth:(_config,_text,signal)=>{calls.push('synthesis-start');return new Promise((resolve,reject)=>{readySpeech=()=>resolve(Buffer.from('wave'));signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true});});},
    playAudio:async(_config,_wave,onPlayer,onPlaying)=>{calls.push('playback-ready');await new Promise(resolve=>{onPlayer({kill:resolve});startPlayback=onPlaying;});},
  });
  return {engine,speaker,host,calls,statuses,readyAudio:()=>readyAudio(),readySpeech:()=>readySpeech(),startPlayback:()=>startPlayback()};
}
test('startup overlaps synthesis with device setup and ignores microphone frames until audio is ready',async()=>{
  const f=fixture();const startup=f.engine.start(f.host,{cue:'Listening.'});
  assert.deepEqual(f.calls,['synthesis-start','audio-start']);assert.equal(f.engine.phase,'warming-audio');
  f.engine.audio.emit('pcm',Buffer.alloc(640));assert.equal(f.engine.input.frames,0);
  f.readyAudio();await startup;assert.equal(f.engine.phase,'warming-speech');assert(!f.calls.includes('playback-ready'));
  f.readySpeech();await tick();assert(f.calls.includes('playback-ready'));assert.equal(f.engine.phase,'warming-speech');
  f.startPlayback();assert.equal(f.engine.phase,'listening');
  f.engine.audio.emit('pcm',Buffer.alloc(640));assert.equal(f.engine.input.frames,1);
  f.engine.off();await f.speaker.close();
});
test('stopping during warm-up cancels synthesis and cannot reopen audio or play a stale cue',async()=>{
  const f=fixture();const startup=f.engine.start(f.host,{cue:'Listening.'});
  f.engine.off();await assert.rejects(startup,/cancelled/i);await tick();
  assert.equal(f.engine.phase,'off');assert.equal(f.engine.enabled,false);assert(!f.calls.includes('playback-ready'));
  await f.speaker.close();
});
test('speaker diagnostic waits for confirmed playback before accepting speech and always turns the mic off',async()=>{
  const f=fixture();const check=f.engine.check(f.host);const input=f.engine.input;
  f.engine.audio.emit('pcm',Buffer.alloc(640));assert.equal(input.frames,0);
  f.readyAudio();await tick();f.engine.audio.emit('pcm',Buffer.alloc(640));assert.equal(input.frames,0);
  f.readySpeech();await tick();assert.equal(f.engine.phase,'warming-speech');
  f.startPlayback();assert.equal(f.engine.phase,'checking');
  f.engine.audio.emit('pcm',Buffer.alloc(640));assert.equal(input.frames,1);
  assert.deepEqual(await check,{ok:true});assert.equal(f.engine.enabled,false);assert(!f.calls.some(call=>Array.isArray(call)&&call[0]==='submitted'));
  await f.speaker.close();
});
