import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {echoSetting,headphoneOutput,resolveEcho,selectedOutput} from '../native-audio.mjs';
import {VoiceEngine,echoText,loadConfig} from '../engine.mjs';
import {defaults} from '../voice.mjs';
import {OpenControlHub} from '../openchamber-control.mjs';
// Shaped like `audio-macos --devices`: CoreAudio transport and output data source as four-character codes.
const devices=[
 {id:'BuiltInMicrophoneDevice',name:'MacBook Pro Microphone',input:true,output:false,transport:'bltn',dataSource:''},
 {id:'BuiltInSpeakerDevice',name:'MacBook Pro Speakers',input:false,output:true,transport:'bltn',dataSource:'ispk',defaultOutput:true},
 {id:'88-C9:output',name:'WH-1000XM5',input:false,output:true,transport:'blue',dataSource:''},
 {id:'le-buds',name:'LE Buds',input:false,output:true,transport:'blea',dataSource:''},
 {id:'display',name:'MPG 491C OLED',input:false,output:true,transport:'dprt',dataSource:''},
 {id:'usb-speakers',name:'Desk Speakers',input:false,output:true,transport:'usb ',dataSource:''},
];
test('auto classifies Bluetooth and built-in headphones as headphones, everything else as speakers',()=>{
 assert.equal(headphoneOutput(devices[2]),'Bluetooth output');assert.equal(headphoneOutput(devices[3]),'Bluetooth output');
 assert.equal(headphoneOutput({...devices[1],dataSource:'hdpn'}),'headphones');
 for(const device of [devices[1],devices[4],devices[5],undefined])assert.equal(headphoneOutput(device),null);
 assert.equal(selectedOutput(devices,'default').id,'BuiltInSpeakerDevice');assert.equal(selectedOutput(devices,'WH-1000XM5').id,'88-C9:output');
 assert.equal(selectedOutput(devices,'BuiltInMicrophoneDevice'),undefined,'an input-only device is not an output');
 assert.deepEqual(resolveEcho('auto',devices,'88-C9:output'),{setting:'auto',effective:false,reason:'Bluetooth output'});
 assert.deepEqual(resolveEcho('auto',devices,'default'),{setting:'auto',effective:true,reason:'speakers'});
 assert.deepEqual(resolveEcho('auto',devices.map(d=>d.id==='BuiltInSpeakerDevice'?{...d,dataSource:'hdpn'}:d),'default'),{setting:'auto',effective:false,reason:'headphones'});
 assert.equal(resolveEcho('auto',devices,'display').effective,true);
 assert.equal(resolveEcho('auto',null,'default').effective,true,'unknown devices keep echo cancellation on');
 assert.deepEqual(resolveEcho('on',devices,'88-C9:output'),{setting:'on',effective:true,reason:'setting'});
 assert.deepEqual(resolveEcho('off',devices,'default'),{setting:'off',effective:false,reason:'setting'});
});
test('echoCancellation config resolves to auto, on or off',()=>{
 assert.equal(defaults.echoCancellation,'auto');
 for(const [value,setting] of [[undefined,'auto'],['auto','auto'],['on','on'],[true,'on'],['off','off'],[false,'off'],['loud','auto']])assert.equal(echoSetting(value),setting);
 const dir=mkdtempSync(path.join(tmpdir(),'voice-echo-')),file=path.join(dir,'v.json');
 writeFileSync(file,'{"echoCancellation":false}');assert.equal(loadConfig([file]).config.echoCancellation,'off');
 writeFileSync(file,'{}');assert.equal(loadConfig([file]).config.echoCancellation,'auto');
});
test('engine state reports the setting and, once capture runs, the effective state',()=>{
 const engine=new VoiceEngine({...defaults,echoCancellation:'auto'},()=>{},{platform:'darwin'});
 assert.deepEqual(engine.echoCancellation(),{setting:'auto',effective:null,reason:'decided when voice starts'});
 assert.equal(echoText(engine.echoCancellation()),'echo cancellation auto');
 engine.enabled=true;engine.audio={capture:true,echo:{setting:'auto',effective:false,reason:'Bluetooth output'}};
 assert.equal(echoText(engine.echoCancellation()),'echo cancellation auto (off: Bluetooth output)');
 engine.audio.echo={setting:'off',effective:false,reason:'setting'};assert.equal(echoText(engine.echoCancellation()),'echo cancellation off');
 assert.equal(new VoiceEngine(defaults,()=>{},{platform:'linux'}).echoCancellation().effective,false);
});
test('Voice panel changes echo cancellation through the devices control and rejects other values',async()=>{
 const hub=new OpenControlHub({list:async()=>[{id:'default',name:'System default'}]}),patches=[];
 hub.add({directory:'/p',config:{},load:async()=>{},session:async id=>({id,location:{directory:'/p'}}),state:()=>({enabled:false}),pause(){},run:async()=>{},configure:async patch=>patches.push(patch)});
 const input={directory:'/p',sessionID:'ses_one',clientID:'panel'};
 await assert.rejects(hub.request('POST','/devices',{...input,echoCancellation:'loud'}),/auto, on or off/);
 assert.equal((await hub.request('POST','/devices',{...input,echoCancellation:'off'})).input.length,1);
 assert.deepEqual(patches,[{echoCancellation:'off'}]);
});
