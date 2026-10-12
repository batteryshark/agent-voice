import {connectHost} from '@openchamber/sdk';
import {applyHostReady,mountButton,mountSelect,mountSwitch} from '@openchamber/sdk/ui';
import {voiceStatus,type VoicePhase} from './status';
const host=connectHost(),clientID=crypto.randomUUID();
type Choice={id:string;name:string};
type State={enabled:boolean;sessionID:string|null;phase?:VoicePhase;status:string;error:string|null;inputDevice:string;outputDevice:string;configured:boolean;checking?:boolean;result?:{ok:boolean;reason?:string};input?:Choice[];output?:Choice[]};
let directory:string|null=null,session:{id:string;title?:string}|null=null,mounted=false,pending=false,refreshing=false,visible=true;
let state:State={enabled:false,sessionID:null,status:'Microphone off',error:null,inputDevice:'default',outputDevice:'default',configured:false};
let mutation=Promise.resolve();
let starting=false;
// Opt-in: keep voice running while this panel is hidden behind another tab,
// in a closed zone, or in a minimized window. Closing the Voice tab itself
// still releases audio, because the heartbeat stops with the page.
const KEEP_KEY='keepRunningHidden';
let keepRunning=false;
const node=(id:string)=>{const element=document.getElementById(id);if(!element)throw new Error('Missing Voice panel control');return element;};
const notice=(error:Error)=>{node('notice').textContent=error.message;};
async function request(path:string,method:'GET'|'POST'='GET',extra:object={}){
  if(!directory)throw new Error('Select a project to use voice.');
  const context={directory,sessionID:session?.id||'',clientID,...extra};
  const result=await host.serviceRequest(method==='GET'?{method,path,query:context}:{method,path,body:JSON.stringify(context)});
  const value=JSON.parse(result.body);if(result.status>=400)throw new Error(value.error||'Voice control failed');return value as State;
}
function paint(){
  const enabled=state.enabled&&state.sessionID===session?.id;
  node('chat').textContent=session?(session.title&&session.title!==session.id?session.title:'Current chat'):'Open a chat to start.';
  const status=voiceStatus(state,session?.id||null,starting&&(!enabled||state.phase==='off'));
  node('status').textContent=status.text;node('status').dataset.warming=String(status.warming);node('status').setAttribute('aria-busy',String(status.warming));
  toggle.update({label:enabled?'Stop voice':'Start conversation',disabled:!session||!directory||!state.configured||pending||!!state.checking});
  stop.update({disabled:!session||pending});check.update({disabled:!session||!state.configured||pending||!!state.checking});
  if(state.error)node('notice').textContent=state.error;
  if(state.result)node('notice').textContent=state.result.ok?'Speaker interruption passed.':'Speaker interruption failed: '+state.result.reason;
}
function change(path:string,extra:object){
  mutation=mutation.catch(()=>{}).then(async()=>{
    pending=true;starting=path==='/command'&&['on','check'].includes((extra as {command?:string}).command||'');
    if(starting){state.result=undefined;state.error=null;}paint();node('notice').textContent='';
    try{state=await request(path,'POST',extra);paint();}
    catch(error){notice(error instanceof Error?error:new Error('Voice control failed'));}
    finally{pending=false;starting=false;paint();}
  });
}
const toggle=mountButton(node('actions'),{label:'Start conversation',disabled:true,onClick:()=>change('/command',{command:state.enabled&&state.sessionID===session?.id?'off':'on'})});
const stop=mountButton(node('actions'),{label:'Interrupt reply',variant:'secondary',disabled:true,onClick:()=>change('/command',{command:'stop'})});
const input=mountSelect(node('audio'),{label:'Microphone',value:'default',options:[],searchable:true,onChange:inputDevice=>{input.update({value:inputDevice});change('/devices',{inputDevice});}});
const output=mountSelect(node('audio'),{label:'Output device',value:'default',options:[],searchable:true,onChange:outputDevice=>{output.update({value:outputDevice});change('/devices',{outputDevice});}});
const check=mountButton(node('check'),{label:'Test speaker interruption',variant:'outline',disabled:true,onClick:()=>change('/command',{command:'check'})});
mountButton(node('check'),{label:'Refresh devices',variant:'ghost',onClick:()=>{void devices();}});
const keep=mountSwitch(node('background'),{label:'Keep running when hidden',checked:false,description:'Voice continues while you look at other panels or the agent opens a file. Closing the Voice tab still stops it.',onChange:checked=>{keepRunning=checked;keep.update({checked});void host.storage.set(KEEP_KEY,checked).catch(()=>{});}});
void host.storage.get(KEEP_KEY).then(value=>{keepRunning=value===true;keep.update({checked:keepRunning});}).catch(()=>{});
async function devices(){
  try{state=await request('/devices');input.update({value:state.inputDevice,options:(state.input||[]).map(item=>({id:item.id,label:item.name}))});output.update({value:state.outputDevice,options:(state.output||[]).map(item=>({id:item.id,label:item.name}))});paint();}
  catch(error){notice(error instanceof Error?error:new Error('Audio devices are unavailable'));}
}
host.onReady(context=>{applyHostReady(context,document.documentElement);directory=context.directory;session=context.session;if(!mounted){mounted=true;void devices();}});
host.onDirectory(next=>{directory=next;if(mounted)void devices();});
host.onSession(next=>{const changed=next?.id!==session?.id;session=next;paint();if(changed&&mounted&&directory)void request('/state').then(value=>{state=value;paint();}).catch(error=>notice(error instanceof Error?error:new Error('Voice paused')));});
function pauseHidden(){if(!keepRunning&&mounted&&directory)void request('/pause').catch(()=>{});}
// The host keeps rail pages mounted while hidden. Observe our own panel's
// visibility so a kept-alive page cannot keep the microphone active, unless
// the user turned on "Keep running when hidden".
new IntersectionObserver(entries=>{
  const next=entries.some(entry=>entry.isIntersecting);
  if(visible&&!next)pauseHidden();visible=next;
  if(visible&&mounted&&directory)void request('/state').then(value=>{state=value;paint();}).catch(()=>{});
}).observe(document.documentElement);
document.addEventListener('visibilitychange',()=>{if(document.hidden)pauseHidden();});
// The native SDK supplies the selected chat. A heartbeat also releases audio
// after this panel closes or disconnects, without reading any windows or drafts.
setInterval(()=>{
  if(!mounted||!directory||refreshing)return;
  if(!keepRunning&&(!visible||document.hidden))return;refreshing=true;
  void request('/state').then(value=>{state=value;paint();}).catch(error=>notice(error instanceof Error?error:new Error('Voice disconnected'))).finally(()=>refreshing=false);
},1000);
