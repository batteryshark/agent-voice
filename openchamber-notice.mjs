// OpenChamber supplies this authenticated callback to its managed OpenCode
// plugins. Use the app's own live notification channel; no UI automation.
export async function openChamberNotice(text,sessionID,{env=process.env,request=fetch}={}){
  const endpoint=env.OPENCHAMBER_AGENT_TOOL_URL,token=env.OPENCHAMBER_AGENT_TOOL_TOKEN;
  if(!endpoint||!token)return false;
  const response=await request(new URL('/api/notifications/emit',endpoint),{
    method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},
    body:JSON.stringify({title:'Voice',body:text.slice(0,500),sessionId:sessionID,showWhenFocused:true}),
    signal:AbortSignal.timeout(3000),
  });
  if(!response.ok)throw new Error('Native voice notice failed ('+response.status+')');
  const result=await response.json();
  return result.delivered===true;
}
