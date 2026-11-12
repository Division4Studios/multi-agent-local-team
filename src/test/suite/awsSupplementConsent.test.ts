import assert from 'node:assert/strict';
import { AwsSocketConsent } from '../../cloud/socketConsent';
import type { TestCase } from './harness';
import { CONSENT_KEY as KEY, ConsentState, assertGrantFailure, assertGrantPersists } from './awsSupplementOracles';

export const tests: readonly TestCase[] = [
  {
    name: 'AWS supplement consent: only the exact version-one affirmative record at the exact key grants permission',
    run: (): void => {
      const state = new ConsentState();
      const consent = new AwsSocketConsent(state);
      const invalid: readonly unknown[] = [
        undefined, null, false, true, 1, 'true', [], {}, { granted: true }, { version: 1 },
        { version: 0, granted: true }, { version: 2, granted: true }, { version: '1', granted: true },
        { version: 1, granted: false }, { version: 1, granted: 'true' }, { version: 1, granted: true, extra: 'secret' },
      ];
      state.values.set('malt.aws.socketConsent', { version: 1, granted: true });
      for (const value of invalid) { state.values.set(KEY, value); assert.equal(consent.has(), false); }
      state.values.set(KEY, { version: 1, granted: true });
      assert.equal(consent.has(), true);
      state.values.set(KEY, false);
      assert.equal(consent.has(), false, 'permission must reflect storage, not a stale in-memory grant');
      assert.ok(state.reads.every(key => key === KEY));
      assert.equal(state.writes.length, 0, 'reading consent is not a grant');
    },
  },
  {
    name: 'AWS supplement consent: grant writes exactly the reviewed key/record and awaits persistence',
    run: async (): Promise<void> => {
      const state = new ConsentState();
      const consent = new AwsSocketConsent(state);
      await assertGrantPersists(consent, state);
    },
  },
  {
    name: 'AWS supplement consent: persistence failure rejects and never produces an in-memory permission grant',
    run: async (): Promise<void> => {
      const state = new ConsentState();
      const consent = new AwsSocketConsent(state);
      await assertGrantFailure(consent, state);
    },
  },
];
