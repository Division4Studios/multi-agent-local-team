import { isAbsolute, extname } from 'node:path';
import { URL } from 'node:url';

export const CLI_IMAGE = 'public.ecr.aws/aws-cli/aws-cli:2.40.1@sha256:4ade0fe3e60e0b9e1fb0910f86c6d992baf4e12d3172c25a3c8c11f6c81cee08';
export const PYTHON_IMAGE = 'public.ecr.aws/lambda/python:3.13@sha256:d0acb0bce6c7b14a193a911f800bee8ff73fd28bc8d01e953db2f5aea32d270e';
export const CLI_VERSION = '2.40.1';
export const BOTO3_VERSION = '1.42.97';
export const ROOT_ACCOUNT = '000000000000';
export const RECEIPT_KIND = 'malt-aws-client-acceptance-v1';

export class Failure extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export function ensure(condition, code, message) {
  if (!condition) throw new Failure(code, message);
}
export const failure = (error) => error instanceof Failure
  ? { code: error.code, message: error.message } : { code: 'HARNESS', message: 'unexpected harness failure' };

export function receiptArgument(args) {
  const indexes = args.flatMap((value, index) => value === '--receipt' ? [index] : []);
  ensure(indexes.length === 1, 'ARGUMENTS', 'exactly one --receipt path is required');
  const file = args[indexes[0] + 1];
  ensure(typeof file === 'string' && isAbsolute(file) && extname(file) === '.json', 'ARGUMENTS', 'receipt must be an absolute owned .json path');
  return file;
}

function endpoint(value) {
  ensure(typeof value === 'string' && /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?\/?$/u.test(value),
    'ENVIRONMENT', 'AWS endpoint must be a loopback HTTP origin');
  let parsed;
  try { parsed = new URL(value); } catch { throw new Failure('ENVIRONMENT', 'invalid loopback endpoint port'); }
  ensure(parsed.port !== '0', 'ENVIRONMENT', 'endpoint port must identify an existing listener');
  return parsed.origin;
}

function terminalSettings(env) {
  const origin = endpoint(env.AWS_ENDPOINT_URL);
  ensure(env.AWS_ACCESS_KEY_ID === 'test' && env.AWS_SECRET_ACCESS_KEY === 'test', 'ENVIRONMENT', 'dummy access and secret keys are required');
  for (const name of ['AWS_SESSION_TOKEN', 'AWS_SECURITY_TOKEN', 'AWS_PROFILE', 'AWS_DEFAULT_PROFILE']) {
    ensure(!env[name], 'ENVIRONMENT', 'session tokens and profiles must be absent');
  }
  ensure(env.AWS_EC2_METADATA_DISABLED === 'true', 'ENVIRONMENT', 'instance metadata must be disabled');
  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION;
  ensure(typeof region === 'string' && /^[a-z0-9-]+$/u.test(region), 'ENVIRONMENT', 'a nonempty signing region is required');
  ensure(!env.AWS_REGION || !env.AWS_DEFAULT_REGION || env.AWS_REGION === env.AWS_DEFAULT_REGION, 'ENVIRONMENT', 'region variables disagree');
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith('AWS_ENDPOINT_URL_') && value) ensure(endpoint(value) === origin, 'ENVIRONMENT', 'service endpoint overrides disagree');
  }
  return { endpoint: origin, region };
}

export function configuration(args, env) {
  ensure(args.length === 4, 'ARGUMENTS', 'use --container <container-id> --receipt <absolute-path.json>');
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    ensure(['--container', '--receipt'].includes(args[index]) && !options.has(args[index]), 'ARGUMENTS', 'unknown or duplicate argument');
    options.set(args[index], args[index + 1]);
  }
  const container = options.get('--container');
  ensure(typeof container === 'string' && /^[a-f0-9]{64}$/u.test(container), 'ARGUMENTS', 'an explicit full 64-character gateway container ID is required');
  return { container, receipt: receiptArgument(args), ...terminalSettings(env) };
}

export function clientEnvironment(config) {
  return {
    AWS_ENDPOINT_URL: config.endpoint, AWS_REGION: config.region, AWS_DEFAULT_REGION: config.region,
    AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', AWS_EC2_METADATA_DISABLED: 'true',
    AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null', BOTO_CONFIG: '/dev/null',
    AWS_MAX_ATTEMPTS: '1', AWS_RETRY_MODE: 'standard', AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off',
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*', http_proxy: '', https_proxy: '', all_proxy: '', no_proxy: '*',
    HOME: '/tmp', PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1',
  };
}
