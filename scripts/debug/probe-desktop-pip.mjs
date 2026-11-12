import { spawn } from 'node:child_process';
const native=spawn('outputs/desktop-pip/Arc Desktop Video.app/Contents/MacOS/ArcDesktopVideo',[],{stdio:['pipe','pipe','pipe']});
let data=Buffer.alloc(0);
const timer=setTimeout(()=>{console.error('Native player did not become ready');native.kill();process.exitCode=1},15000);
const send=msg=>{const b=Buffer.from(JSON.stringify(msg));const h=Buffer.alloc(4);h.writeUInt32LE(b.length);native.stdin.write(Buffer.concat([h,b]));};
native.stdout.on('data',part=>{data=Buffer.concat([data,part]);while(data.length>=4 && data.length>=data.readUInt32LE(0)+4){const n=data.readUInt32LE(0);const msg=JSON.parse(data.subarray(4,n+4));data=data.subarray(n+4);console.log(JSON.stringify(msg));if(msg.type==='ready'||msg.type==='error'){clearTimeout(timer);native.stdin.end();}}});
native.stderr.on('data',data=>process.stderr.write(data));
send({type:'open',sessionId:'probe',muted:true});
