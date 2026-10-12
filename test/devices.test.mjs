import test from 'node:test';
import assert from 'node:assert/strict';
import {deviceChoices,resolveDeviceChoice} from '../device-options.mjs';
const list=[{id:'mic',name:'Desk device',input:true,output:false},{id:'speaker',name:'Desk device',input:false,output:true},{id:'both',name:'USB headset',input:true,output:true}];
test('input/output selectors filter by direction and retain persistent device IDs',()=>{
 const inputs=deviceChoices(list,'input'),outputs=deviceChoices(list,'output');
 assert.deepEqual(inputs.map(d=>d.id),['default','mic','both']);assert.deepEqual(outputs.map(d=>d.id),['default','speaker','both']);
 assert.equal(resolveDeviceChoice(inputs,'Desk device').id,'mic');assert.equal(resolveDeviceChoice(outputs,'Desk device').id,'speaker');
 assert.equal(resolveDeviceChoice(outputs,'"USB headset"').id,'both');assert.throws(()=>resolveDeviceChoice(inputs,'Disconnected device'),/not found/);
});
