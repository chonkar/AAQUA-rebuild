import { StateGraph, Annotation, END, START } from '@langchain/langgraph';
import { AaquaAgentLLM } from './llmAdapter.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { globSync } from 'glob';
import { execStatefulRun } from './agentUtils.js';

// Define the State Schema for the Auto-Healing Graph
const AutoHealStateAnnotation = Annotation.Root({
    testName: Annotation(),
    classname: Annotation(),
    errorMessage: Annotation(),
    stackTrace: Annotation(),
    pageUrl: Annotation(),
    dom: Annotation(),
    runId: Annotation(),
    projectRoot: Annotation(),
    framework: Annotation(),
    failedLocator: Annotation(),
    suggestions: Annotation({ reducer: (a, b) => b ?? a, default: () => [] }),
    candidateIndex: Annotation({ reducer: (a, b) => b ?? a, default: () => 0 }),
    attemptLogs: Annotation({ reducer: (a, b) => [...(a || []), ...(b || [])], default: () => [] }),
    status: Annotation({ reducer: (a, b) => b ?? a, default: () => 'pending' }),
    appliedPatch: Annotation(),
    healedRunId: Annotation(),
    error: Annotation(),
});

const llm = new AaquaAgentLLM();

/** Helper to extract locator from error/stacktrace */
function extractLocatorFromError(errorMessage = '', stackTrace = '') {
    const combined = `${errorMessage}\n${stackTrace}`;
    let match = combined.match(/By\.(id|cssSelector|xpath|name|className)\("([^"]+)"\)/i);
    if (match) return { strategy: match[1], value: match[2] };

    match = combined.match(/locator\((['"`])(.*?)(\1)\)/i);
    if (match) return { strategy: 'css', value: match[2] };

    match = combined.match(/#([a-zA-Z0-9_\-\\.]+)/);
    if (match) return { strategy: 'id', value: match[0] };

    return null;
}

// ── Node 1: Triage Node ──
async function triageNode(state) {
    const logs = [`[LangGraph Agent] Step 1: Triaging test failure for ${state.classname || ''}.${state.testName || ''}...`];
    const failedLocator = extractLocatorFromError(state.errorMessage, state.stackTrace);
    if (failedLocator) {
        logs.push(`[LangGraph Agent] Extracted broken locator: ${failedLocator.strategy}("${failedLocator.value}")`);
    } else {
        logs.push(`[LangGraph Agent] Warning: Could not extract locator directly from stack trace, relying on LLM DOM inspection.`);
    }
    return { failedLocator, status: 'triaged', attemptLogs: logs };
}

// ── Node 2: Suggestion Node ──
async function suggestionNode(state) {
    const logs = [`[LangGraph Agent] Step 2: Generating candidate locators via LLM...`];
    const domTruncated = (state.dom || '').substring(0, 18000);
    const locatorDesc = state.failedLocator 
        ? `${state.failedLocator.strategy}("${state.failedLocator.value}")` 
        : '(unknown)';

    const prompt = `You are an expert test automation agent inside AAQUA's LangGraph system.
A locator has broken in a test suite.

Failed Locator: ${locatorDesc}
Error Message: ${state.errorMessage || '(none)'}
Test: ${state.classname || ''}.${state.testName || ''}

Page DOM (truncated):
${domTruncated}

Provide up to 5 alternative candidate locators (XPath, CSS, ID, Name) ranked by confidence.
Return ONLY valid JSON matching this schema:
{ "suggestions": [ { "strategy": "id|css|xpath|name", "locator": "...", "confidence": 95, "description": "why this works" } ] }`;

    try {
        const text = await llm.generate(prompt, { temperature: 0.1 });
        const jsonStart = text.indexOf('{');
        const jsonEnd = text.lastIndexOf('}');
        let suggestions = [];
        if (jsonStart !== -1 && jsonEnd !== -1) {
            const parsed = JSON.parse(text.substring(jsonStart, jsonEnd + 1));
            suggestions = parsed.suggestions || [];
        }
        suggestions.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
        logs.push(`[LangGraph Agent] Generated ${suggestions.length} candidate locator patch(es).`);
        return { suggestions, candidateIndex: 0, status: 'suggested', attemptLogs: logs };
    } catch (err) {
        logs.push(`[LangGraph Agent] LLM suggestion error: ${err.message}`);
        return { suggestions: [], status: 'error', error: err.message, attemptLogs: logs };
    }
}

// ── Node 3: Verifier Node (Applies candidate patch & re-runs test) ──
async function verifierNode(state) {
    const candidate = state.suggestions[state.candidateIndex];
    if (!candidate) {
        return { status: 'failed', attemptLogs: [`[LangGraph Agent] No candidate available at index ${state.candidateIndex}.`] };
    }

    const logs = [`[LangGraph Agent] Step 3: Verifying Candidate #${state.candidateIndex + 1}: ${candidate.strategy}("${candidate.locator}") (Confidence: ${candidate.confidence}%)`];
    
    if (!state.projectRoot || !state.framework) {
        logs.push(`[LangGraph Agent] Cannot execute verification: missing projectRoot or framework.`);
        return { status: 'applied-unverified', appliedPatch: candidate, attemptLogs: logs };
    }

    try {
        // Execute source patching and re-run via helper
        const result = await execStatefulRun({
            projectRoot: state.projectRoot,
            framework: state.framework,
            classname: state.classname,
            testName: state.testName,
            oldLocator: state.failedLocator?.value || '',
            newLocator: candidate.locator,
            newStrategy: candidate.strategy,
        });

        if (result.passed) {
            logs.push(`[LangGraph Agent] ✅ Candidate #${state.candidateIndex + 1} PASSED verification!`);
            return {
                status: 'healed',
                appliedPatch: candidate,
                healedRunId: result.healRunId,
                attemptLogs: logs
            };
        } else {
            logs.push(`[LangGraph Agent] ❌ Candidate #${state.candidateIndex + 1} failed verification re-run.`);
            return {
                status: 'candidate-failed',
                candidateIndex: state.candidateIndex + 1,
                attemptLogs: logs
            };
        }
    } catch (err) {
        logs.push(`[LangGraph Agent] Verification exception: ${err.message}`);
        return {
            status: 'candidate-failed',
            candidateIndex: state.candidateIndex + 1,
            attemptLogs: logs
        };
    }
}

// ── Conditional Router Edge ──
function checkVerification(state) {
    if (state.status === 'healed') {
        return 'finalize';
    }
    if (state.status === 'candidate-failed' && state.candidateIndex < state.suggestions.length) {
        return 'verifyNext';
    }
    return 'finalize';
}

// ── Node 4: Finalize Node ──
async function finalizeNode(state) {
    const finalLogs = [];
    if (state.status === 'healed') {
        finalLogs.push(`[LangGraph Agent] Process finished: Test successfully healed and verified passing!`);
    } else {
        finalLogs.push(`[LangGraph Agent] Process finished: Exhausted candidates without verification pass.`);
    }
    return { attemptLogs: finalLogs };
}

// ── Build the LangGraph Workflow ──
const workflow = new StateGraph(AutoHealStateAnnotation)
    .addNode('triage', triageNode)
    .addNode('suggest', suggestionNode)
    .addNode('verify', verifierNode)
    .addNode('finalize', finalizeNode)
    .addEdge(START, 'triage')
    .addEdge('triage', 'suggest')
    .addEdge('suggest', 'verify')
    .addConditionalEdges('verify', checkVerification, {
        finalize: 'finalize',
        verifyNext: 'verify',
    })
    .addEdge('finalize', END);

export const autoHealGraph = workflow.compile();
