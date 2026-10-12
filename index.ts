import type {ExtensionAPI,ExtensionContext} from '@earendil-works/pi-coding-agent';
import {devices,windowsMicrophones} from './voice.mjs';
import {VoiceEngine,loadConfig,piConfigFile,shared} from './engine.mjs';
import {listDeviceChoices,resolveDeviceChoice} from './device-options.mjs';

// Runs in the Pi TUI and in hosts that drive Pi through its SDK/RPC with extension
// UI (PiChamber reports mode 'rpc' with hasUI). Audio stays on the machine running Pi.
const RESUME_MS=30*60*1000;

export default function(pi:ExtensionAPI){
  const {config,save,file}=loadConfig([piConfigFile()]);
  const state=shared();
  let ctx:ExtensionContext|null=null;
  const engine=():VoiceEngine=>state.engine??=new VoiceEngine(config,save);
  const sessionFile=()=>ctx?.sessionManager.getSessionFile()||ctx?.sessionManager.getSessionId();
  const host={
    // While Pi is streaming, steer injects the utterance after the current tool calls instead of
    // waiting for the whole run to finish (followUp); when idle it starts a turn either way.
    submit:(text:string)=>pi.sendUserMessage(text,{deliverAs:'steer',expandPromptTemplates:false}),
    dictate:(text:string)=>{
      if(!ctx)return;
      // Outside the TUI getEditorText is a lagging mirror; paste inserts at the caret instead.
      if(ctx.mode!=='tui'){ctx.ui.pasteToEditor(text+' ');return;}
      const prior=ctx.ui.getEditorText()||'';ctx.ui.setEditorText(prior+(prior&&!/\s$/.test(prior)?' ':'')+text);
    },
    abort:async()=>{
      const context=ctx;if(!context)return;context.abort();
      const until=Date.now()+5000;
      while(!context.isIdle()){
        if(Date.now()>until)throw new Error('Pi has not finished cancelling the current turn.');
        await new Promise(resolve=>setTimeout(resolve,20));
      }
    },
    isBusy:()=>!!ctx&&!ctx.isIdle(),
    status:(text:string)=>ctx?.ui.setStatus('agent-voice',text),
    error:(error:any)=>ctx?.ui.notify(String(error?.message||error),'error'),
    selectDevice:(names:string[])=>ctx!.ui.select('Voice microphone',names),
  };
  const mine=()=>state.engine?.owns(host)?state.engine:null;
  function requireUI(context:ExtensionContext){
    if(!context.hasUI)throw new Error('Voice needs interactive Pi (the TUI, or a UI host such as PiChamber).');
  }
  async function start(context:ExtensionContext,dictation=false){
    ctx=context;requireUI(context);await engine().start(host,{dictation});
  }
  const usage='Use /voice on, off, dictate, read on|off, stop, devices, input, output, duplex on|off, status, test, or check.';

  pi.registerCommand('voice',{
    description:'Voice: on, off, dictate, read on/off, stop, devices, input/output, status, duplex on/off, test, check',
    handler:async(args,context)=>{
      ctx=context;const [command='on',...rest]=(args||'').trim().split(/\s+/);const value=rest.join(' ');
      try{
        if(command==='on')await start(context);
        else if(command==='dictate')await start(context,true);
        else if(command==='off'){mine()?.off();state.resume=null;host.status('Voice: off');}
        else if(command==='stop'){mine()?.hush();context.abort();}
        else if(command==='read'){engine().setReadAloud(host,value!=='off');}
        else if(command==='duplex'){save({duplex:value==='on'});context.ui.notify(`Voice interruption ${config.duplex?'enabled':'disabled during playback'}.`,'info');}
        else if(['devices','input','output'].includes(command)){
          requireUI(context);
          const patch:Record<string,string>={};
          for(const direction of command==='devices'?['input','output']:[command]){
            const choices=await listDeviceChoices(config,direction);
            let choice;
            if(value&&command!=='devices')choice=resolveDeviceChoice(choices,value);
            else{
              const labels=choices.map((item:any,index:number)=>item.name+(choices.filter((other:any)=>other.name===item.name).length>1?' ('+index+')':''));
              const selected=await context.ui.select(direction==='input'?'Voice microphone':'Voice output device',labels);
              if(!selected)return;
              choice=choices[labels.indexOf(selected)];
            }
            patch[direction==='input'?'inputDevice':'outputDevice']=choice.id;
          }
          await engine().configureDevices(patch);context.ui.notify('Voice audio devices saved.','info');
        }
        else if(command==='status'){const e=mine();context.ui.notify(`${e?e.state():'Voice: off'}; ${context.mode} mode; ${config.asrUrl}; ${config.ttsUrl}; microphone ${config.inputDevice||config.device||'default'}; output ${config.outputDevice||'default'}; duplex ${config.duplex}; ffmpeg ${config.ffmpeg}; settings ${file}.`,'info');}
        else if(command==='check'){const result=await engine().check(host);context.ui.notify(result.ok?'Voice check passed: spoken interruption detected.':'Voice check failed: '+result.reason,result.ok?'info':'error');}
        else if(command==='test'){engine().test(host);context.ui.notify('Playing a speech test.','info');}
        else context.ui.notify(usage,'info');
      }catch(error:any){mine()?.stop();host.error(error);}
    }
  });
  // TUI only; in PiChamber bind /voice on and /voice stop to Command triggers instead.
  pi.registerShortcut('ctrl+alt+v',{description:'Toggle voice conversation',handler:context=>{ctx=context;const e=mine();if(e?.enabled)e.stop();else start(context).catch(host.error);}});
  pi.registerShortcut('ctrl+alt+x',{description:'Stop spoken reply and agent',handler:context=>{ctx=context;mine()?.hush();context.abort();}});

  pi.on('session_start',async(_event,context)=>{
    ctx=context;
    const resume=state.resume;
    if(resume&&Date.now()-resume.at<RESUME_MS&&(!resume.session||resume.session===sessionFile())&&context.hasUI){
      state.resume=null;
      try{if(resume.enabled)await start(context,resume.dictation);else engine().setReadAloud(host,true);}catch(error){host.error(error);}
    }else host.status(mine()?.state()||'Voice: /voice on');
  });
  pi.on('message_start',(event,context)=>{const e=mine();if(!e)return;ctx=context;if(event.message.role==='user')e.userMessage();else if(event.message.role==='assistant')e.assistantStart();});
  pi.on('message_update',(event,context)=>{const e=mine();if(!e)return;ctx=context;if(event.assistantMessageEvent.type==='text_delta')e.assistantDelta(event.assistantMessageEvent.delta);});
  pi.on('message_end',(event,context)=>{const e=mine();if(!e)return;ctx=context;if(event.message.role==='assistant')e.assistantEnd(!['error','aborted'].includes((event.message as any).stopReason));});
  pi.on('session_shutdown',async event=>{
    const e=mine();if(!e)return;
    // Survive /reload, session switches, and PiChamber parking an idle session:
    // the next matching session_start picks voice back up.
    if(e.enabled||e.readAloud){
      const session=event.reason==='quit'||event.reason==='reload'?sessionFile():event.targetSessionFile;
      state.resume={at:Date.now(),session,enabled:e.enabled,dictation:e.dictation};
    }
    state.engine=null;await e.close();
  });
}
