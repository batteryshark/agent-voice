import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {controlSocket} from '../openchamber-control.mjs';
const port=Number(process.env.OPENCHAMBER_SERVICE_PORT),token=process.env.OPENCHAMBER_SERVICE_TOKEN;
if(!port||!token)throw new Error('OpenChamber must launch the Voice service.');
const socket=JSON.parse(process.env.OPENCHAMBER_SERVICE_SOCKETS||'{}').voice||controlSocket();
function authorized(header){const actual=Buffer.from(header||''),expected=Buffer.from('Bearer '+token);return actual.length===expected.length&&timingSafeEqual(actual,expected);}
const server=http.createServer(async(req,res)=>{
  const respond=(status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
  if(!authorized(req.headers.authorization))return respond(401,{error:'Unauthorized'});
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/health')return respond(200,{ready:true});
  if(!['/state','/devices','/voices','/command','/pause'].includes(url.pathname))return respond(404,{error:'Unknown voice control'});
  try{
    let body='';for await(const chunk of req){body+=chunk;if(body.length>8192)throw new Error('Voice control request exceeds limit.');}
    const input=req.method==='GET'?Object.fromEntries(url.searchParams):JSON.parse(body||'{}');
    const data=JSON.stringify(input),method=req.method==='GET'?'GET':'POST';
    const result=await new Promise((resolve,reject)=>{
      const call=http.request({socketPath:socket,path:url.pathname,method,headers:{'content-type':'application/json','content-length':Buffer.byteLength(data)}},response=>{
        let value='';response.on('data',chunk=>{value+=chunk;if(value.length>65536)call.destroy(new Error('Voice response exceeds limit.'));});
        response.on('end',()=>{try{resolve({status:response.statusCode,body:JSON.parse(value)});}catch{reject(new Error('The native voice plugin returned an invalid response.'));}});response.on('error',reject);
      });
      call.setTimeout(17000,()=>call.destroy(new Error('Voice control timed out.')));call.on('error',reject);call.end(data);
    });
    respond(result.status,result.body);
  }catch(error){respond(503,{error:error.code==='ENOENT'||error.code==='ECONNREFUSED'?'The native voice plugin is unavailable. Enable agent-voice in OpenCode and reopen this panel.':error.message});}
});
server.listen(port,'127.0.0.1');
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
