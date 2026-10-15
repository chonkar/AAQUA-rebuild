import { StateGraph, Annotation, END, START } from '@langchain/langgraph';
import { AaquaAgentLLM } from './llmAdapter.js';

const TestGenStateAnnotation = Annotation.Root({
    prompt: Annotation(),
    framework: Annotation({ reducer: (a, b) => b ?? a, default: () => 'playwright' }),
    pageObjects: Annotation(),
    generatedCode: Annotation(),
    syntaxErrors: Annotation({ reducer: (a, b) => b ?? a, default: () => [] }),
    retryCount: Annotation({ reducer: (a, b) => b ?? a, default: () => 0 }),
    status: Annotation({ reducer: (a, b) => b ?? a, default: () => 'pending' }),
    logs: Annotation({ reducer: (a, b) => [...(a || []), ...(b || [])], default: () => [] }),
});

const llm = new AaquaAgentLLM();

// ── Node 1: Planning Node ──
async function plannerNode(state) {
    const logs = [`[TestGen Agent] Step 1: Analyzing user requirement and designing test strategy...`];
    const prompt = `You are a Lead QA Automation Architect adhering to the DISCOVER ONCE -> GENERATE ONCE -> EXECUTE MANY TIMES architecture.
Analyze this testing requirement:
"${state.prompt}"

Design a clean, maintainable ${state.framework} test structure following Page Object Model (POM).
Requirements:
1. Strict Locator Strategy: Prioritize Accessible role + name, Label, data-testid, stable IDs. Avoid dynamic/generated IDs (Pega/OutSystems) and fragile absolute XPaths.
2. Condition-Based Synchronization: ZERO arbitrary fixed sleeps (Thread.sleep or waitForTimeout forbidden). Rely on condition-based waits (element visibility, loader dismissal, network idle).
3. Clear assertions for important business checkpoints.
List the required Page Object classes, methods, and test assertions in 3 structured bullet points.`;

    try {
        const plan = await llm.generate(prompt, { temperature: 0.2 });
        logs.push(`[TestGen Agent] Designed test plan:\n${plan}`);
        return { pageObjects: plan, status: 'planned', logs };
    } catch (err) {
        logs.push(`[TestGen Agent] Planning error: ${err.message}`);
        return { status: 'error', logs };
    }
}

// ── Node 2: Generator Node ──
async function generatorNode(state) {
    const logs = [`[TestGen Agent] Step 2: Generating ${state.framework} test code (Attempt #${state.retryCount + 1})...`];
    
    let fixPrompt = '';
    if (state.syntaxErrors && state.syntaxErrors.length > 0) {
        fixPrompt = `\nPREVIOUS GENERATION HAD SYNTAX ERRORS:\n${state.syntaxErrors.join('\n')}\nFix these syntax errors cleanly!`;
    }

    const prompt = `You are an expert ${state.framework} automation engineer creating production CI/CD automation.
User Requirement: ${state.prompt}
Architecture Plan: ${state.pageObjects}
${fixPrompt}

Rules:
1. Generate complete, production-ready ${state.framework} Page Object Model code.
2. Use stable locators (Accessible role/name, label, data-testid). DO NOT use dynamic/generated IDs or fragile index XPaths.
3. ZERO arbitrary sleeps: Use condition-based waits (visibility, interactability, networkidle).
4. Include assertions for critical business outcomes.
5. The code must run independently in CI/CD without AI or MCP dependencies.
Return ONLY code inside a single markdown code block (e.g. \`\`\`js or \`\`\`java). Do not include conversational text outside the code block.`;

    try {
        const code = await llm.generate(prompt, { temperature: 0.1 });
        logs.push(`[TestGen Agent] Generated test code successfully.`);
        return { generatedCode: code, status: 'generated', logs };
    } catch (err) {
        logs.push(`[TestGen Agent] Code generation error: ${err.message}`);
        return { status: 'error', logs };
    }
}

// ── Node 3: Syntax & Imports Validation Node ──
async function syntaxCheckNode(state) {
    const logs = [`[TestGen Agent] Step 3: Validating syntax & imports...`];
    const code = state.generatedCode || '';
    const errors = [];

    // Basic syntax & structural checks
    if (!code.includes('```')) {
        errors.push('Output missing code block formatting');
    }
    if (state.framework === 'playwright' && !code.includes('test(') && !code.includes('page.')) {
        errors.push('Playwright test structure missing test() or page actions');
    }
    if (state.framework === 'maven' && !code.includes('@Test') && !code.includes('class')) {
        errors.push('Java test structure missing @Test annotation or class definition');
    }

    if (errors.length === 0) {
        logs.push(`[TestGen Agent] ✅ Syntax and structural check passed!`);
        return { syntaxErrors: [], status: 'completed', logs };
    } else {
        logs.push(`[TestGen Agent] ⚠️ Found ${errors.length} structural/syntax issue(s). Retry count: ${state.retryCount + 1}`);
        return {
            syntaxErrors: errors,
            retryCount: state.retryCount + 1,
            status: 'failed-check',
            logs
        };
    }
}

// ── Conditional Router Edge ──
function checkSyntax(state) {
    if (state.status === 'completed') {
        return 'finish';
    }
    if (state.status === 'failed-check' && state.retryCount < 3) {
        return 'retryGen';
    }
    return 'finish';
}

// ── Node 4: Finish Node ──
async function finishNode(state) {
    const finalLogs = [`[TestGen Agent] Workflow execution finished with status: ${state.status}`];
    return { logs: finalLogs };
}

// ── Build LangGraph Workflow ──
const workflow = new StateGraph(TestGenStateAnnotation)
    .addNode('planner', plannerNode)
    .addNode('generator', generatorNode)
    .addNode('syntaxCheck', syntaxCheckNode)
    .addNode('finish', finishNode)
    .addEdge(START, 'planner')
    .addEdge('planner', 'generator')
    .addEdge('generator', 'syntaxCheck')
    .addConditionalEdges('syntaxCheck', checkSyntax, {
        finish: 'finish',
        retryGen: 'generator'
    })
    .addEdge('finish', END);

export const testGenGraph = workflow.compile();
