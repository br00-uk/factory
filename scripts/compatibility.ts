import { command, clean, requireSuccess } from '../src/safety.js';
import { ROOT } from '../src/config.js';
import { join } from 'node:path';

try {
  const result=await command([process.execPath,'--test','--test-concurrency=1',join(ROOT,'dist/tests/vm.test.js')],
    {timeoutMs:480000,maxBytes:1024*1024});
  console.log(clean(requireSuccess(result).toString()));
}catch(e){console.error(clean((e as Error).message));process.exitCode=1;}
