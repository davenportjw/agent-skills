#!/usr/bin/env node
/**
 * Adaptive Learning Journey Engine & Callback Validator (`journey-engine.mjs`)
 *
 * Deterministic state machine for packaged learning journeys:
 * - Resolves the active concept node and teaching modality (`primaryModality` vs. `remediationModality`).
 * - Copies bundled micro-widgets (`widgets/*.html`) into the active conversation's
 *   artifact directory so `<agent-embed src="file:///...">` renders directly inside `ask_question`.
 * - Validates the learner's `ask_question` response via callback:
 *   - On PASS: records mastery and returns the next concept node.
 *   - On MISS: maps the chosen distractor to its `misconceptionId`, switches to the
 *     alternative representation (`remediationModality`), and returns an isomorphic
 *     comprehension question.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const JOURNEYS_DIR = path.join(PLUGIN_ROOT, 'journeys');
const WIDGETS_DIR = path.join(PLUGIN_ROOT, 'widgets');
const DEFAULT_STATE_PATH = path.join(os.homedir(), '.config', 'agent-skills', 'adaptive-learning-state.json');

function resolveStatePath(customStatePath) {
  return customStatePath || process.env.ADAPTIVE_LEARNING_STATE_PATH || DEFAULT_STATE_PATH;
}

function loadState(customStatePath) {
  const target = resolveStatePath(customStatePath);
  try {
    if (fs.existsSync(target)) {
      return JSON.parse(fs.readFileSync(target, 'utf8'));
    }
  } catch {}
  return { journeys: {} };
}

function saveState(state, customStatePath) {
  const target = resolveStatePath(customStatePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(state, null, 2), 'utf8');
}

function loadJourney(journeyId) {
  const filePath = path.join(JOURNEYS_DIR, `${journeyId}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Unknown journeyId "${journeyId}". Expected file at ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function listJourneys() {
  const state = loadState();
  const files = fs.readdirSync(JOURNEYS_DIR).filter(f => f.endsWith('.json'));
  return files.map(f => {
    const j = JSON.parse(fs.readFileSync(path.join(JOURNEYS_DIR, f), 'utf8'));
    const jState = state.journeys[j.journeyId] || { masteredNodes: [], currentNodeIndex: 0 };
    return {
      journeyId: j.journeyId,
      title: j.title,
      description: j.description,
      totalNodes: j.nodes.length,
      masteredCount: (jState.masteredNodes || []).length,
      completed: (jState.masteredNodes || []).length >= j.nodes.length
    };
  });
}

function prepareModalityQuestion(modality, artifactDir) {
  let prompt = modality.questionPrompt;
  let syncedWidgetPath = null;

  if (modality.widgetFile && prompt.includes('{{WIDGET_EMBED}}')) {
    const srcWidget = path.join(WIDGETS_DIR, modality.widgetFile);
    if (artifactDir && fs.existsSync(srcWidget)) {
      fs.mkdirSync(artifactDir, { recursive: true });
      syncedWidgetPath = path.join(artifactDir, modality.widgetFile);
      fs.copyFileSync(srcWidget, syncedWidgetPath);
      prompt = prompt.replace(
        '{{WIDGET_EMBED}}',
        `<agent-embed src="file://${syncedWidgetPath}"></agent-embed>`
      );
    } else if (fs.existsSync(srcWidget)) {
      prompt = prompt.replace(
        '{{WIDGET_EMBED}}',
        `<agent-embed src="file://${srcWidget}"></agent-embed>`
      );
    }
  }

  return {
    modalityType: modality.type,
    syncedWidgetPath,
    askQuestionPayload: {
      question: prompt,
      options: modality.options,
      is_multi_select: false
    }
  };
}

function getStep(journeyId, artifactDir) {
  const journey = loadJourney(journeyId);
  const state = loadState();
  const jState = state.journeys[journeyId] || {
    masteredNodes: [],
    nodeModes: {}
  };

  const nextNode = journey.nodes.find(n => !jState.masteredNodes.includes(n.nodeId));
  if (!nextNode) {
    return {
      journeyId,
      completed: true,
      message: `All ${journey.nodes.length} nodes in "${journey.title}" are mastered!`
    };
  }

  const mode = jState.nodeModes?.[nextNode.nodeId] || 'primary';
  const activeModality = mode === 'remediation' ? nextNode.remediationModality : nextNode.primaryModality;
  const prepared = prepareModalityQuestion(activeModality, artifactDir);

  return {
    journeyId,
    journeyTitle: journey.title,
    nodeId: nextNode.nodeId,
    nodeTitle: nextNode.title,
    objective: nextNode.objective,
    mode,
    ...prepared
  };
}

function resolveSelectedIndex(options, input) {
  const trimmed = String(input).trim();
  if (/^[0-9]+$/.test(trimmed)) {
    return parseInt(trimmed, 10);
  }
  const exactIdx = options.findIndex(o => o.trim() === trimmed || trimmed.includes(o.split('\n')[0].trim()));
  if (exactIdx !== -1) return exactIdx;
  if (/^Option A/i.test(trimmed)) return 0;
  if (/^Option B/i.test(trimmed)) return 1;
  if (/^Option C/i.test(trimmed)) return 2;
  return -1;
}

function validateAnswer(journeyId, nodeId, selectedInput, artifactDir) {
  const journey = loadJourney(journeyId);
  const node = journey.nodes.find(n => n.nodeId === nodeId);
  if (!node) {
    throw new Error(`Node "${nodeId}" not found in journey "${journeyId}"`);
  }

  const state = loadState();
  const jState = state.journeys[journeyId] || {
    masteredNodes: [],
    nodeModes: {},
    attempts: {}
  };

  const currentMode = jState.nodeModes?.[nodeId] || 'primary';
  const activeModality = currentMode === 'remediation' ? node.remediationModality : node.primaryModality;
  const chosenIdx = resolveSelectedIndex(activeModality.options, selectedInput);
  const passed = chosenIdx === activeModality.correctIndex;

  jState.attempts = jState.attempts || {};
  jState.attempts[nodeId] = (jState.attempts[nodeId] || 0) + 1;

  if (passed) {
    if (!jState.masteredNodes.includes(nodeId)) {
      jState.masteredNodes.push(nodeId);
    }
    jState.nodeModes[nodeId] = 'primary';
    state.journeys[journeyId] = jState;
    saveState(state);

    const nextStep = getStep(journeyId, artifactDir);
    return {
      passed: true,
      journeyId,
      masteredNodeId: nodeId,
      attemptsTaken: jState.attempts[nodeId],
      feedback: `Correct! Mastered "${node.title}".`,
      nextStep
    };
  }

  // Learner missed the question -> diagnose misconception and pivot to remediation modality!
  const miscEntry =
    activeModality.misconceptions?.[String(chosenIdx)] || {
      misconceptionId: 'conceptual_gap',
      diagnosis: 'That option misses a core architectural constraint. Let\'s examine the concept from a different angle.'
    };

  jState.nodeModes = jState.nodeModes || {};
  jState.nodeModes[nodeId] = 'remediation';
  state.journeys[journeyId] = jState;
  saveState(state);

  const remediationPrepared = prepareModalityQuestion(node.remediationModality, artifactDir);

  return {
    passed: false,
    journeyId,
    nodeId,
    chosenIndex: chosenIdx,
    misconceptionId: miscEntry.misconceptionId,
    diagnosis: miscEntry.diagnosis,
    actionRequired: 'PIVOT_MODALITY_AND_REASK',
    remediationStep: {
      nodeId: node.nodeId,
      nodeTitle: node.title,
      mode: 'remediation',
      ...remediationPrepared
    }
  };
}

function resetProgress(journeyId) {
  const state = loadState();
  if (journeyId) {
    delete state.journeys[journeyId];
  } else {
    state.journeys = {};
  }
  saveState(state);
  return { reset: journeyId || 'all', status: 'ok' };
}

// CLI Entrypoint
const [, , cmd, arg1, arg2, arg3, arg4] = process.argv;
if (cmd === 'list') {
  console.log(JSON.stringify(listJourneys(), null, 2));
} else if (cmd === 'step') {
  console.log(JSON.stringify(getStep(arg1, arg2), null, 2));
} else if (cmd === 'validate') {
  console.log(JSON.stringify(validateAnswer(arg1, arg2, arg3, arg4), null, 2));
} else if (cmd === 'reset') {
  console.log(JSON.stringify(resetProgress(arg1), null, 2));
} else if (cmd) {
  console.error('Usage: journey-engine.mjs <list|step|validate|reset> [args...]');
  process.exit(1);
}

export { listJourneys, getStep, validateAnswer, resetProgress };
