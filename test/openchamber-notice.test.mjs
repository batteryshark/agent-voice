import test from 'node:test';
import assert from 'node:assert/strict';
import {openChamberNotice} from '../openchamber-notice.mjs';
test('OpenChamber feedback uses its managed native notification channel without an agent turn',async()=>{
 let sent;
 const env={OPENCHAMBER_AGENT_TOOL_URL:'http://127.0.0.1:1234/api/agent-tool',OPENCHAMBER_AGENT_TOOL_TOKEN:'test'};
 const request=async(url,options)=>{sent={url:String(url),options};return {ok:true,json:async()=>({delivered:true})};};
 assert.equal(await openChamberNotice('Choose a microphone','session-a',{env,request}),true);
 assert.equal(sent.url,'http://127.0.0.1:1234/api/notifications/emit');
 assert.deepEqual(JSON.parse(sent.options.body),{title:'Voice',body:'Choose a microphone',sessionId:'session-a',showWhenFocused:true});
 assert.equal(await openChamberNotice('Status','session-a',{env:{},request}),false);
});
