import {setTimeout as delay} from 'node:timers/promises';
import {listDeviceChoices} from './device-options.mjs';

export async function selectOpenDevices(ctx,config,sessionID,directions,signal,{list=listDeviceChoices,pause=delay}={}){
  const choices=await Promise.all(directions.map(direction=>list(config,direction)));
  const fields=directions.map((direction,index)=>{
    const key=direction==='input'?'inputDevice':'outputDevice',items=choices[index];
    return {key,type:'string',title:direction==='input'?'Microphone':'Output device',required:true,custom:false,
      options:items.map(item=>({value:item.id,label:item.name})),
      default:items.some(item=>item.id===config[key])?config[key]:'default'};
  });
  const created=await ctx.session.form.create({sessionID,title:'Voice audio devices',fields});
  const form=created.data??created;let settled=false;
  try{
    while(!signal?.aborted){
      const result=await ctx.session.form.get({sessionID,formID:form.id});
      const state=(result.data??result).state;
      if(state.status==='cancelled'){settled=true;return null;}
      if(state.status==='answered'){
        settled=true;const patch={};
        for(const [index,field] of fields.entries()){
          const value=state.answer[field.key];
          if(!choices[index].some(choice=>choice.id===value))throw new Error('The chosen audio device is unavailable. Open /voice devices again.');
          patch[field.key]=value;
        }
        return patch;
      }
      await pause(250,undefined,{signal});
    }
    return null;
  }finally{if(!settled)await ctx.session.form.cancel({sessionID,formID:form.id,message:'Voice settings closed.'}).catch(()=>{});}
}
