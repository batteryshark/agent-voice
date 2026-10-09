import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {defaults,resolveBinary} from '../voice.mjs';
import {SpeechSegments} from '../speech.mjs';
import {VoiceEngine,loadConfig,shared} from '../engine.mjs';

const host=(log=[])=>({log,submit:t=>log.push(['submit',t]),abort:()=>log.push(['abort']),isBusy:()=>false,status:t=>log.push(['status',t]),error:e=>log.push(['error',e.message])});

test('Binaries resolve from Homebrew when a GUI host has a bare PATH',()=>{
  const found=resolveBinary('ffmpeg',{PATH:'/usr/bin:/bin'},'darwin');
  assert(found==='ffmpeg'||path.isAbsolute(found));
  assert.equal(resolveBinary('/custom/ffmpeg',{PATH:''},'darwin'),'/custom/ffmpeg');
});
test('Config saves only user-set keys',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'voice-config-')),file=path.join(dir,'v.json');
  writeFileSync(file,'﻿{"pauseMs":900}');
  const {config,save}=loadConfig([path.join(dir,'missing.json'),file]);
  assert.equal(config.pauseMs,900);assert.equal(config.asrUrl,defaults.asrUrl);
  save({duplex:true});assert.equal(config.duplex,true);
  assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),{pauseMs:900,duplex:true});
});
test('Full-text updates speak each sentence once',()=>{
  const out=[],speech=new SpeechSegments(t=>out.push(t));
  speech.update('This first sentence is long enough to be spoken.');
  speech.update('This first sentence is long enough to be spoken. And a second');
  speech.update('This first sentence is long enough to be spoken. And a second one finishes here.');
  speech.flush(true);
  assert.deepEqual(out,['This first sentence is long enough to be spoken.','And a second one finishes here.']);
});
test('Engine read-aloud follows ownership and moves between sessions',()=>{
  const engine=new VoiceEngine(defaults),a=host(),b=host(),spoken=[];
  engine.ensureSpeaker=()=>({enqueue:t=>spoken.push(t),stop(){},close:async()=>{}});
  engine.setReadAloud(a,true);assert(engine.owns(a));
  engine.assistantStart();engine.assistantDelta('Reading this reply aloud for the first session.');engine.assistantEnd(true);
  assert.deepEqual(spoken,['Reading this reply aloud for the first session.']);
  engine.setReadAloud(b,true);assert(engine.owns(b));assert.equal(engine.readAloud,true);
  assert.deepEqual(a.log.at(-1),['status','Voice: moved to another session']);
  engine.detach(b);assert.equal(engine.host,null);
});
test('Shared state is one per process',()=>{assert.equal(shared(),shared());});
