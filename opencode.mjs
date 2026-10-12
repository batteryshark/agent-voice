// opencode 2.x server plugin. Registers /voice and reads replies from the event
// stream, so any opencode client (TUI, OpenChamber, web) gets host-side voice.
// No imports from @opencode/plugin: plugins load from bare directories.
import {devices,listVoices} from './voice.mjs';
import {listDeviceChoices,resolveDeviceChoice} from './device-options.mjs';
import {VoiceEngine,loadConfig,opencodeConfigFile,piConfigFile,shared} from './engine.mjs';
import {openChamberNotice} from './openchamber-notice.mjs';
import {selectOpenDevices} from './opencode-devices.mjs';
import {registerOpenControl} from './openchamber-control.mjs';

const ID='agent-voice';
const USAGE='Voice commands: /voice on, off, dictate, read on|off, mic on|off, speaker on|off, stop, duplex on|off, devices, input, output, status, test, check.';

export default {
  id:ID,
  async setup(ctx){
    const {config,save,file}=loadConfig([opencodeConfigFile(),piConfigFile()]);
    const state=shared();
    const engine=()=>state.engine??=new VoiceEngine(config,save);
    const busy=new Set();
    const abort=new AbortController();
    let sessionID=null,noticeSessionID=null,lastStatus='Voice: off',lastError=null;

    // OpenChamber provides a native notification channel. Other clients receive
    // requested notices in their synthetic inbox without starting an agent turn.
    const notice=async(text,id=noticeSessionID||sessionID)=>{
      if(!id)return console.error(`[${ID}] ${text}`);
      try{if(await openChamberNotice(text,id))return;}
      catch(error){console.error(`[${ID}] native notice`,error.message);}
      return ctx.session.synthetic({sessionID:id,text:`[voice] ${text}`,description:'Voice',resume:false}).catch(error=>console.error(`[${ID}]`,text,error));
    };
    const host={
      submit:text=>sessionID&&ctx.session.prompt({sessionID,text,delivery:busy.has(sessionID)?'steer':undefined}),
      abort:async()=>{if(sessionID){await ctx.session.interrupt({sessionID,continue:false});await ctx.session.wait?.({sessionID});}},
      isBusy:()=>!!sessionID&&busy.has(sessionID),
      status:text=>{lastStatus=text;},
      error:error=>{lastError=String(error?.message||error);void notice(lastError,sessionID);},
    };
    const mine=(id=sessionID)=>state.engine?.owns(host)&&id===sessionID?state.engine:null;

    async function run(command='on',value,id){
      noticeSessionID=id;
      if(['on','dictate','read','test','check','preview'].includes(command)){
        if(sessionID&&sessionID!==id&&state.engine?.owns(host))state.engine.detach(host);
        sessionID=id;
      }
      if(command==='on'){lastError=null;await engine().start(host,{cue:'Listening.'});}
      else if(command==='dictate'){
        // Clients don't expose their composer to plugins, so dictation is spoken
        // input submitted without read-aloud.
        await engine().start(host,{dictation:true,cue:'Dictation on.'});
      }
      else if(command==='off'){const e=mine(id);e?.off();e?.say(host,'Voice off.');}
      else if(command==='stop'){mine(id)?.hush();await ctx.session.interrupt({sessionID:id,continue:false});await ctx.session.wait?.({sessionID:id});}
      else if(command==='mic'||command==='speaker'){
        const e=mine(id);if(!e?.enabled)throw new Error('Start voice before muting the '+(command==='mic'?'microphone':'agent voice')+'.');
        if(command==='mic')e.setMicMuted(value==='off');else e.setOutputMuted(value==='off');
      }
      else if(command==='read'){engine().setReadAloud(host,value!=='off');if(value!=='off')engine().say(host,'Reading replies aloud.');}
      else if(command==='duplex'){save({duplex:value==='on'});engine().say(host,config.duplex?'Spoken interruption on.':'Interruption off.');}
      else if(['devices','input','output'].includes(command)){
        const directions=command==='devices'?['input','output']:[command];
        if(!value&&ctx.session.form){
          const patch=await selectOpenDevices(ctx,config,id,directions,abort.signal);
          if(patch){await engine().configureDevices(patch);await notice('Voice audio devices saved.');}
          return;
        }
        for(const direction of directions){
          const choices=await listDeviceChoices(config,direction);
          if(value&&command!=='devices'){
            const choice=resolveDeviceChoice(choices,value);
            await engine().configureDevices({[direction==='input'?'inputDevice':'outputDevice']:choice.id});
            await notice((direction==='input'?'Microphone':'Output')+' set to '+choice.name+'.');
          }else await notice((direction==='input'?'Microphones':'Output devices')+' — choose with /voice '+direction+' <name>:\n'+choices.map(choice=>choice.name).join('\n'));
        }
      }
      else if(command==='status')await notice(`${mine()?lastStatus:'Voice: off'}; microphone ${config.inputDevice||config.device||'default'}; output ${config.outputDevice||'default'}; duplex ${config.duplex}; settings ${file}.`);
      else if(command==='check'){lastError=null;void notice('Voice check is warming up. Wait until you hear the sample, then say pineapple. The microphone turns off after this check.');const result=await engine().check(host);await notice(result.ok?'Voice check passed: spoken interruption detected.':'Voice check failed: '+result.reason);return result;}
      else if(command==='test'){engine().test(host);}
      else if(command==='preview'){engine().say(host,value||'Your voice connection is ready.');}
      else await notice(USAGE);
    }

    await ctx.command.transform(commands=>commands.add({
      name:'voice',
      description:'Voice conversation: on, off, dictate, read on|off, mic on|off, speaker on|off, stop, duplex on|off, devices, input, output, status, test, check',
      execute:async({sessionID:id,prompt})=>{
        const [command,...rest]=(prompt?.text||'').trim().split(/\s+/).filter(Boolean);
        try{await run(command,rest.join(' ')||undefined,id);}
        catch(error){mine()?.stop();await notice(String(error?.message||error));}
      },
    }));
    const closeControl=ctx.location&&process.env.OPENCHAMBER_AGENT_TOOL_URL&&await registerOpenControl({
      directory:ctx.location.directory,config,run,
      load:directory=>ctx.command.list({location:{directory}}),
      session:async id=>{const result=await ctx.session.get({sessionID:id});return result.data??result;},
      configure:patch=>engine().configureDevices(patch),
      // The speaker reads config.voice on each request, so a new voice applies from the next sentence.
      voices:()=>listVoices(config),
      setVoice:voice=>save({voice}),
      pause:message=>{mine()?.off();lastStatus=message;},
      state:()=>({enabled:!!mine()?.enabled,sessionID:mine()?sessionID:null,phase:mine()?.phase||'off',micMuted:!!mine()?.micMuted,outputMuted:!!mine()?.outputMuted,status:lastStatus,error:lastError,inputDevice:config.inputDevice,outputDevice:config.outputDevice,configured:!!config.asrUrl&&!!config.ttsUrl}),
    });

    (async()=>{
      while(!abort.signal.aborted){
        try{
          for await(const event of ctx.event.subscribe({signal:abort.signal})){
            const data=event?.data;if(!data?.sessionID)continue;
            if(event.type==='session.execution.started')busy.add(data.sessionID);
            else if(/^session\.execution\.(succeeded|interrupted|failed)$/.test(event.type))busy.delete(data.sessionID);
            const e=mine();if(!e||data.sessionID!==sessionID)continue;
            switch(event.type){
              case 'session.inbox.enqueued':if(data.item?.type==='user')e.userMessage();break;
              case 'session.text.started':e.assistantStart();break;
              case 'session.text.delta':e.assistantDelta(data.delta);break;
              case 'session.text.ended':e.assistantText(data.text);e.assistantEnd(true);break;
              case 'session.execution.interrupted':case 'session.execution.failed':e.assistantEnd(false);break;
            }
          }
        }catch(error){if(abort.signal.aborted)break;console.error(`[${ID}] event stream`,error);}
        if(!abort.signal.aborted)await new Promise(resolve=>setTimeout(resolve,1000));
      }
    })();

    return async()=>{
      abort.abort();
      await closeControl?.();
      const e=mine();if(e){state.engine=null;await e.close();}
    };
  },
};
