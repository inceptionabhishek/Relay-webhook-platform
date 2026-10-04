import './telemetry';
import { createApp } from './app';
import { config } from './config';
import { logger } from './observability';
void createApp()
  .then((app) => app.listen(config.PORT, '0.0.0.0'))
  .then(() => logger.info({ port: config.PORT }, 'Relay API ready'));
