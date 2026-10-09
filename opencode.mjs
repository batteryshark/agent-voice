// opencode 2.x server plugin. Registers /voice and reads replies from the event
// stream, so any opencode client (TUI, OpenChamber, web) gets host-side voice.
// No imports from @opencode/plugin: plugins load from bare directories.
import {devices} from './voice.mjs';
import {VoiceEngine,loadConfig,opencodeConfigFile,piConfigFile,shared} from './engine.mjs';

const ID='agent-voice';
const USAGE='Voice commands: /voice on, off, dictate, read on|off, stop, duplex on|off, devices, status, test.';

export default {
  id:ID,
  async setup(ctx){
    const {config,save,file}=loadConfig([opencodeConfigFile(),piConfigFile()]);
    const state=shared();
    const engine=()=>state.engine??=new VoiceEngine(config,save);
    const busy=new Set();
    let sessionID=null,lastStatus='Voice: off';

    // Server plugins have no toast or status line that every client shows. Routine
    // confirmations are spoken; status, device lists and errors become synthetic
    // inbox entries (visible in the session, delivered with the next turn).
    const notice=text=>{
      if(!sessionID)return console.error(`[${ID}] ${text}`);
      ctx.session.synthetic({sessionID,text:`[voice] ${text}`,description:'Voice',resume:false}).catch(error=>console.error(`[${ID}]`,text,error));
    };
    const host={
      submit:text=>sessionID&&ctx.session.prompt({sessionID,text,delivery:busy.has(sessionID)?'steer':undefined}).catch(error=>notice(String(error?.message||error))),
      abort:()=>sessionID&&ctx.session.interrupt({sessionID}).catch(()=>{}),
      isBusy:()=>!!sessionID&&busy.has(sessionID),
      status:text=>{lastStatus=text;},
      error:error=>notice(String(error?.message||error)),
    };
    const mine=()=>state.engine?.owns(host)?state.engine:null;

    async function run(command='on',value,id){
      sessionID=id;
      if(command==='on'){await engine().start(host);mine()?.say(host,'Listening.');}
      else if(command==='dictate'){
        // Clients don't expose their composer to plugins, so dictation is spoken
        // input submitted without read-aloud.
        await engine().start(host,{dictation:true});mine()?.say(host,'Dictation on.');
      }
      else if(command==='off'){const e=mine();e?.off();e?.say(host,'Voice off.');}
      else if(command==='stop'){mine()?.hush();await ctx.session.interrupt({sessionID:id}).catch(()=>{});}
      else if(command==='read'){engine().setReadAloud(host,value!=='off');if(value!=='off')engine().say(host,'Reading replies aloud.');}
      else if(command==='duplex'){save({duplex:value==='on'});engine().say(host,config.duplex?'Interruption on. Use headphones.':'Interruption off.');}
      else if(command==='devices'){
        if(value){save({device:value});notice(`Microphone set to ${value}.`);}
        else notice('Microphones (set one with /voice devices <name or index>):\n'+String(await devices(config)).split('\n').filter(line=>/audio|\(audio\)|^\[/i.test(line)).join('\n'));
      }
      else if(command==='status')notice(`${mine()?lastStatus:'Voice: off'}; ${config.asrUrl}; ${config.ttsUrl}; microphone ${config.device||'default'}; ffmpeg ${config.ffmpeg}; settings ${file}.`);
      else if(command==='test'){engine().test(host);}
      else notice(USAGE);
    }

    await ctx.command.transform(commands=>commands.add({
      name:'voice',
      description:'Voice conversation: on, off, dictate, read on|off, stop, duplex on|off, devices, status, test',
      execute:async({sessionID:id,prompt})=>{
        const [command,...rest]=(prompt?.text||'').trim().split(/\s+/).filter(Boolean);
        try{await run(command,rest.join(' ')||undefined,id);}
        catch(error){mine()?.stop();notice(String(error?.message||error));}
      },
    }));

    const abort=new AbortController();
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
      const e=mine();if(e){state.engine=null;await e.close();}
    };
  },
};
