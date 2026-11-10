import { afterEach,test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash,createHmac } from 'node:crypto';
import bridge,{type Env,type Merchant} from '../src/index.ts';
import { decodeData,encodeData,gcSign,gmpaySign,notificationProof,orderId } from '../src/protocol.ts';

const merchant:Merchant={gcClientId:'app-one',gcSecret:'fixture-gc-secret',casdoorOrigin:'https://auth.example.com',organization:'example',gmpayOrigin:'https://pay.example.com',gmpayPid:'1000',gmpaySecret:'fixture-gmpay-secret',currency:'USD'};
const env:Env={BRIDGE_ORIGIN:'https://bridge.example.com',MERCHANTS_JSON:JSON.stringify({one:merchant,two:{...merchant,gcClientId:'app-two',gcSecret:'another-secret'}})};
const payment='payment_202611090001',amount=1299;
const actualFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=actualFetch;});
function request(overrides:Record<string,unknown>={},envelopeOverrides:Record<string,unknown>={}) {
  const data={orderno:payment,orderdate:'20261109120000',amount:'12.99',xmpch:merchant.gcClientId,body:'测试套餐',notify_url:`${merchant.casdoorOrigin}/api/notify-payment/example/${payment}`,return_url:`${merchant.casdoorOrigin}/payments/example/${payment}/result`,...overrides};
  const envelope={op:'OrderCreate',xmpch:merchant.gcClientId,version:'1.4',requesttime:'20261109120000',data:encodeData(data),...envelopeOverrides};
  return new Request('https://bridge.example.com/gc/one',{method:'POST',body:JSON.stringify({...envelope,sign:gcSign(envelope,merchant.gcSecret),...(envelopeOverrides.sign?{sign:envelopeOverrides.sign}:{})})});
}
const gatewayOrder=()=>({status_code:200,data:{order_id:orderId('one',payment),trade_id:'trade_123',amount:12.99,currency:'USD',payment_url:'https://pay.example.com/pay/checkout-counter/trade_123'}});
function notification(overrides:Record<string,unknown>={},url?:string) {
  const body={pid:'1000',order_id:orderId('one',payment),trade_id:'trade_123',amount:12.99,status:2,...overrides};
  return new Request(url||`https://bridge.example.com/gmpay/notify/one/${payment}/${amount}/${notificationProof('one',payment,amount,merchant.gmpaySecret)}`,{method:'POST',body:JSON.stringify({...body,signature:gmpaySign(body,merchant.gmpaySecret)})});
}
test('GC and GMPay signatures agree with independent Node crypto implementations',()=>{
  const envelope={op:'OrderCreate',xmpch:'app-one',version:'1.4',requesttime:'20261109120000',data:encodeData({body:'中文 / €'})};
  const expected=createHash('md5').update(`data=${envelope.data}&op=OrderCreate&requesttime=20261109120000&version=1.4&xmpch=app-one${merchant.gcSecret}`).digest('hex').toUpperCase();
  assert.equal(gcSign(envelope,merchant.gcSecret),expected);
  const params={pid:'1000',amount:'12.99',empty:'',zero:0};
  assert.equal(gmpaySign(params,merchant.gmpaySecret),createHmac('sha256',merchant.gmpaySecret).update('amount=12.99&pid=1000&zero=0').digest('hex'));
  assert.deepEqual(decodeData(envelope.data),{body:'中文 / €'});
});
test('translates a signed GC order into the documented GMPay form without storing state',async()=>{
  let calls=0;
  globalThis.fetch=async(input,options)=>{
    calls++;assert.equal(options?.redirect,'manual');assert.equal(String(input),'https://pay.example.com/payments/gmpay/v1/order/create-transaction');
    const form=new URLSearchParams(String(options?.body));
    assert.equal(form.get('order_id'),orderId('one',payment));assert.equal(form.get('order_id')?.length,32);
    assert.equal(form.get('amount'),'12.99');assert.equal(form.get('currency'),'usd');
    assert.equal(form.get('name'),'测试套餐');assert.match(form.get('notify_url')!,/\/gmpay\/notify\/one\/payment_202611090001\/1299\//);
    return Response.json(gatewayOrder());
  };
  const response=await bridge.fetch(request(),env);assert.equal(response.status,200);
  const result=await response.json() as {return_code:string;data:string};assert.equal(result.return_code,'SUCCESS');
  assert.equal(decodeData(result.data).payurl,'https://pay.example.com/pay/checkout-counter/trade_123');assert.equal(calls,1);
});
test('rejects bad signatures and untrusted callbacks before contacting the gateway',async()=>{
  globalThis.fetch=async()=>{throw new Error('must not fetch');};
  assert.equal((await bridge.fetch(request({}, {sign:'bad'}),env)).status,401);
  assert.equal((await bridge.fetch(request({notify_url:'https://other.example.com/notify'}),env)).status,400);
  assert.equal((await bridge.fetch(request({return_url:'https://other.example.com/result'}),env)).status,400);
  assert.equal((await bridge.fetch(request({amount:'1.999'}),env)).status,400);
  assert.equal((await bridge.fetch(request({}, {op:'InvoiceEBillByOrder'}),env)).status,400);
});
test('does not retry or replace a duplicate or uncertain order',async()=>{
  let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({status_code:10010,message:'order already exists'},{status:400});};
  let response=await bridge.fetch(request(),env);assert.equal(response.status,502);assert.match(await response.text(),/GATEWAY_REJECTED/);assert.equal(calls,1);
  globalThis.fetch=async()=>{calls++;throw new Error('timeout');};
  response=await bridge.fetch(request(),env);assert.equal(response.status,502);assert.match(await response.text(),/UPSTREAM_UNCONFIRMED/);assert.equal(calls,2);
});
test('only acknowledges GMPay after Casdoor acknowledges the signed GC notification',async()=>{
  let acknowledged=false,forwards=0;
  globalThis.fetch=async(input,options)=>{
    if(String(input).includes('/pay/checkout-counter-resp/'))return Response.json({status_code:200,data:{status:2,amount:12.99,currency:'USD'}});
    assert.equal(String(input),`https://auth.example.com/api/notify-payment/example/${payment}?organization=example`);
    const form=Object.fromEntries(new URLSearchParams(String(options?.body))) as unknown as Parameters<typeof gcSign>[0]&{sign:string};
    assert.equal(form.sign,gcSign(form,merchant.gcSecret));
    assert.equal(decodeData(form.data).orderno,payment);assert.equal(decodeData(form.data).amount,12.99);assert.equal(decodeData(form.data).orderstate,'1');
    forwards++;return new Response(acknowledged?'success':'fail');
  };
  assert.equal((await bridge.fetch(notification(),env)).status,502);
  acknowledged=true;
  assert.equal(await (await bridge.fetch(notification(),env)).text(),'ok');
  assert.equal(await (await bridge.fetch(notification(),env)).text(),'ok');assert.equal(forwards,3);
});
test('rejects forged context, cross-merchant replay and mismatched amounts',async()=>{
  let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('must not forward');};
  assert.equal((await bridge.fetch(notification({amount:12.98}),env)).status,400);
  assert.equal((await bridge.fetch(notification({pid:'1001'}),env)).status,400);
  const path=`https://bridge.example.com/gmpay/notify/two/${payment}/${amount}/${notificationProof('one',payment,amount,merchant.gmpaySecret)}`;
  assert.equal((await bridge.fetch(notification({},path),env)).status,400);
  assert.equal(calls,0);
});
test('does not forward a signed callback if the authoritative currency or state differs',async()=>{
  globalThis.fetch=async()=>Response.json({status_code:200,data:{status:2,amount:12.99,currency:'EUR'}});
  assert.equal((await bridge.fetch(notification(),env)).status,502);
});
test('gateway retries can recover callback timeouts and incorrect acknowledgements',async()=>{
  for(const failure of ['timeout','json','redirect','status']){
    globalThis.fetch=async(input,options)=>{
      assert.equal(options?.redirect,'manual');
      if(String(input).includes('/pay/checkout-counter-resp/'))return Response.json({status_code:200,data:{status:2,amount:12.99,currency:'USD'}});
      if(failure==='timeout')throw new Error('callback timed out');
      if(failure==='json')return Response.json({status:'ok'});
      if(failure==='redirect')return new Response(null,{status:302,headers:{Location:'https://untrusted.example.com'}});
      return new Response('success',{status:503});
    };
    assert.equal((await bridge.fetch(notification(),env)).status,502);
  }
  globalThis.fetch=async input=>String(input).includes('/pay/checkout-counter-resp/')?Response.json({status_code:200,data:{status:2,amount:12.99,currency:'USD'}}):new Response('success');
  assert.equal(await (await bridge.fetch(notification(),env)).text(),'ok');
});
test('isolates successful creation between integrations sharing a gateway account',async()=>{
  const original=await request().json() as any,second={...merchant,gcClientId:'app-two',gcSecret:'another-secret'};
  original.xmpch=second.gcClientId;original.data=encodeData({...decodeData(original.data),xmpch:second.gcClientId});original.sign=gcSign(original,second.gcSecret);
  let secondId='';globalThis.fetch=async(_input,options)=>{
    const form=new URLSearchParams(String(options?.body));secondId=form.get('order_id')!;
    assert.equal(secondId,orderId('two',payment));assert.notEqual(secondId,orderId('one',payment));
    return Response.json({...gatewayOrder(),data:{...gatewayOrder().data,order_id:secondId}});
  };
  const response=await bridge.fetch(new Request('https://bridge.example.com/gc/two',{method:'POST',body:JSON.stringify(original)}),env);
  assert.equal(response.status,200);assert.equal(secondId.length,32);
});
