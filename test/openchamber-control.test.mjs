import test from 'node:test';
import assert from 'node:assert/strict';
import {OpenControlHub} from '../openchamber-control.mjs';
function fixture(){
 let now=0;const calls=[],hub=new OpenControlHub({now:()=>now,leaseMs:100});
 const instance={directory:'/project',config:{},load:async()=>{},session:async id=>({id,location:{directory:id==='ses_other'?'/elsewhere':'/project'}}),
  state:()=>({enabled:calls.at(-1)?.[0]==='on'}),pause:message=>calls.push(['pause',message]),run:async(command,value,id)=>calls.push([command,id])};
 hub.add(instance);const input={directory:'/project',sessionID:'ses_one',clientID:'panel'};
 return {hub,calls,input,advance:ms=>now+=ms};
}
test('Voice panel targets the native selected chat and releases it when that selection changes',async()=>{
 const f=fixture();await f.hub.request('POST','/command',{...f.input,command:'on'});
 assert.deepEqual(f.calls.at(-1),['on','ses_one']);
 await assert.rejects(f.hub.request('POST','/command',{...f.input,sessionID:'ses_other',command:'on'}),/does not match/);
 assert.match(f.calls.at(-1)[1],/selected chat changed/);
 await f.hub.request('POST','/command',{...f.input,command:'on'});
 await f.hub.request('GET','/state',{...f.input,sessionID:'ses_two'});
 assert.match(f.calls.at(-1)[1],/selected chat changed/);
});
test('Voice panel stops audio when its heartbeat is lost and another panel cannot stop its owner',async()=>{
 const f=fixture();await f.hub.request('POST','/command',{...f.input,command:'on'});
 await f.hub.request('GET','/state',f.input);
 await assert.rejects(f.hub.request('POST','/command',{...f.input,clientID:'other-panel',command:'off'}),/another panel/);
 f.advance(101);f.hub.expire();assert.match(f.calls.at(-1)[1],/disconnected/);
});
test('hidden panel cancels pending startup and pauses its existing capture immediately',async()=>{
 const f=fixture();let finish;
 const instance=f.hub.instances.get('/project');
 instance.session=()=>new Promise(resolve=>finish=()=>resolve({location:{directory:'/project'}}));
 const startup=f.hub.request('POST','/command',{...f.input,command:'on'});
 await f.hub.request('GET','/pause',f.input);finish();await assert.rejects(startup,/closed during microphone startup/);
 assert(!f.calls.some(call=>call[0]==='on'));
 instance.session=async()=>({location:{directory:'/project'}});
 await f.hub.request('POST','/command',{...f.input,command:'on'});await f.hub.request('GET','/pause',f.input);
 assert.match(f.calls.at(-1)[1],/panel closed/);
});
test('Voice panel lists the speech server voices and saves a choice that exists there',async()=>{
 const f=fixture(),instance=f.hub.instances.get('/project');let saved;
 instance.config={voice:'default'};
 instance.voices=async()=>({voices:[{id:'mizuki',name:'Mizuki'},{id:'lisa',name:'Lisa'}],default:'mizuki'});
 instance.setVoice=voice=>{saved=voice;instance.config.voice=voice;};
 assert.deepEqual(await f.hub.request('GET','/voices',f.input),{available:true,voices:[{id:'mizuki',name:'Mizuki'},{id:'lisa',name:'Lisa'}],serverDefault:'mizuki',voice:'default'});
 assert.equal((await f.hub.request('POST','/voices',{...f.input,voice:'lisa'})).voice,'lisa');assert.equal(saved,'lisa');
 await f.hub.request('POST','/voices',{...f.input,voice:'default'});assert.equal(saved,'default');
 await assert.rejects(f.hub.request('POST','/voices',{...f.input,voice:'alloy'}),/not available/);
 instance.voices=async()=>null;
 assert.equal((await f.hub.request('GET','/voices',f.input)).available,false);
 await assert.rejects(f.hub.request('POST','/voices',{...f.input,voice:'lisa'}),/does not list/);
});
test('Voice preview speaks a short line in the selected chat and rejects anything else',async()=>{
 const f=fixture();
 await f.hub.request('POST','/command',{...f.input,command:'preview',value:'This is the Lisa voice.'});
 assert.deepEqual(f.calls.at(-1),['preview','ses_one']);
 await assert.rejects(f.hub.request('POST','/command',{...f.input,command:'preview',value:'x'.repeat(201)}),/Unknown/);
 await assert.rejects(f.hub.request('POST','/command',{...f.input,command:'preview'}),/Unknown/);
});
