import {
  aspectRatios,
  exportPresets,
  failureAdvice,
  productLimits,
  supportedInputs,
} from '@vidlive/shared';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../config/env.js';

export function registerConversionRoutes(server: FastifyInstance, config: AppConfig): void {
  server.get('/api/conversions/capabilities', async () => {
    return {
      modes: ['local', 'cloud'],
      supportedInputs,
      productLimits: {
        ...productLimits,
        localFileSizeBytes: config.localFileSizeBytes,
        cloudFileSizeBytes: config.cloudFileSizeBytes,
      },
      presets: Object.values(exportPresets),
      aspectRatios,
      failureAdvice: Object.values(failureAdvice),
    };
  });

  server.post('/api/conversions/cloud-intents', async (_request, reply) => {
    return reply.status(501).send({
      code: 'cloud-processing-not-enabled',
      message: 'Cloud processing is planned for the Beta phase.',
      uploadPolicy: {
        requiresConsent: true,
        defaultRetentionHours: 24,
        maxFileSizeBytes: config.cloudFileSizeBytes,
      },
    });
  });
}
