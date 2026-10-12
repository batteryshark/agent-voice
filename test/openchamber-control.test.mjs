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
