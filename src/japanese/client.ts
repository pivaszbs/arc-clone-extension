import { requestArc as chromeRequest } from '../shared/messaging';
type Message = { type: string; [key: string]: unknown };
type Transport = (message: Message) => Promise<any>;
let transport: Transport = chromeRequest;
export function setStudyTransport(next: Transport) { transport = next; }
export function requestArc(message: Message) { return transport(message); }
