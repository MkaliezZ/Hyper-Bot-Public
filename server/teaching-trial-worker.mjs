import {pathToFileURL} from 'node:url';
import path from 'node:path';

process.once('disconnect',()=>process.exit(0));
await import(pathToFileURL(path.resolve('server/gateway.ts')).href);
