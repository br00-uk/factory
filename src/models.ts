import { z } from 'zod';
import { CheckSchema, ConfigSchema } from './config.js';

export const StatusSchema = z.enum(['planning','awaiting_plan_approval','implementing','verifying','reviewing','repairing',
  'awaiting_merge_approval','ready_for_manual_merge','awaiting_input','paused','interrupted','failed','cancelled']);
export type Status = z.infer<typeof StatusSchema>;
export const executing = new Set<Status>(['planning','implementing','verifying','reviewing','repairing','awaiting_input']);
export const transitions: Record<Status, readonly Status[]> = {
  planning: ['awaiting_plan_approval','awaiting_input','paused','interrupted','failed','cancelled'],
  awaiting_plan_approval: ['planning','implementing','paused','interrupted','cancelled'],
  implementing: ['verifying','awaiting_input','paused','interrupted','failed','cancelled'],
  verifying: ['reviewing','repairing','paused','interrupted','failed','cancelled'],
  reviewing: ['awaiting_merge_approval','repairing','awaiting_input','paused','interrupted','failed','cancelled'],
  repairing: ['verifying','awaiting_input','paused','interrupted','failed','cancelled'],
  awaiting_merge_approval: ['planning','repairing','ready_for_manual_merge','paused','interrupted','cancelled'],
  ready_for_manual_merge: [], awaiting_input: ['planning','implementing','reviewing','repairing','paused','interrupted','cancelled','failed'],
  paused: ['planning','implementing','verifying','reviewing','repairing','awaiting_plan_approval','awaiting_merge_approval','awaiting_input','interrupted','cancelled'],
  interrupted: ['planning','implementing','verifying','reviewing','repairing','awaiting_plan_approval','awaiting_merge_approval','paused','cancelled'],
  failed: ['planning','implementing','verifying','reviewing','repairing','paused','interrupted','cancelled'], cancelled: [],
};
export const IssueSchema = z.object({ id: z.string().uuid(), identifier: z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/),
  title: z.string().min(1).max(2000), url: z.string().url(), description: z.string().nullable(),
  team_id: z.string().uuid(), project:z.object({id:z.string().uuid(),name:z.string()}).nullable().optional(),
  organization_id:z.string().uuid().optional(),
  updated_at: z.string(), comments: z.array(z.unknown()).optional() });
export type Issue = z.infer<typeof IssueSchema>;
export const PlanSchema = z.strictObject({ summary: z.string().min(1).max(10000),
  paths: z.array(z.string().min(1).max(1024)).min(1).max(100),
  acceptance: z.array(z.string().min(1).max(2000)).min(1).max(30),
  steps: z.array(z.string().min(1).max(2000)).min(1).max(30) });
export type Plan = z.infer<typeof PlanSchema>;
export const ReviewSchema = z.strictObject({ findings: z.array(z.strictObject({
  location: z.string().max(1024), severity: z.enum(['blocking','advisory']),
  impact: z.string().min(1).max(4000), correction: z.string().min(1).max(4000),
})).max(100), acceptance: z.array(z.strictObject({ criterion: z.string().max(2000),
  passed: z.boolean(), evidence: z.string().min(1).max(4000) })).min(1).max(30) });
export type Review = z.infer<typeof ReviewSchema>;
export interface CheckResult {
  name: string; argv: string[]; runner: string; source: string; started: string; ended: string;
  code: number | null; outcome: 'passed' | 'failed' | 'unavailable' | 'skipped'; log: string;
  required: boolean; logHash: string;
  cwd:string; environmentHash:string;
  comparison?: 'preexisting' | 'introduced' | undefined;
}
export interface Candidate { hash: string; commit: string; repository: string; diffPath: string;
  diffHash: string; checks: CheckResult[]; review?: Review; evidenceHash?: string }
export interface Run {
  id: string; status: Status; previous?: Status; created: string; updated: string;
  issue: Issue; issueHash: string; config: z.infer<typeof ConfigSchema>; configHash: string;
  organizationId?:string;
  base: string; source: string; buildHash?:string; plan?: Plan; planHash?: string; planSource?: string; baseline: CheckResult[];
  candidate?: Candidate; repairCount: number; spentUsd: number; turns: number;
  activeSeconds?: number; modelUsage?: {input:number;output:number;cacheRead:number;cacheWrite:number;costUsd:number};
  sessions?: {role:'planner'|'implementer'|'reviewer';id:string;file:string;created:string}[];
  preparationLogs?:string[];
  blocker?: string; progress?:string; messages: {text: string; kind: 'steering' | 'answer' | 'revision'; time: string}[];
}
export interface HumanRequest { id: string; run: string; stage: Status; context: string;
  question: string; pending: boolean; answer?: string; obsolete?:string; created: string }
export const RequestSchema = z.strictObject({ command: z.enum(['health','status','plan','approve','revise','answer','steer','pause','resume','cancel','shutdown','cleanup','resend']),
  run: z.string().regex(/^F-[a-f0-9]{12}$/).optional(), issue: z.string().max(2000).optional(),
  hash: z.string().regex(/^[a-f0-9]{64}$/).optional(), gate: z.enum(['plan','candidate']).optional(),
  request: z.string().regex(/^Q-[a-f0-9]{12}$/).optional(), message: z.string().min(1).max(10000).optional() });
export type Request = z.infer<typeof RequestSchema>;
