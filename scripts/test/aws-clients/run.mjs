import { pathToFileURL } from 'node:url';
import { clearTimeout, setTimeout } from 'node:timers';
import { configuration, receiptArgument, failure, CLI_IMAGE, PYTHON_IMAGE } from './config.mjs';
import { prepareReceipt } from './receipt.mjs';
import { inspectGateway } from './process.mjs';
import { runCli } from './cli.mjs';
import { runSdk } from './sdk.mjs';

export async function main(args, env) {
  // Invalidate an owned previous success before validating the rest of this run.
  const receipt = await prepareReceipt(receiptArgument(args));
  const controller = new globalThis.AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, 300_000);
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    const config = configuration(args, env);
    Object.assign(receipt.value, { endpoint: config.endpoint, region: config.region, gatewayContainer: config.container,
      images: { awsCli: CLI_IMAGE, boto3: PYTHON_IMAGE }, phase: 'gateway-preflight' });
    await receipt.write();
    await inspectGateway(config, controller.signal);
    receipt.value.phase = 'clients';
    receipt.value.clients.push(await runCli(config, controller.signal));
    await receipt.write();
    if (!controller.signal.aborted) receipt.value.clients.push(await runSdk(config, controller.signal));
    receipt.value.success = !controller.signal.aborted && receipt.value.clients.length === 2 && receipt.value.clients.every(({ success }) => success);
  } catch (error) {
    receipt.value.failure = failure(error);
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    receipt.value.phase = 'complete';
    receipt.value.finishedAt = new Date().toISOString();
    await receipt.write();
  }
  return receipt.value.success ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main(process.argv.slice(2), process.env);
    process.stdout.write(`Client acceptance ${process.exitCode === 0 ? 'passed' : 'failed'}; inspect the owned receipt.\n`);
  } catch (error) {
    process.stderr.write(`${failure(error).message}\n`);
    process.exitCode = 1;
  }
}
