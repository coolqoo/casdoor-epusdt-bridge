import { md5 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const encoder = new TextEncoder();
export interface GcEnvelope { op:string; xmpch:string; version:string; data:string; requesttime:string; sign:string; }
export const digest = (text:string) => bytesToHex(sha256(encoder.encode(text)));
export const mac = (text:string,secret:string) => bytesToHex(hmac(sha256,encoder.encode(secret),encoder.encode(text)));
export function equal(a:string,b:string) {
  if(a.length!==b.length)return false;
  let different=0;for(let i=0;i<a.length;i++)different|=a.charCodeAt(i)^b.charCodeAt(i);
  return different===0;
}
export function gcSign(body:Omit<GcEnvelope,'sign'>,secret:string) {
  const value=`data=${body.data}&op=${body.op}&requesttime=${body.requesttime}&version=${body.version}&xmpch=${body.xmpch}${secret}`;
  return bytesToHex(md5(encoder.encode(value))).toUpperCase();
}
export function gmpaySign(body:Record<string,unknown>,secret:string) {
  const canonical=Object.keys(body).filter(k=>k!=='signature'&&body[k]!==''&&body[k]!==null&&body[k]!==undefined).sort().map(k=>{
    const value=body[k];
    if(!['string','number','boolean'].includes(typeof value)||typeof value==='number'&&!Number.isFinite(value))throw new Error('Invalid signed value');
    return `${k}=${String(value)}`;
  }).join('&');
  return mac(canonical,secret);
}
export function encodeData(value:unknown) {
  return btoa(String.fromCharCode(...encoder.encode(JSON.stringify(value))));
}
export function decodeData(value:string):Record<string,unknown> {
  const decoded=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(value),c=>c.charCodeAt(0))));
  if(!decoded||typeof decoded!=='object'||Array.isArray(decoded))throw new Error('Invalid GC data');
  return decoded;
}
export function cents(value:unknown) {
  const text=String(value);
  if(!/^\d+(\.\d{1,2})?$/.test(text))throw new Error('Invalid amount');
  const [a,b='']=text.split('.'),result=Number(a)*100+Number(b.padEnd(2,'0'));
  if(!Number.isSafeInteger(result)||result<1||result>100_000_000)throw new Error('Invalid amount');
  return result;
}
export const money=(value:number)=>(value/100).toFixed(2);
export const orderId=(merchant:string,payment:string)=>digest(`${merchant}\0${payment}`).slice(0,32);
export const notificationProof=(merchant:string,payment:string,amount:number,secret:string)=>mac(`gc-notify-v1\0${merchant}\0${payment}\0${amount}`,secret);
