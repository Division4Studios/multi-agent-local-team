import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AwsTrace } from '../../shared/aws/types';
import type { CallContext, ServiceBackend } from '../services/types';
import { queryResponse, structureXml } from '../protocol/xml';
import { decodeCall, isJsonRequest, routeCall } from './decode';
import type { CallRoute, DecodedCall } from './decode';
import { awsFailure, jsonResponse } from './responses';

export class Gateway {
  public requestCount = 0;
  private readonly endpoint: string;
  private readonly backends: readonly ServiceBackend[];
  private readonly dirty: () => void;
  private readonly traces: AwsTrace[] = [];
  public constructor(endpoint: string, backends: readonly ServiceBackend[], dirty: () => void) {
    this.endpoint = endpoint; this.backends = backends; this.dirty = dirty;
  }
  private context(decoded: DecodedCall, id: string): CallContext {
    return { account: '000000000000', region: decoded.scope.region, principalArn: 'arn:aws:iam::000000000000:root',
      accessKeyId: decoded.scope.accessKeyId, traceId: id, emit: (): void => { this.dirty(); } };
  }
  public traceSnapshot(): readonly AwsTrace[] { return this.traces.map(trace => ({ ...trace })); }
  public async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === 'GET' && request.url === '/_health') {
      request.resume(); jsonResponse(response, 200, { status: 'running', services: ['sqs', 'sts'] }); return;
    }
    this.requestCount += 1;
    const id = randomUUID();
    const start = performance.now();
    let route: CallRoute | undefined;
    let decoded: DecodedCall | undefined;
    let statusCode = 200;
    try {
      route = routeCall(request);
      decoded = await decodeCall(request, this.endpoint, route);
      const backend = this.backends.find(item => item.service === decoded?.model.signingName);
      if (backend === undefined) { throw new Error('Missing service adapter'); }
      const result = await backend.handle(decoded.call, this.context(decoded, id));
      success(response, decoded, result, id);
    } catch (error) {
      request.resume();
      statusCode = awsFailure(response, error, { id, json: isJsonRequest(request), ...(route === undefined ? {} : { model: route.model }) });
    }
    if (decoded !== undefined) {
      const context = this.context(decoded, id);
      this.traces.unshift({ id, service: decoded.model.signingName, operation: decoded.call.operation,
        account: context.account, region: context.region, principalArn: context.principalArn, identity: 'default-root', statusCode,
        durationMs: Math.max(0, performance.now() - start), decision: decoded.model.signingName === 'sts' && decoded.call.operation === 'GetCallerIdentity'
          ? 'GetCallerIdentity permission exemption; local default root.' : 'Authorized local default root.' });
      this.traces.splice(200);
    }
  }
}
const success = (response: ServerResponse, decoded: DecodedCall, value: Readonly<Record<string, unknown>>, id: string): void => {
  const output = decoded.shape.output;
  const unit = output === undefined || output.target === 'smithy.api#Unit';
  response.setHeader('x-amzn-requestid', id);
  if (decoded.json) {
    response.writeHead(200, { 'content-type': 'application/x-amz-json-1.0' });
    response.end(unit ? '' : JSON.stringify(value));
  } else {
    const result = unit ? undefined : structureXml(decoded.model, output.target, value);
    response.writeHead(200, { 'content-type': 'text/xml; charset=utf-8' });
    response.end(queryResponse(decoded.model, decoded.call.operation, result, id));
  }
};
