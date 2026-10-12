// Host-agnostic voice loop shared by the Pi extension and the opencode plugin.
// The host adapter supplies how to submit text, abort a turn and show status;
// the engine owns the microphone, recognition, speech segmentation and playback.
import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {defaults,devices,windowsMicrophones,AudioCapture,VoiceInput,Speaker,resolveBinary} from './voice.mjs';
import {SpeechSegments} from './speech.mjs';
import {MacAudio} from './native-audio.mjs';

export function loadConfig(files){
  const file=files.find(candidate=>existsSync(candidate))||files[0];
  let stored={};
  if(existsSync(file)){try{stored=JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,''));}catch{}}
  const config={...defaults,...stored};
  if(stored.inputDevice===undefined&&stored.device!==undefined)config.inputDevice=stored.device;
  config.ffmpeg=resolveBinary(config.ffmpeg);config.ffplay=resolveBinary(config.ffplay);
  // Persist only what the user set, so new defaults still reach them.
  const save=patch=>{Object.assign(stored,patch);Object.assign(config,patch);
    mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,JSON.stringify(stored,null,2)+'\n',{mode:0o600});};
  return {config,file,save};
}
export const piConfigFile=()=>path.join(process.env.PI_CODING_AGENT_DIR||path.join(homedir(),'.pi','agent'),'agent-voice.json');
export const opencodeConfigFile=()=>path.join(process.env.XDG_CONFIG_HOME||path.join(homedir(),'.config'),'opencode','agent-voice.json');

export function micHint(error){
  const message=String(error?.message||error);
  if(error?.code==='ENOENT')return `${message}. Install FFmpeg (brew install ffmpeg) or set "ffmpeg" in the voice settings file.`;
  if(process.platform==='darwin'&&/avfoundation|Input\/output|not authorized|permission/i.test(message))
    return `${message}\nmacOS may be blocking the microphone: allow it for the app that launched the agent (Terminal, PiChamber, OpenChamber) in System Settings › Privacy & Security › Microphone.`;
  return message;
}

/**
 * host: {
 *   submit(text)      send a finished utterance as a user message
 *   dictate(text)     place text in the composer without sending (optional)
 *   abort()           cancel the running agent turn
 *   isBusy()          true while the agent is producing a reply
 *   status(text)      short status line
 *   error(error)      show an error
 *   selectDevice?(names) async choose a Windows microphone
 * }
 */
export class VoiceEngine {
  constructor(config,save=()=>{},options={}){ // save(patch) persists settings
    this.platform=options.platform||process.platform;this.Capture=options.Capture||AudioCapture;this.Input=options.Input||VoiceInput;this.NativeAudio=options.NativeAudio||MacAudio;
    this.config=config;this.save=save;this.host=null;this.enabled=false;this.readAloud=false;this.dictation=false;
    this.capture=null;this.input=null;this.speaker=null;this.audio=null;this.interruption=Promise.resolve();this.suppressOutput=false;this.captureEpoch=0;
    this.phase='off';this.acceptInput=false;
    this.speech=new SpeechSegments(text=>{if(this.readAloud&&!this.suppressOutput)this.ensureSpeaker().enqueue(text);});
  }
  ensureAudio(){return this.audio??=new this.NativeAudio(this.config);}
  ensureSpeaker(){return this.speaker??=new Speaker(this.config,error=>{
    if(this.phase==='warming-speech'){this.phase='listening';this.status();}
    this.host?.error(error);
  },this.platform==='darwin'?{playAudio:(...args)=>this.ensureAudio().play(...args)}:{});}
  interrupt(){
    this.speaker?.stop();this.speech.reset();this.suppressOutput=true;
    if(this.phase==='warming-speech')this.phase='listening';
    const host=this.host;
    // Native cancellation is safe for an idle turn too. Do not depend on a
    // client's potentially delayed busy notification when the user cuts in.
    this.interruption=Promise.resolve().then(()=>!this.dictation?host?.abort():undefined);
    this.interruption.catch(()=>{});
    return this.interruption;
  }
  async deliver(text,epoch=this.captureEpoch){
    const host=this.host;
    try{
      await this.interruption;
      if(!this.enabled||this.host!==host||this.captureEpoch!==epoch)return;
      if(this.dictation&&host?.dictate)await host.dictate(text);else await host?.submit(text);
    }catch(error){this.host?.error(new Error('Voice instruction was not sent: '+String(error?.message||error)));}
  }
  owns(host){return this.host===host||this.host?.voiceDiagnosticOwner===host;}
  state(){
    if(this.enabled&&this.phase==='warming-audio')return 'Warming up: connecting microphone and output…';
    if(this.enabled&&this.phase==='warming-speech')return 'Warming up: preparing speech…';
    return this.enabled?(this.dictation?'Voice: dictating':'Voice: listening'):this.readAloud?'Voice: read-aloud':'Voice: off';
  }
  status(text=this.state()){this.host?.status(text);}

  /** Take the microphone and speaker for this host, releasing any previous owner. */
  attach(host){
    if(this.host&&this.host!==host){const previous=this.host;this.halt();this.readAloud=false;previous.status('Voice: moved to another session');}
    this.host=host;
  }
  detach(host){if(this.host!==host)return;this.halt();this.readAloud=false;this.host=null;}

  async start(host,{dictation=false,cue,onCueStart,holdInputForCue=false}={}){
    this.attach(host);this.halt();
    if(!this.config.asrUrl||!this.config.ttsUrl)throw new Error('Set "asrUrl" and "ttsUrl" in agent-voice.json (see /voice status).');
    if(process.platform==='win32'&&!this.config.device){
      const names=windowsMicrophones(await devices(this.config));
      if(!names.length)throw new Error('No microphone found.');
      const device=await host.selectDevice?.(names);if(!device)return;this.save({device});
    }
    this.dictation=dictation;this.suppressOutput=false;this.interruption=Promise.resolve();this.enabled=true;this.readAloud=!dictation;
    this.phase='warming-audio';this.acceptInput=false;this.status();
    const epoch=this.captureEpoch,speaker=this.ensureSpeaker(),cues=cue?(Array.isArray(cue)?cue:[cue]):[];
    const prepared=cues.length?speaker.prefetch(cues[0]):null;
    this.input=new this.Input(this.config,{
      muted:()=>!this.config.duplex&&!!this.speaker?.playing,
      start:()=>{this.interrupt();this.status('Voice: hearing you…');},
      partial:text=>this.status('Voice: '+text.slice(-90)),
      transcript:text=>{this.deliver(text,this.captureEpoch);},
      idle:()=>this.status(),
      error:error=>{this.host?.error(error);this.halt();this.status();}
    });
    this.capture=this.platform==='darwin'?this.ensureAudio():new this.Capture(this.config);
    this.onPCM=pcm=>{if(this.acceptInput)this.input?.push(pcm);};
    this.onFailure=error=>{this.host?.error(new Error(micHint(error)));this.halt();this.status();};
    this.capture.on('pcm',this.onPCM);this.capture.on('failure',this.onFailure);
    try{if(this.platform==='darwin')await this.capture.start(true);else this.capture.start();}
    catch(error){if(this.host===host&&this.captureEpoch===epoch){host.error(new Error(micHint(error)));this.halt();}throw error;}
    if(this.host!==host||this.captureEpoch!==epoch||!this.enabled)throw new Error('Voice startup cancelled.');
    this.acceptInput=!holdInputForCue;this.phase=prepared?'warming-speech':'listening';
    this.status();
    if(prepared){
      speaker.enqueue(cues[0],{prepared,onPlaying:()=>{
        if(this.host!==host||this.captureEpoch!==epoch||!this.enabled)return;
        this.acceptInput=true;this.phase=holdInputForCue?'checking':'listening';this.status();onCueStart?.();
      }});
      for(const text of cues.slice(1))speaker.enqueue(text);
    }
  }
  /** Stop capture and speech but keep ownership. */
  halt(reason='Voice check was stopped.'){this.checkAbort?.(reason);this.checkAbort=null;this.captureEpoch++;this.enabled=false;this.phase='off';this.acceptInput=false;if(this.capture){this.capture.removeListener('pcm',this.onPCM);this.capture.removeListener('failure',this.onFailure);}if(this.platform==='darwin')this.capture?.close();else this.capture?.stop();this.capture=null;this.input?.stop();this.input=null;this.speaker?.stop();this.speech.reset();}
  async configureDevices(patch){
    const host=this.host,diagnostic=!!host?.voiceDiagnosticOwner,enabled=this.enabled&&!diagnostic,dictation=this.dictation,readAloud=diagnostic?false:this.readAloud;
    this.save(patch);Object.assign(this.config,patch);
    this.halt('Audio devices changed. Run the speaker test again.');this.audio?.close();
    if(enabled&&host){await this.start(host,{dictation});this.readAloud=readAloud;}
    else{this.readAloud=readAloud;this.status();}
  }
  stop(){this.halt();this.status();}
  off(){this.readAloud=false;this.stop();}
  setReadAloud(host,on){this.attach(host);this.readAloud=on;if(!on)this.speaker?.stop();this.status();}
  hush(){this.speaker?.stop();this.speech.reset();}
  /** Speak a short cue regardless of read-aloud (for hosts without a status line). */
  say(host,text){this.attach(host);this.ensureSpeaker().enqueue(text);}
  test(host){this.say(host,'Your voice connection is ready.');}
  async check(host){
    let resolve,timer;const duplex=this.config.duplex;
    const outcome=new Promise(done=>resolve=done);
    const diagnosticHost={...host,voiceDiagnosticOwner:host,isBusy:()=>false,abort:async()=>{},
      submit:async text=>resolve(/\bpineapple\b/i.test(text)?{ok:true}:{ok:false,reason:'Speech did not match the visual challenge; possible speaker feedback.'}),
      error:error=>resolve({ok:false,reason:String(error?.message||error)}),
    };
    try{
      this.config.duplex=true;
      timer=setTimeout(()=>resolve({ok:false,reason:'Voice warm-up timed out. Check the speech service and selected audio devices.'}),30000);
      const startup=this.start(diagnosticHost,{
        cue:['This is the voice interruption test. Speak the word shown in the panel to stop this audio.',
          'This sample keeps speaking so you can try interrupting. Your voice should stop the audio, and the microphone will turn off when the test finishes.'],
        holdInputForCue:true,
        onCueStart:()=>{
          clearTimeout(timer);this.status('Voice check: say pineapple while the sample plays.');
          timer=setTimeout(()=>resolve({ok:false,reason:'No spoken interruption was detected.'}),20000);
        },
      });
      this.checkAbort=reason=>resolve({ok:false,reason});
      await startup.catch(error=>diagnosticHost.error(error));
      const result=await outcome;
      if(this.host!==diagnosticHost)return {ok:false,reason:'Voice check stopped because its chat changed.'};
      this.off();this.attach(host);
      const message=result.ok?'Voice check passed: spoken interruption detected.':'Voice check failed: '+result.reason;
      this.status(message);if(!result.ok)host.error(new Error(message));return result;
    }finally{this.checkAbort=null;this.config.duplex=duplex;clearTimeout(timer);if(this.host===diagnosticHost){this.off();this.attach(host);}}
  }

  // Agent output hooks, fed by the host adapter.
  userMessage(){this.hush();this.suppressOutput=false;}
  assistantStart(){this.speech.reset();}
  assistantDelta(delta){if(this.readAloud&&!this.suppressOutput)this.speech.push(delta);}
  assistantText(fullText){if(this.readAloud&&!this.suppressOutput)this.speech.update(fullText);}
  assistantEnd(ok=true){if(ok&&!this.suppressOutput)this.speech.flush(true);else this.speaker?.stop();this.speech.reset();}

  async close(){this.halt();this.readAloud=false;this.host=null;await this.speaker?.close();this.speaker=null;this.audio?.close();this.audio=null;}
}

// One microphone per process: Pi under PiChamber runs a runtime per session in
// one daemon, and opencode can load a plugin instance per project.
const KEY=Symbol.for('agent-voice');
export function shared(){return globalThis[KEY]??={engine:null,resume:null};}
