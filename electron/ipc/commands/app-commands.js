import { app } from 'electron';
import { register } from '../registry.js';
import { v } from '../validate.js';
import { PROTOCOL_VERSION, CONTRACT_VERSION } from '../../services/versions.js';

register('app.versions', {
  requiresLibrary: false,
  payload: v.none(),
  handler: () => ({
    app: app.getVersion(),
    electron: process.versions.electron,
    protocol: PROTOCOL_VERSION,
    contract: CONTRACT_VERSION,
  }),
});
