// Hardware smoke test. Plays quiet generated tones and counts live PCM frames.
// No microphone audio or transcripts are written to disk or sent to a service.
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {MacAudio} from '../native-audio.mjs';
import {loadConfig,opencodeConfigFile,piConfigFile} from '../engine.mjs';
if(process.platform!=='darwin')throw new Error('This hardware check requires macOS.');
const args=process.argv.slice(2),{config}=loadConfig([opencodeConfigFile(),piConfigFile()]);
for(const [flag,key] of [['--input','inputDevice'],['--output','outputDevice']]){const index=args.indexOf(flag);if(index>=0)config[key]=args[index+1];}
const capture=!args.includes('--output-only'),audio=new MacAudio(config);let frames=0,failure=null;
audio.on('pcm',()=>frames++);audio.on('failure',error=>failure=error);
function tone(seconds){
 const samples=48000*seconds,wave=Buffer.alloc(44+samples*2);
 wave.write('RIFF');wave.writeUInt32LE(wave.length-8,4);wave.write('WAVEfmt ',8);wave.writeUInt32LE(16,16);
 wave.writeUInt16LE(1,20);wave.writeUInt16LE(1,22);wave.writeUInt32LE(48000,24);wave.writeUInt32LE(96000,28);wave.writeUInt16LE(2,32);wave.writeUInt16LE(16,34);
 wave.write('data',36);wave.writeUInt32LE(samples*2,40);
 for(let i=0;i<samples;i++)wave.writeInt16LE(Math.round(819*Math.sin(2*Math.PI*440*i/48000)),44+i*2);
 return wave;
}
const timer=setTimeout(()=>{failure=new Error('Native audio hardware check timed out');audio.close();},15000);
try{
 await audio.start(capture);await audio.play(config,tone(1),()=>{});assert.equal(failure,null);
 if(capture)assert(frames>0,'The selected microphone delivered no PCM frames');
 let player;const playback=audio.play(config,tone(3),value=>player=value);playback.catch(error=>{if(!player)failure=error;});
 while(!player){if(failure)throw failure;await delay(10);}
 await delay(250);const before=frames,stopped=Date.now();player.kill();await playback;
 assert(Date.now()-stopped<1000,'Spoken-reply playback did not stop promptly');
 await delay(350);assert.equal(failure,null);
 if(capture)assert(frames>before,'Stopping playback also stopped the microphone');
 console.log(JSON.stringify({ok:true,microphoneFrames:frames,playbackCompleted:true,playbackStopped:true,echoCancellation:audio.format.echoCancellation}));
}finally{clearTimeout(timer);audio.close();}
