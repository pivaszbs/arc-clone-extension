import { setStudyTransport } from '../client';
import { startJapaneseStudy } from '../mount';
import { safariApi } from './api';
const api = safariApi();
setStudyTransport(async (message) => {
  const response = await api.runtime.sendMessage(message);
  if (!response) throw new Error('Safari did not respond. Reload this page and try again.');
  if (response.error) throw new Error(response.error);
  return response;
});
startJapaneseStudy();
