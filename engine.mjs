// Host-agnostic voice loop shared by the Pi extension and the opencode plugin.
// The host adapter supplies how to submit text, abort a turn and show status;
// the engine owns the microphone, recognition, speech segmentation and playback.
import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {defaults,devices,windowsMicrophones,AudioCapture,VoiceInput,Speaker,resolveBinary} from './voice.mjs';
import {SpeechSegments} from './speech.mjs';

export function loadConfig(files){
  const file=files.find(candidate=>existsSync(candidate))||files[0];
  let stored={};
  if(existsSync(file)){try{stored=JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,''));}catch{}}
  const config={...defaults,...stored};
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
  constructor(config,save=()=>{}){ // save(patch) persists settings
    this.config=config;this.save=save;this.host=null;this.enabled=false;this.readAloud=false;this.dictation=false;
    this.capture=null;this.input=null;this.speaker=null;
    this.speech=new SpeechSegments(text=>{if(this.readAloud)this.ensureSpeaker().enqueue(text);});
  }
  ensureSpeaker(){return this.speaker??=new Speaker(this.config,error=>this.host?.error(error));}
  owns(host){return this.host===host;}
  state(){return this.enabled?(this.dictation?'Voice: dictating':'Voice: listening'):this.readAloud?'Voice: read-aloud':'Voice: off';}
  status(text=this.state()){this.host?.status(text);}

  /** Take the microphone and speaker for this host, releasing any previous owner. */
  attach(host){
    if(this.host&&this.host!==host){const previous=this.host;this.halt();this.readAloud=false;previous.status('Voice: moved to another session');}
    this.host=host;
  }
  detach(host){if(this.host!==host)return;this.halt();this.readAloud=false;this.host=null;}

  async start(host,{dictation=false}={}){
    this.attach(host);this.halt();
    if(!this.config.asrUrl||!this.config.ttsUrl)throw new Error('Set "asrUrl" and "ttsUrl" in agent-voice.json (see /voice status).');
    if(process.platform==='win32'&&!this.config.device){
      const names=windowsMicrophones(await devices(this.config));
      if(!names.length)throw new Error('No microphone found.');
      const device=await host.selectDevice?.(names);if(!device)return;this.save({device});
    }
    this.dictation=dictation;this.enabled=true;this.readAloud=!dictation;
    this.ensureSpeaker();
    this.input=new VoiceInput(this.config,{
      muted:()=>!this.config.duplex&&!!this.speaker?.playing,
      start:()=>{this.speaker?.stop();this.speech.reset();if(!this.dictation&&this.host?.isBusy())this.host.abort();this.status('Voice: hearing you…');},
      partial:text=>this.status('Voice: '+text.slice(-90)),
      transcript:text=>{if(this.dictation&&this.host?.dictate)this.host.dictate(text);else this.host?.submit(text);},
      idle:()=>this.status(),
      error:error=>{this.halt();this.status();this.host?.error(error);}
    });
    this.capture=new AudioCapture(this.config);
    this.capture.on('pcm',pcm=>this.input?.push(pcm));
    this.capture.on('failure',error=>{this.halt();this.status();this.host?.error(new Error(micHint(error)));});
    this.capture.start();
    this.status();
  }
  /** Stop capture and speech but keep ownership. */
  halt(){this.enabled=false;this.capture?.stop();this.capture=null;this.input?.stop();this.input=null;this.speaker?.stop();this.speech.reset();}
  stop(){this.halt();this.status();}
  off(){this.readAloud=false;this.stop();}
  setReadAloud(host,on){this.attach(host);this.readAloud=on;if(!on)this.speaker?.stop();this.status();}
  hush(){this.speaker?.stop();this.speech.reset();}
  /** Speak a short cue regardless of read-aloud (for hosts without a status line). */
  say(host,text){this.attach(host);this.ensureSpeaker().enqueue(text);}
  test(host){this.say(host,'Your voice connection is ready.');}

  // Agent output hooks, fed by the host adapter.
  userMessage(){this.hush();}
  assistantStart(){this.speech.reset();}
  assistantDelta(delta){if(this.readAloud)this.speech.push(delta);}
  assistantText(fullText){if(this.readAloud)this.speech.update(fullText);}
  assistantEnd(ok=true){if(ok)this.speech.flush(true);else this.speaker?.stop();this.speech.reset();}

  async close(){this.halt();this.readAloud=false;this.host=null;await this.speaker?.close();this.speaker=null;}
}

// One microphone per process: Pi under PiChamber runs a runtime per session in
// one daemon, and opencode can load a plugin instance per project.
const KEY=Symbol.for('agent-voice');
export function shared(){return globalThis[KEY]??={engine:null,resume:null};}
