import test from 'node:test';
import assert from 'node:assert/strict';
import {voiceStatus} from '../openchamber/panel/status.ts';
const off={enabled:false,sessionID:null,phase:'off',status:'Microphone off'};
test('Voice panel shows immediate warm-up and advances to speech preparation before prompting the challenge',()=>{
  assert.match(voiceStatus(off,'chat',true).text,/Warming up/);
  const state={...off,enabled:true,sessionID:'chat',checking:true};
  assert.match(voiceStatus({...state,phase:'warming-audio'},'chat').text,/Connecting/);
  assert.match(voiceStatus({...state,phase:'warming-speech'},'chat').text,/Wait until you hear/);
  const playing=voiceStatus({...state,phase:'checking'},'chat');assert.equal(playing.warming,false);assert.match(playing.text,/Test playing/);
  assert.equal(voiceStatus(off,'chat').text,'Microphone off');
});
