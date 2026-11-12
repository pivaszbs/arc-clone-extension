import { setStudyTransport } from './client';
import { createUserscriptTransport, type UserscriptApi } from './userscript-transport';
import { startJapaneseStudy } from './mount';
declare const GM: UserscriptApi;
setStudyTransport(createUserscriptTransport(GM));
startJapaneseStudy();
