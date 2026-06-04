import { getContext } from '../../../extensions.js';
import { initializeChatArchivePack } from './public/scripts/extensions/third-party/chat-archive-pack/app.js';

initializeChatArchivePack({
  getContext,
  settingsTemplate: new URL('./settings.html', import.meta.url),
});
