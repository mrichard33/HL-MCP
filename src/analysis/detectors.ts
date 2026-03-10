import { getSupabaseClient } from '../clients/supabase.js';
import { detectCycles } from './graph.js';

export interface DuplicateTrigger {
  trigger_event: string;
  trigger_value: string | null;
  count: number;
  workflow_ids: string[];
}

export interface MessageOverlap {
  workflow_id_a: string;
  workflow_id_b: string;
  action_type: string;
  issue: string;
}

export interface WaitBottleneck {
  workflow_id: string;
  step_id: string;
  step_type: string;
  delay_minutes: number;
}

export interface CircularAutomation {
  workflow_id: string;
  cycles: string[][];
}

export interface DeadWorkflow {
  workflow_id: string;
  name: string;
  issue: string;
}

/**
 * Find workflows with identical trigger events and values.
 * These may cause automation conflicts.
 */
export async function findDuplicateTriggers(): Promise<DuplicateTrigger[]> {
  const supabase = getSupabaseClient();

  const { data: triggers, error } = await supabase
    .from('workflow_triggers')
    .select('workflow_id, trigger_event, trigger_value');

  if (error) throw new Error(`Failed to query triggers: ${error.message}`);
  if (!triggers || triggers.length === 0) return [];

  // Group by event + value
  const groups = new Map<string, { event: string; value: string | null; workflowIds: string[] }>();
  for (const t of triggers) {
    const key = `${t.trigger_event}::${t.trigger_value || ''}`;
    if (!groups.has(key)) {
      groups.set(key, { event: t.trigger_event, value: t.trigger_value, workflowIds: [] });
    }
    groups.get(key)!.workflowIds.push(t.workflow_id);
  }

  // Filter to groups with more than 1 workflow
  const duplicates: DuplicateTrigger[] = [];
  for (const group of groups.values()) {
    if (group.workflowIds.length > 1) {
      duplicates.push({
        trigger_event: group.event,
        trigger_value: group.value,
        count: group.workflowIds.length,
        workflow_ids: [...new Set(group.workflowIds)],
      });
    }
  }

  return duplicates;
}

/**
 * Detect circular automations within workflows.
 * Uses graph traversal to find loops in step connections.
 */
export async function detectCircularAutomations(): Promise<CircularAutomation[]> {
  const supabase = getSupabaseClient();
  const results: CircularAutomation[] = [];

  // Get all workflows that have connections
  const { data: workflowIds } = await supabase
    .from('workflow_connections')
    .select('workflow_id');

  if (!workflowIds) return [];

  const uniqueIds = [...new Set(workflowIds.map((w) => w.workflow_id))];

  for (const wfId of uniqueIds) {
    const cycles = await detectCycles(wfId);
    if (cycles.length > 0) {
      results.push({ workflow_id: wfId, cycles });
    }
  }

  // Cross-workflow circular detection:
  // Find workflows where one adds a tag and another triggers on that tag
  const { data: actions } = await supabase
    .from('workflow_actions')
    .select('workflow_id, action_type, action_target, raw_json');

  const { data: triggers } = await supabase
    .from('workflow_triggers')
    .select('workflow_id, trigger_event, trigger_value');

  if (actions && triggers) {
    const tagAdders = actions.filter((a) =>
      a.action_type?.toLowerCase().includes('tag') ||
      a.action_type?.toLowerCase().includes('add_tag')
    );

    const tagTriggers = triggers.filter((t) =>
      t.trigger_event?.toLowerCase().includes('tag')
    );

    for (const adder of tagAdders) {
      for (const trigger of tagTriggers) {
        if (adder.workflow_id !== trigger.workflow_id &&
            adder.action_target && trigger.trigger_value &&
            adder.action_target.toLowerCase() === trigger.trigger_value.toLowerCase()) {
          results.push({
            workflow_id: `${adder.workflow_id} → ${trigger.workflow_id}`,
            cycles: [[adder.workflow_id, trigger.workflow_id, adder.workflow_id]],
          });
        }
      }
    }
  }

  return results;
}

/**
 * Detect messaging overlaps: SMS or email actions sent within short intervals
 * across different workflows that could hit the same contacts.
 */
export async function detectMessageOverlap(intervalMinutes: number = 5): Promise<MessageOverlap[]> {
  const supabase = getSupabaseClient();
  const overlaps: MessageOverlap[] = [];

  // Get all messaging actions
  const { data: actions, error } = await supabase
    .from('workflow_actions')
    .select('workflow_id, step_id, action_type, action_target, raw_json');

  if (error) throw new Error(`Failed to query actions: ${error.message}`);
  if (!actions) return [];

  const messageActions = actions.filter((a) => {
    const type = (a.action_type || '').toLowerCase();
    return type.includes('sms') || type.includes('email') || type.includes('send');
  });

  // Get step timing info
  const { data: steps } = await supabase
    .from('workflow_steps')
    .select('step_id, workflow_id, step_order, delay_minutes');

  const stepMap = new Map<string, { step_order: number; delay_minutes: number }>();
  if (steps) {
    for (const s of steps) {
      stepMap.set(s.step_id, { step_order: s.step_order, delay_minutes: s.delay_minutes || 0 });
    }
  }

  // Compare messaging actions across workflows
  for (let i = 0; i < messageActions.length; i++) {
    for (let j = i + 1; j < messageActions.length; j++) {
      const a = messageActions[i];
      const b = messageActions[j];

      if (a.workflow_id === b.workflow_id) continue;

      // Check if they send similar message types
      const aType = (a.action_type || '').toLowerCase();
      const bType = (b.action_type || '').toLowerCase();

      const bothSms = aType.includes('sms') && bType.includes('sms');
      const bothEmail = aType.includes('email') && bType.includes('email');

      if (bothSms || bothEmail) {
        // Check timing proximity using cumulative delays
        const aStep = stepMap.get(a.step_id);
        const bStep = stepMap.get(b.step_id);
        const aDelay = aStep?.delay_minutes || 0;
        const bDelay = bStep?.delay_minutes || 0;
        const timeDiff = Math.abs(aDelay - bDelay);

        if (timeDiff <= intervalMinutes) {
          overlaps.push({
            workflow_id_a: a.workflow_id,
            workflow_id_b: b.workflow_id,
            action_type: bothSms ? 'SMS' : 'Email',
            issue: `Both workflows send ${bothSms ? 'SMS' : 'Email'} within ${intervalMinutes} minutes (delay diff: ${timeDiff} min). Risk of message flooding.`,
          });
        }
      }
    }
  }

  return overlaps;
}

/**
 * Detect wait bottlenecks: steps with excessive delays.
 */
export async function detectWaitBottlenecks(thresholdMinutes: number = 720): Promise<WaitBottleneck[]> {
  const supabase = getSupabaseClient();

  const { data: steps, error } = await supabase
    .from('workflow_steps')
    .select('step_id, workflow_id, step_type, delay_minutes')
    .gt('delay_minutes', thresholdMinutes);

  if (error) throw new Error(`Failed to query steps: ${error.message}`);

  return (steps || []).map((s) => ({
    workflow_id: s.workflow_id,
    step_id: s.step_id,
    step_type: s.step_type,
    delay_minutes: s.delay_minutes,
  }));
}

/**
 * Detect dead workflows: workflows with triggers referencing potentially
 * deleted resources (forms, pipeline stages, tags that no longer exist).
 */
export async function detectDeadWorkflows(): Promise<DeadWorkflow[]> {
  const supabase = getSupabaseClient();
  const deadWorkflows: DeadWorkflow[] = [];

  // Get all workflows (exclude soft-deleted)
  const { data: workflows } = await supabase
    .from('workflows')
    .select('ghl_workflow_id, name, status')
    .is('deleted_at', null);

  if (!workflows) return [];

  // Get all triggers
  const { data: triggers } = await supabase
    .from('workflow_triggers')
    .select('workflow_id, trigger_event, trigger_value, raw_json');

  if (!triggers) return [];

  // Get known pipeline stages (exclude soft-deleted)
  const { data: pipelines } = await supabase
    .from('pipelines')
    .select('stages')
    .is('deleted_at', null);

  const knownStageIds = new Set<string>();
  if (pipelines) {
    for (const p of pipelines) {
      const stages = p.stages as Array<{ id: string }> | null;
      if (stages) {
        for (const stage of stages) {
          if (stage.id) knownStageIds.add(stage.id);
        }
      }
    }
  }

  // Get known tags from contacts (exclude soft-deleted)
  const { data: contacts } = await supabase
    .from('contacts')
    .select('tags')
    .is('deleted_at', null);

  const knownTags = new Set<string>();
  if (contacts) {
    for (const c of contacts) {
      if (c.tags) {
        for (const tag of c.tags) {
          knownTags.add(tag.toLowerCase());
        }
      }
    }
  }

  // Check each workflow's triggers for dead references
  for (const workflow of workflows) {
    const wfTriggers = triggers.filter((t) => t.workflow_id === workflow.ghl_workflow_id);

    // Check for draft/inactive status with triggers (potential dead workflow)
    if (workflow.status === 'draft' && wfTriggers.length > 0) {
      deadWorkflows.push({
        workflow_id: workflow.ghl_workflow_id,
        name: workflow.name,
        issue: 'Workflow is in draft status but has configured triggers — may be abandoned.',
      });
      continue;
    }

    for (const trigger of wfTriggers) {
      const event = (trigger.trigger_event || '').toLowerCase();
      const value = trigger.trigger_value;

      // Check for pipeline stage triggers referencing unknown stages
      if (event.includes('pipeline') || event.includes('stage')) {
        if (value && knownStageIds.size > 0 && !knownStageIds.has(value)) {
          deadWorkflows.push({
            workflow_id: workflow.ghl_workflow_id,
            name: workflow.name,
            issue: `Trigger references pipeline stage "${value}" which may no longer exist.`,
          });
        }
      }

      // Check for tag triggers referencing unknown tags
      if (event.includes('tag')) {
        if (value && knownTags.size > 0 && !knownTags.has(value.toLowerCase())) {
          deadWorkflows.push({
            workflow_id: workflow.ghl_workflow_id,
            name: workflow.name,
            issue: `Trigger references tag "${value}" which is not found on any contacts.`,
          });
        }
      }
    }
  }

  return deadWorkflows;
}
