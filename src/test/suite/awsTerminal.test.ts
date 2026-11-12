import assert from 'node:assert/strict';
import { terminalEnvironment } from '../../cloud/terminal';
import type { TestCase } from './harness';

export const tests: readonly TestCase[] = [
  {
    name: 'AWS terminal: dedicated terminals override endpoints and remove inherited credential selectors',
    run: (): void => {
      const inherited = { ...process.env };
      assert.deepEqual(terminalEnvironment('http://127.0.0.1:14567', 'eu-central-2'), {
        AWS_ENDPOINT_URL: 'http://127.0.0.1:14567',
        AWS_ENDPOINT_URL_STS: 'http://127.0.0.1:14567',
        AWS_ENDPOINT_URL_SQS: 'http://127.0.0.1:14567',
        AWS_ENDPOINT_URL_S3: 'http://127.0.0.1:14567',
        AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test',
        AWS_REGION: 'eu-central-2', AWS_DEFAULT_REGION: 'eu-central-2',
        AWS_EC2_METADATA_DISABLED: 'true', AWS_PAGER: '',
        AWS_SESSION_TOKEN: null, AWS_SECURITY_TOKEN: null, AWS_PROFILE: null, AWS_DEFAULT_PROFILE: null,
      });
      assert.deepEqual(process.env, inherited, 'the pure function must not change extension-host credentials');
    },
  },
  {
    name: 'AWS terminal: independent results follow the latest endpoint and arbitrary valid signing region',
    run: (): void => {
      const first = terminalEnvironment('http://127.0.0.1:4566', 'us-east-1');
      first['AWS_ACCESS_KEY_ID'] = 'changed-by-caller';
      const next = terminalEnvironment('http://127.0.0.1:4567', 'ap-southeast-7');
      assert.equal(next['AWS_ACCESS_KEY_ID'], 'test');
      assert.equal(next['AWS_REGION'], 'ap-southeast-7');
      assert.equal(next['AWS_ENDPOINT_URL'], 'http://127.0.0.1:4567');
      assert.equal(next['AWS_SESSION_TOKEN'], null);
      assert.equal(next['AWS_PROFILE'], null);
    },
  },
];
