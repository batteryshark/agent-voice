export type VoicePhase='off'|'warming-audio'|'warming-speech'|'listening'|'checking';
export function voiceStatus(state:{enabled:boolean;sessionID:string|null;phase?:VoicePhase;status:string;checking?:boolean},sessionID:string|null,starting=false){
  const current=state.sessionID===sessionID;
  if(current&&state.enabled&&state.phase==='warming-speech')return {
    warming:true,text:state.checking?'Warming up… Preparing the test audio. Wait until you hear it before saying “pineapple”.':'Microphone ready. Preparing the voice cue… You can start talking.',
  };
  if((current&&state.enabled&&state.phase==='warming-audio')||starting)return {warming:true,text:'Warming up… Connecting the selected microphone and output.'};
  if(current&&state.checking&&state.phase==='checking')return {warming:false,text:state.status.startsWith('Voice:')?state.status:'Test playing. Say “pineapple” over the sample, then pause.'};
  return {warming:false,text:current&&state.enabled?state.status:state.status.startsWith('Voice paused')?state.status:'Microphone off'};
}
