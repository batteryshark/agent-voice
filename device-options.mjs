import {devices,windowsMicrophones} from './voice.mjs';
export function deviceChoices(list,direction){
 if(!['input','output'].includes(direction))throw new Error('Choose input or output');
 if(!Array.isArray(list)){
  if(direction==='output')throw new Error('Output selection requires native macOS audio.');
  return [{id:'default',name:'System default'},...windowsMicrophones(String(list)).map(name=>({id:name,name}))];
 }
 return [{id:'default',name:'System default'},...list.filter(device=>device[direction]===true).map(({id,name})=>({id,name}))];
}
export async function listDeviceChoices(config,direction){return deviceChoices(await devices(config),direction);}
export function resolveDeviceChoice(choices,value){
 const cleaned=value.trim().replace(/^"(.*)"$/,'$1');
 const exact=choices.find(choice=>choice.id===cleaned);
 if(exact)return exact;
 const matches=choices.filter(choice=>choice.name===cleaned);
 if(matches.length===1)return matches[0];
 if(matches.length>1)throw new Error('That device name is ambiguous; select it from /voice devices.');
 throw new Error('Device not found; list available devices with /voice '+(choices[0]?.direction||'devices')+'.');
}
