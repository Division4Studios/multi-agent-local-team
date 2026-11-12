import type { ServerResponse } from 'node:http';
import type { ServiceModel } from '../models/model';
import { AwsError } from '../protocol/errors';
import { queryFault } from '../protocol/xml';

export const jsonResponse = (response: ServerResponse, status: number, value: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
};
export const awsFailure = (response: ServerResponse, error: unknown, wire: { readonly json: boolean; readonly id: string; readonly model?: ServiceModel }): number => {
  const fault = error instanceof AwsError ? error : new AwsError('InternalFailure', `Internal failure; reference ${wire.id}`, 500, 'Receiver');
  response.setHeader('x-amzn-requestid', wire.id);
  if (wire.json) {
    response.writeHead(fault.statusCode, { 'content-type': 'application/x-amz-json-1.0', 'x-amzn-errortype': fault.code });
    response.end(JSON.stringify({ __type: fault.code, message: fault.message }));
    return fault.statusCode;
  }
  const result = queryFault(fault, wire.id, wire.model);
  response.writeHead(result.status, { 'content-type': 'text/xml; charset=utf-8' });
  response.end(result.body);
  return result.status;
};
