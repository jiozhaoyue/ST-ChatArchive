import { getContext } from '../../../extensions.js';
import { initializeChatArchivePack } from './app.js';

initializeChatArchivePack({
  getContext,
  settingsTemplate: new URL('./settings.html', import.meta.url),
});
