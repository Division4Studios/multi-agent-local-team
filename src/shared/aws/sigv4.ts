/** Syntax-only credential routing. The request target is never URL-normalized. */
export interface SigningScope {
  readonly accessKeyId: string;
  readonly date: string;
  readonly region: string;
  readonly service: string;
}

const ALGORITHM = 'AWS4-HMAC-SHA256';
const HEADER_FIELDS = new Set(['Credential', 'SignedHeaders', 'Signature']);
const QUERY_FIELDS = new Set([
  'X-Amz-Algorithm', 'X-Amz-Credential', 'X-Amz-SignedHeaders', 'X-Amz-Signature',
]);

const scope = (credential: string | undefined): SigningScope | undefined => {
  if (credential === undefined) {
    return undefined;
  }
  const parts = /^([A-Za-z0-9]+)\/([0-9]{8})\/([a-z0-9-]+)\/([a-z0-9-]+)\/aws4_request$/u.exec(credential);
  if (parts?.[0] !== credential) {
    return undefined;
  }
  const [, accessKeyId, date, region, service] = parts;
  if (accessKeyId === undefined || date === undefined || region === undefined || service === undefined) {
    return undefined;
  }
  return { accessKeyId, date, region, service };
};

const validSignatureFields = (headers: string | undefined, signature: string | undefined): boolean => {
  if (headers === undefined || signature === undefined) {
    return false;
  }
  const token = /^[a-z0-9!#$%&'*+.^_`|~-]+$/u;
  return headers.split(';').every(name => token.exec(name)?.[0] === name)
    && signature.length === 64 && /^[a-fA-F0-9]{64}$/u.test(signature);
};

const queryEntry = (entry: string, fields: Map<string, string>): boolean => {
  const separator = entry.indexOf('=');
  const name = decodeURIComponent(separator < 0 ? entry : entry.slice(0, separator));
  const value = decodeURIComponent(separator < 0 ? '' : entry.slice(separator + 1));
  if (!QUERY_FIELDS.has(name)) {
    return true;
  }
  if (fields.has(name)) {
    return false;
  }
  fields.set(name, value);
  return true;
};

const queryFields = (rawTarget: string): ReadonlyMap<string, string> | undefined => {
  const fields = new Map<string, string>();
  const start = rawTarget.indexOf('?');
  if (start < 0) {
    return fields;
  }
  try {
    for (const entry of rawTarget.slice(start + 1).split('&')) {
      if (!queryEntry(entry, fields)) {
        return undefined;
      }
    }
    return fields;
  } catch {
    return undefined;
  }
};

const headerFields = (attributes: string): ReadonlyMap<string, string> | undefined => {
  const fields = new Map<string, string>();
  for (const attribute of attributes.split(',')) {
    const pair = /^[\t ]*(Credential|SignedHeaders|Signature)[\t ]*=[\t ]*([^\t ]+)[\t ]*$/u.exec(attribute);
    const name = pair?.[1];
    const value = pair?.[2];
    if (name === undefined || value === undefined || fields.has(name)) {
      return undefined;
    }
    fields.set(name, value);
  }
  return fields;
};

const headerScope = (authorization: string): SigningScope | undefined => {
  // Only horizontal whitespace is accepted, including around attribute '='.
  const match = /^[\t ]*AWS4-HMAC-SHA256[\t ]+([^\r\n]+)$/u.exec(authorization);
  const attributes = match?.[1];
  if (attributes === undefined || match?.[0] !== authorization) {
    return undefined;
  }
  const fields = headerFields(attributes);
  if (fields === undefined) {
    return undefined;
  }
  if (fields.size !== HEADER_FIELDS.size || !validSignatureFields(fields.get('SignedHeaders'), fields.get('Signature'))) {
    return undefined;
  }
  return scope(fields.get('Credential'));
};

export const parseSigningScope = (authorization: string | undefined, rawTarget: string): SigningScope | undefined => {
  const query = queryFields(rawTarget);
  if (query === undefined) {
    return undefined;
  }
  if (authorization !== undefined) {
    return query.size === 0 ? headerScope(authorization) : undefined;
  }
  if (query.size !== QUERY_FIELDS.size || query.get('X-Amz-Algorithm') !== ALGORITHM) {
    return undefined;
  }
  if (!validSignatureFields(query.get('X-Amz-SignedHeaders'), query.get('X-Amz-Signature'))) {
    return undefined;
  }
  return scope(query.get('X-Amz-Credential'));
};
