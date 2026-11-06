import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getStep, listJourneys, resetProgress, validateAnswer } from '../scripts/journey-engine.mjs';

describe('adaptive-learning plugin (journey engine & callback validator)', () => {
  let tmpDir: string;
  let artifactDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adaptive-learning-test-'));
    artifactDir = path.join(tmpDir, 'artifacts');
    process.env.ADAPTIVE_LEARNING_STATE_PATH = path.join(tmpDir, 'state.json');
    resetProgress();
  });

  afterEach(() => {
    delete process.env.ADAPTIVE_LEARNING_STATE_PATH;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists all 3 packaged learning journeys with zero initial mastery', () => {
    const journeys = listJourneys();
    expect(journeys.length).toBe(3);

    const ids = journeys.map((j: { journeyId: string }) => j.journeyId).sort();
    expect(ids).toEqual([
      'agentic-ui-architectures',
      'cloud-run-l4-and-vertex-inference',
      'token-economics-and-ast-graph',
    ]);

    for (const journey of journeys) {
      expect(journey.totalNodes).toBeGreaterThanOrEqual(2);
      expect(journey.masteredCount).toBe(0);
      expect(journey.completed).toBe(false);
    }
  });

  it('syncs the micro-widget into the artifact directory and embeds <agent-embed> inside ask_question', () => {
    const step = getStep('agentic-ui-architectures', artifactDir);
    expect(step.journeyId).toBe('agentic-ui-architectures');
    expect(step.nodeId).toBe('wire_protocol_and_security');
    expect(step.mode).toBe('primary');
    expect(step.modalityType).toBe('embed_simulator_in_question');

    // Verify widget was copied to artifactDir and embedded with file:// URI
    expect(step.syncedWidgetPath).toBe(path.join(artifactDir, 'a2ui_vs_mcp_micro_widget.html'));
    expect(fs.existsSync(step.syncedWidgetPath)).toBe(true);
    expect(step.askQuestionPayload.question).toContain(
      `<agent-embed src="file://${step.syncedWidgetPath}"></agent-embed>`,
    );

    // Ensure quiz options never contain spoiler "(Recommended)" badges or unescaped bare <agent-embed> tags
    for (const opt of step.askQuestionPayload.options) {
      expect(opt).not.toContain('(Recommended)');
      expect(opt).not.toMatch(/(?<!`)<agent-embed>(?!`)/);
    }
  });

  it('diagnoses misconceptions on a missed answer and pivots to the remediation modality', () => {
    // Pass wrong option (Option B / index 1) on Journey 1 Node 1
    const missResult = validateAnswer(
      'agentic-ui-architectures',
      'wire_protocol_and_security',
      'Option B',
      artifactDir,
    );

    expect(missResult.passed).toBe(false);
    expect(missResult.chosenIndex).toBe(1);
    expect(missResult.misconceptionId).toBe('confused_a2ui_with_mcp_apps');
    expect(missResult.diagnosis).toContain('A2UI');
    expect(missResult.actionRequired).toBe('PIVOT_MODALITY_AND_REASK');

    // Verify remediation step switches to diff_and_mermaid_in_question modality
    expect(missResult.remediationStep.mode).toBe('remediation');
    expect(missResult.remediationStep.modalityType).toBe('diff_and_mermaid_in_question');
    expect(missResult.remediationStep.askQuestionPayload.question).toContain('```diff');
    expect(missResult.remediationStep.askQuestionPayload.question).toContain('```mermaid');

    // Subsequent getStep call should persist in remediation mode until mastered
    const persistedStep = getStep('agentic-ui-architectures', artifactDir);
    expect(persistedStep.mode).toBe('remediation');
    expect(persistedStep.modalityType).toBe('diff_and_mermaid_in_question');

    // Now answer the remediation question accurately (Option A / index 0)
    const passResult = validateAnswer(
      'agentic-ui-architectures',
      'wire_protocol_and_security',
      'Option A',
      artifactDir,
    );
    expect(passResult.passed).toBe(true);
    expect(passResult.masteredNodeId).toBe('wire_protocol_and_security');
    expect(passResult.attemptsTaken).toBe(2);
    expect(passResult.nextStep.nodeId).toBe('callback_and_schema_mechanics');
    expect(passResult.nextStep.mode).toBe('primary');
  });

  it('completes a full journey across all nodes and supports Cloud Run L4 journey', () => {
    const step1 = getStep('cloud-run-l4-and-vertex-inference', artifactDir);
    expect(step1.nodeId).toBe('l4-vs-cpu-and-cold-start');
    expect(step1.askQuestionPayload.question).toContain('l4_vs_vertex_cost_micro_widget.html');

    const res1 = validateAnswer(
      'cloud-run-l4-and-vertex-inference',
      'l4-vs-cpu-and-cold-start',
      '0',
      artifactDir,
    );
    expect(res1.passed).toBe(true);
    expect(res1.nextStep.nodeId).toBe('eval-harness-lifecycle-teardown');

    const res2 = validateAnswer(
      'cloud-run-l4-and-vertex-inference',
      'eval-harness-lifecycle-teardown',
      'Option A',
      artifactDir,
    );
    expect(res2.passed).toBe(true);
    expect(res2.nextStep.completed).toBe(true);
  });
});
