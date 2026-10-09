import { ConfigSchema, type Config } from '../src/config.js';
import { configHash } from '../src/config.js';
import { fingerprint } from '../src/safety.js';
import type { Run } from '../src/models.js';

export function fixtureConfig(repository:string):Config {
  return ConfigSchema.parse({repository,baseRef:'main',linear:{organization:'factory-fixture',team:'ENG'},
    model:{provider:'fixture-no-api',id:'fixture-no-api',apiKeyEnv:'FACTORY_TEST_UNUSED_KEY',maxOutputTokens:4096},budgetUsd:5,
    environment:{checks:[{name:'tests',argv:['python3','-I','-S','-B','check.py'],timeoutSeconds:10}]},
    limits:{stageSeconds:120,commandSeconds:20,maxOutputBytes:262144,
      maxFileBytes:2097152,maxArtifactBytes:8388608,maxTurns:10}});
}
export const issue={id:'9a0e0000-0000-4000-8000-000000000001',identifier:'ENG-42',title:'Return the expected value',
  description:'Update value.txt from old to new. Do not alter check.py.',team_id:'3f1c0000-0000-4000-8000-000000000001',
  url:'https://linear.app/factory-fixture/issue/ENG-42/value',updated_at:'2026-10-06T12:00:00Z'};
export function fixtureRun(config:Config):Run {
  return {id:'F-0123456789ab',status:'planning',created:new Date().toISOString(),updated:new Date().toISOString(),
    issue,issueHash:fingerprint(issue),config,configHash:configHash(config),base:'a'.repeat(40),source:'b'.repeat(64),
    baseline:[],repairCount:0,spentUsd:0,turns:0,messages:[]};
}
