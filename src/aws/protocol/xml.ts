import { isRecord } from '../../shared/guards';
import type { ModelMember, ServiceModel } from '../models/model';
import { flattened, namespace, shape, wireName } from './models';
import { list, record } from './values';
import type { AwsError } from './errors';

export const escapeXml = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;').replaceAll('\r', '&#13;');
const element = (name: string, value: string): string => `<${name}>${value}</${name}>`;
interface XmlValue { readonly member: ModelMember; readonly name: string; readonly value: unknown }
const encode = (model: ServiceModel, input: XmlValue): string => {
  const definition = shape(model, input.member.target);
  if (definition.type === 'list') {
    const items = list(input.value).map(value => encode(model, { member: definition.member,
      name: flattened(input.member.traits) ? input.name : wireName(definition.member, 'member'), value })).join('');
    return flattened(input.member.traits) ? items : element(input.name, items);
  }
  if (definition.type === 'map') {
    const items = Object.entries(record(input.value)).map(([key, value]) => element(flattened(input.member.traits) ? input.name : 'entry',
      encode(model, { member: definition.key, name: wireName(definition.key, 'key'), value: key })
      + encode(model, { member: definition.value, name: wireName(definition.value, 'value'), value }))).join('');
    return flattened(input.member.traits) ? items : element(input.name, items);
  }
  if (definition.type === 'structure') { return element(input.name, structureXml(model, input.member.target, record(input.value))); }
  return element(input.name, escapeXml(String(input.value)));
};
export const structureXml = (model: ServiceModel, target: string, value: Readonly<Record<string, unknown>>): string => {
  const definition = shape(model, target);
  if (definition.type !== 'structure') { throw new Error('Expected modeled output structure'); }
  return Object.entries(definition.members).flatMap(([name, member]) => !Object.hasOwn(value, name) ? []
    : [encode(model, { member, name: wireName(member, name), value: value[name] })]).join('');
};
export const queryResponse = (model: ServiceModel, operation: string, contents: string | undefined, id: string): string =>
  `<${operation}Response xmlns="${namespace(model)}">${contents === undefined ? '' : element(`${operation}Result`, contents)}`
  + `${element('ResponseMetadata', element('RequestId', escapeXml(id)))}</${operation}Response>`;
export const queryFault = (error: AwsError, id: string, model?: ServiceModel): { readonly status: number; readonly body: string } => {
  const traits = model === undefined || error.code === 'UnsupportedOperation' ? undefined : modelErrorTraits(model, error.code);
  const code = typeof traits?.['code'] === 'string' ? traits['code'] : error.code;
  const status = typeof traits?.['httpResponseCode'] === 'number' ? traits['httpResponseCode'] : error.statusCode;
  const detail = element('Error', element('Type', error.fault) + element('Code', escapeXml(code)) + element('Message', escapeXml(error.message)));
  return { status, body: `<ErrorResponse${model === undefined ? '' : ` xmlns="${namespace(model)}"`}>${detail}`
    + `${element('RequestId', escapeXml(id))}</ErrorResponse>` };
};
const modelErrorTraits = (model: ServiceModel, code: string): Readonly<Record<string, unknown>> | undefined => {
  // Unknown local errors deliberately retain their local code and status.
  const pending = [model.shapes];
  for (const catalog of pending) {
    for (const table of catalog.tables) {
      const found = table[`com.amazonaws.${model.signingName}#${code}`];
      const trait = found?.traits['aws.protocols#awsQueryError'];
      if (isRecord(trait)) { return trait; }
    }
    pending.push(...catalog.children);
  }
  return undefined;
};
