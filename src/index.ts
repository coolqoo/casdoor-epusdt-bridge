import { cents,decodeData,encodeData,equal,gcSign,gmpaySign,money,notificationProof,orderId,type GcEnvelope } from './protocol.ts';

export interface Env { BRIDGE_ORIGIN:string; MERCHANTS_JSON:string; }
export interface Merchant {
  gcClientId:string;gcSecret:string;casdoorOrigin:string;organization:string;
  gmpayOrigin:string;gmpayPid:string;gmpaySecret:string;currency:string;returnOrigins?:string[];
}
class Failure extends Error {
  readonly status:number;
  readonly code:string;
  constructor(status:number,code:string,message:string){super(message);this.status=status;this.code=code;}
}
function origin(value:string) {
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('HTTPS origin required');
  return url.origin;
}
function merchantConfig(env:Env,key:string):Merchant {
  try {
    const merchants=JSON.parse(env.MERCHANTS_JSON) as Record<string,Merchant>;
    if(!/^[A-Za-z0-9_-]{1,64}$/.test(key)||!Object.hasOwn(merchants,key))throw new Failure(404,'MERCHANT_NOT_FOUND','Unknown merchant');
    const value=merchants[key];
    for(const name of ['gcClientId','gcSecret','casdoorOrigin','organization','gmpayOrigin','gmpayPid','gmpaySecret','currency'] as const)if(typeof value[name]!=='string'||!value[name])throw new Error('Missing merchant configuration');
    origin(env.BRIDGE_ORIGIN);origin(value.casdoorOrigin);origin(value.gmpayOrigin);
    if(!/^[A-Za-z0-9_.-]{1,100}$/.test(value.organization)||(value.returnOrigins!==undefined&&(!Array.isArray(value.returnOrigins)||!value.returnOrigins.every(v=>origin(v)===v)))||!/^[A-Z]{3}$/.test(value.currency))throw new Error('Invalid merchant configuration');
    return value;
  } catch(error) {
    if(error instanceof Failure)throw error;
    throw new Failure(503,'CONFIGURATION_ERROR','Bridge configuration is incomplete');
  }
}
async function json(request:Request) {
  if(Number(request.headers.get('Content-Length')||0)>65536)throw new Failure(413,'BODY_TOO_LARGE','Request too large');
  const raw=await request.text();if(raw.length>65536)throw new Failure(413,'BODY_TOO_LARGE','Request too large');
  try {const value=JSON.parse(raw);if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return value as Record<string,unknown>;}
  catch{throw new Failure(400,'INVALID_REQUEST','JSON object required');}
}
async function fetchUpstream(url:URL|string,init:RequestInit={}) {
  try{return await fetch(url,{...init,signal:AbortSignal.timeout(8000),redirect:'manual'});}
  catch{throw new Failure(502,'UPSTREAM_UNCONFIRMED','Upstream result is unknown; do not create a replacement order');}
}
const paymentName=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
function notifyTarget(m:Merchant,payment:string) {
  return new URL(`/api/notify-payment/${encodeURIComponent(m.organization)}/${encodeURIComponent(payment)}`,m.casdoorOrigin).href;
}
async function create(request:Request,env:Env,key:string,m:Merchant) {
  const raw=await json(request);
  for(const field of ['op','xmpch','version','data','requesttime','sign'])if(typeof raw[field]!=='string')throw new Failure(400,'INVALID_REQUEST','Invalid GC envelope');
  const input=raw as unknown as GcEnvelope;
  if(input.xmpch!==m.gcClientId||!equal(input.sign.toUpperCase(),gcSign(input,m.gcSecret)))throw new Failure(401,'INVALID_SIGNATURE','Invalid GC signature');
  if(input.op!=='OrderCreate'||input.version!=='1.4')throw new Failure(400,'UNSUPPORTED_OPERATION','Only GC 1.4 OrderCreate is supported');
  let data:Record<string,unknown>,amount:number;
  try{data=decodeData(input.data);amount=cents(data.amount);}catch{throw new Failure(400,'INVALID_REQUEST','Invalid GC order data or amount');}
  if(!paymentName(data.orderno)||data.xmpch!==m.gcClientId||data.notify_url!==notifyTarget(m,data.orderno))throw new Failure(400,'INVALID_CALLBACK','Unexpected payment name or Casdoor notification URL');
  let redirect:URL;
  try{redirect=new URL(String(data.return_url));}catch{throw new Failure(400,'INVALID_RETURN_URL','Invalid return URL');}
  if(redirect.protocol!=='https:'||redirect.username||redirect.password||![m.casdoorOrigin,...m.returnOrigins||[]].includes(redirect.origin))throw new Failure(400,'INVALID_RETURN_URL','Return origin is not allowed');
  const payment=data.orderno,id=orderId(key,payment),proof=notificationProof(key,payment,amount,m.gmpaySecret);
  const notification=new URL(`/gmpay/notify/${key}/${encodeURIComponent(payment)}/${amount}/${proof}`,env.BRIDGE_ORIGIN).href;
  const params:Record<string,unknown>={pid:m.gmpayPid,order_id:id,currency:m.currency.toLowerCase(),amount:money(amount),notify_url:notification,redirect_url:redirect.href,name:String(data.body||'Casdoor payment').slice(0,200)};
  const response=await fetchUpstream(new URL('/payments/gmpay/v1/order/create-transaction',m.gmpayOrigin),{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(Object.entries({...params,signature:gmpaySign(params,m.gmpaySecret)}).map(([k,v])=>[k,String(v)]))});
  let result:{status_code:number;data?:{order_id:string;trade_id:string;payment_url:string;amount:unknown;currency:string}};
  try{result=await response.json();}catch{throw new Failure(502,'UPSTREAM_UNCONFIRMED','Invalid gateway response; do not create a replacement order');}
  if(!response.ok||result.status_code!==200)throw new Failure(502,'GATEWAY_REJECTED',`Gateway rejected order (status ${result.status_code}); duplicate orders are not replaced`);
  const order=result.data;
  try {
    if(!order||order.order_id!==id||!paymentName(order.trade_id)||cents(order.amount)!==amount||order.currency.toUpperCase()!==m.currency)throw new Error();
    const url=new URL(order.payment_url);if(url.origin!==m.gmpayOrigin||url.username||url.password)throw new Error();
    return Response.json({op:input.op,xmpch:m.gcClientId,version:'1.4',return_code:'SUCCESS',return_msg:'',data:encodeData({jylsh:order.trade_id,amount:money(amount),payerid:String(data.payerid||''),payername:String(data.payername||''),payurl:url.href})});
  }catch{throw new Failure(502,'UPSTREAM_UNCONFIRMED','Gateway response mismatch; do not create a replacement order');}
}
async function notify(request:Request,key:string,payment:string,amountString:string,proof:string,m:Merchant) {
  const amount=Number(amountString);
  if(!paymentName(payment)||!/^\d+$/.test(amountString)||!Number.isSafeInteger(amount)||amount<1||amount>100_000_000||!equal(proof,notificationProof(key,payment,amount,m.gmpaySecret)))throw new Failure(400,'INVALID_CONTEXT','Invalid notification context');
  const input=await json(request);
  if(typeof input.signature!=='string'||!/^[a-f0-9]{64}$/.test(input.signature)||!equal(input.signature,gmpaySign(input,m.gmpaySecret)))throw new Failure(401,'INVALID_SIGNATURE','Invalid GMPay signature');
  if(String(input.pid)!==m.gmpayPid||input.order_id!==orderId(key,payment)||input.status!==2||!paymentName(input.trade_id))throw new Failure(400,'INVALID_PAYMENT','Notification does not match the payment');
  try{if(cents(input.amount)!==amount)throw new Error();}catch{throw new Failure(400,'AMOUNT_MISMATCH','Payment amount mismatch');}
  const response=await fetchUpstream(new URL(`/pay/checkout-counter-resp/${encodeURIComponent(input.trade_id)}`,m.gmpayOrigin));
  try {
    const info=await response.json() as {status_code:number;data:{status:number;currency:string;amount:unknown}};
    if(!response.ok||info.status_code!==200||info.data.status!==2||info.data.currency.toUpperCase()!==m.currency||cents(info.data.amount)!==amount)throw new Error();
  }catch{throw new Failure(502,'PAYMENT_UNCONFIRMED','Gateway did not confirm this payment');}
  const time=new Date().toISOString().replace(/\D/g,'').slice(0,14);
  const envelope:Omit<GcEnvelope,'sign'>={op:'OrderNotify',xmpch:m.gcClientId,version:'1.4',requesttime:time,data:encodeData({xmpch:m.gcClientId,orderdate:time,orderno:payment,amount:amount/100,jylsh:input.trade_id,tradeno:input.trade_id,paymethod:'GMPay',orderstate:'1',return_type:'1',payerid:'',payername:''})};
  const delivered=await fetchUpstream(notifyTarget(m,payment),{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...envelope,sign:gcSign(envelope,m.gcSecret)})});
  if(delivered.status!==200||(await delivered.text()).trim()!=='success')throw new Failure(502,'CASDOOR_NOT_ACKNOWLEDGED','Casdoor did not acknowledge payment; gateway must retry');
  return new Response('ok');
}
export default {
  async fetch(request:Request,env:Env):Promise<Response> {
    let response:Response;
    try {
      const url=new URL(request.url);
      if(url.pathname==='/healthz'&&request.method==='GET')return Response.json({ok:true,version:'0.1.0'});
      if(request.method!=='POST')throw new Failure(405,'METHOD_NOT_ALLOWED','POST required');
      const parts=url.pathname.split('/').filter(Boolean);
      if(parts[0]==='gc'&&parts.length===2)response=await create(request,env,parts[1],merchantConfig(env,parts[1]));
      else if(parts[0]==='gmpay'&&parts[1]==='notify'&&parts.length===6)response=await notify(request,parts[2],parts[3],parts[4],parts[5],merchantConfig(env,parts[2]));
      else throw new Failure(404,'NOT_FOUND','Endpoint not found');
    }catch(error) {
      const failure=error instanceof Failure?error:new Failure(400,'INVALID_REQUEST','Request could not be processed');
      response=Response.json({return_code:failure.code,return_msg:failure.message},{status:failure.status});
    }
    response.headers.set('Cache-Control','no-store');response.headers.set('X-Content-Type-Options','nosniff');response.headers.set('Referrer-Policy','no-referrer');
    return response;
  }
};
