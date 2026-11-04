import { createHmac, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { resolve } from 'node:path';

/** Key separation lets local clients verify the feed without learning the SecretStorage note-signing key. */
const privateKey = (noteKey: Buffer): KeyObject => {
  const seed = createHmac('sha256', noteKey).update('MALT architecture guidance / Ed25519 / v1').digest();
  return createPrivateKey({
    format: 'der',
    type: 'pkcs8',
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
  });
};
export const feedVerifier = (noteKey: Buffer): string =>
  createPublicKey(privateKey(noteKey)).export({ format: 'der', type: 'spki' }).toString('base64');
const payload = (root: string, data: unknown): Buffer => Buffer.from(JSON.stringify([resolve(root), data]));
export const signFeed = (noteKey: Buffer, root: string, data: unknown): string =>
  sign(null, payload(root, data), privateKey(noteKey)).toString('base64');
const verifySigned = (verifier: string, message: Buffer, signature: string): boolean => {
  try {
    const key = createPublicKey({ key: Buffer.from(verifier, 'base64'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ed25519' && verify(null, message, key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
};
export const verifyFeed = (verifier: string, root: string, data: unknown, signature: string): boolean =>
  verifySigned(verifier, payload(root, data), signature);

/**
 * The reviewer map (`.malt/maps/v1/reviewer.json`) is signed with the same key under its own context, so a feed
 * signature can never pass as a map signature. It is not bound to the workspace path because the Docker reviewer
 * sees the workspace at /workspace; each developer confirmation in it is bound to its file's content instead.
 */
const mapPayload = (data: unknown): Buffer => Buffer.from(JSON.stringify(['MALT reviewer map / v1', data]));
export const signMap = (noteKey: Buffer, data: unknown): string => sign(null, mapPayload(data), privateKey(noteKey)).toString('base64');
export const verifyMap = (verifier: string, data: unknown, signature: string): boolean => verifySigned(verifier, mapPayload(data), signature);
