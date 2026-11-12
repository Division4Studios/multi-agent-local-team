import assert from 'node:assert/strict';
import type { AwsEndpoint } from '../../cloud/backend';
import type { TestCase } from './harness';
import { CommandFixture } from './awsCommandFixture';
import { withAws } from './awsTestFixtures';
import { fulfilled, observe } from './awsAsyncFixture';
import { assertDedicatedOptions } from './awsPortTerminalOracles';

export const tests: readonly TestCase[] = ['running', 'restarted'].map(initialState => ({
  name: `AWS dedicated terminal options: four null removals and native inheritance from ${initialState}`,
  run: async (): Promise<void> => {
    await withAws(async fixture => {
      const restarted = initialState === 'restarted';
      const endpoint: AwsEndpoint = restarted
        ? { gatewayUrl: 'http://127.0.0.1:19385', adminUrl: 'http://127.0.0.1:28469' }
        : { gatewayUrl: 'http://127.0.0.1:18473', adminUrl: 'http://127.0.0.1:29861' };
      const request = { ...fixture.request, port: restarted ? 19385 : 18473, region: restarted ? 'ap-south-2' : 'eu-north-1' };
      if (restarted) {
        await fulfilled(observe(fixture.manager.start(fixture.request)));
        await fulfilled(observe(fixture.manager.stop()));
      }
      fixture.host.onStart = async (): Promise<AwsEndpoint> => await Promise.resolve(endpoint);
      await fulfilled(observe(fixture.manager.start(request)));
      const commands = new CommandFixture(fixture);
      commands.current = request;
      await fulfilled(observe(commands.run('malt.aws.openTerminal')));
      assert.deepEqual(commands.errors, []);
      assert.equal(fixture.manager.status.state, 'running');
      assert.equal(fixture.host.starts.length, restarted ? 2 : 1);
      assert.equal(commands.terminals.length, 1);
      const options = commands.terminals[0];
      assert.ok(options !== undefined);
      assertDedicatedOptions(options, endpoint.gatewayUrl, request.region);
    });
  },
}));
