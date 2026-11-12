import { httpOrigin, validRegion } from '../shared/aws/validation';

export const terminalEnvironment = (endpoint: string, region: string): Record<string, string | null> => {
  const origin = httpOrigin(endpoint);
  if (!validRegion(region)) { throw new Error('Invalid Local AWS signing region.'); }
  return {
    AWS_ENDPOINT_URL: origin, AWS_ENDPOINT_URL_STS: origin, AWS_ENDPOINT_URL_SQS: origin, AWS_ENDPOINT_URL_S3: origin,
    AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', AWS_REGION: region, AWS_DEFAULT_REGION: region,
    AWS_EC2_METADATA_DISABLED: 'true', AWS_PAGER: '',
    AWS_SESSION_TOKEN: null, AWS_SECURITY_TOKEN: null, AWS_PROFILE: null, AWS_DEFAULT_PROFILE: null,
  };
};
