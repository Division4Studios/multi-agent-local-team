import { createHmac, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { resolve } from 'node:path';

/** Key separation lets local clients verify the feed without learning the SecretStorage note-signing key. */
const privateKey=(noteKey:Buffer):KeyObject=>{
  const seed=createHmac('sha256',noteKey).update('MALT architecture guidance / Ed25519 / v1').digest();
  return createPrivateKey({format:'der',type:'pkcs8',key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),seed])});
};
export const feedVerifier=(noteKey:Buffer):string=>createPublicKey(privateKey(noteKey)).export({format:'der',type:'spki'}).toString('base64');
const payload=(root:string,data:unknown):Buffer=>Buffer.from(JSON.stringify([resolve(root),data]));
export const signFeed=(noteKey:Buffer,root:string,data:unknown):string=>sign(null,payload(root,data),privateKey(noteKey)).toString('base64');
export const verifyFeed=(verifier:string,root:string,data:unknown,signature:string):boolean=>{
  const key=createPublicKey({key:Buffer.from(verifier,'base64'),format:'der',type:'spki'});
  return key.asymmetricKeyType==='ed25519'&&verify(null,payload(root,data),key,Buffer.from(signature,'base64'));
};
