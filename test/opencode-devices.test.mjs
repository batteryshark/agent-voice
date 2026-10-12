import test from 'node:test';
import assert from 'node:assert/strict';
import {selectOpenDevices} from '../opencode-devices.mjs';
const list=async(_,direction)=>[{id:'default',name:'System default'},{id:direction+'-uid',name:direction+' device'}];
test('native OpenCode form selects both directions atomically and cancels without changing choices',async()=>{
 let fields,cancelled=0,state={status:'answered',answer:{inputDevice:'input-uid',outputDevice:'output-uid'}};
 const ctx={session:{form:{create:async input=>{fields=input.fields;return {id:'frm_test'};},get:async()=>({state}),cancel:async()=>cancelled++}}};
 assert.deepEqual(await selectOpenDevices(ctx,{},'s1',['input','output'],undefined,{list}),{inputDevice:'input-uid',outputDevice:'output-uid'});
 assert.deepEqual(fields[0].options.map(x=>x.value),['default','input-uid']);assert.equal(cancelled,0);
 state={status:'cancelled'};assert.equal(await selectOpenDevices(ctx,{},'s1',['input','output'],undefined,{list}),null);
 const abort=new AbortController();abort.abort();await selectOpenDevices(ctx,{},'s1',['input'],abort.signal,{list});assert.equal(cancelled,1);
});
