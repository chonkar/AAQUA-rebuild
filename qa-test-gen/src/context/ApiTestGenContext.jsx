/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useState } from 'react';

/**
 * Holds all API Test Generator state OUTSIDE the page component, so navigating
 * to another AAQUA page (which unmounts the page) does not cancel an in-flight
 * generation/flow request or discard its results. The provider is mounted above
 * the router, so it stays alive across route changes; in-flight async work keeps
 * writing here and the page re-reads it on return.
 *
 * Memory: this holds only the CURRENT operation's state (one catalog, one set of
 * results/flows), overwritten on each new run — it does not accumulate history.
 */

const DEFAULT_CATEGORIES = ['positive', 'negative', 'schema'];
const ApiTestGenContext = createContext(null);

export function ApiTestGenProvider({ children }) {
    // Inputs
    const [mode, setMode] = useState('url'); // url | text | file | manual
    const [url, setUrl] = useState('');
    const [text, setText] = useState('');
    const [file, setFile] = useState(null);
    const [envFile, setEnvFile] = useState(null);
    const [baseUrl, setBaseUrl] = useState('');
    const [manualRows, setManualRows] = useState([{ method: 'GET', uri: '', expectedStatus: '200' }]);

    // Parse
    const [isParsing, setIsParsing] = useState(false);
    const [error, setError] = useState(null);
    const [catalog, setCatalog] = useState(null);

    // A2 — test-case generation
    const [categories, setCategories] = useState(DEFAULT_CATEGORIES);
    const [selected, setSelected] = useState(() => new Set());
    const [isGenerating, setIsGenerating] = useState(false);
    const [genError, setGenError] = useState(null);
    const [genByEndpoint, setGenByEndpoint] = useState({});
    const [genProgress, setGenProgress] = useState({ done: 0, total: 0 });
    const [genSeconds, setGenSeconds] = useState(null); // elapsed time of the last generation run

    // A3 — automation project download
    const [framework, setFramework] = useState('playwright');
    const [isDownloading, setIsDownloading] = useState(false);
    const [dlError, setDlError] = useState(null);

    // B — process flows
    const [genMode, setGenMode] = useState('endpoints');
    const [flows, setFlows] = useState(null);
    const [isFlowGen, setIsFlowGen] = useState(false);
    const [flowError, setFlowError] = useState(null);
    const [isFlowDl, setIsFlowDl] = useState(false);
    const [flowDlError, setFlowDlError] = useState(null);

    const value = {
        mode, setMode, url, setUrl, text, setText, file, setFile, envFile, setEnvFile,
        baseUrl, setBaseUrl, manualRows, setManualRows,
        isParsing, setIsParsing, error, setError, catalog, setCatalog,
        categories, setCategories, selected, setSelected, isGenerating, setIsGenerating,
        genError, setGenError, genByEndpoint, setGenByEndpoint, genProgress, setGenProgress,
        genSeconds, setGenSeconds,
        framework, setFramework, isDownloading, setIsDownloading, dlError, setDlError,
        genMode, setGenMode, flows, setFlows, isFlowGen, setIsFlowGen,
        flowError, setFlowError, isFlowDl, setIsFlowDl, flowDlError, setFlowDlError,
    };

    return <ApiTestGenContext.Provider value={value}>{children}</ApiTestGenContext.Provider>;
}

export function useApiTestGen() {
    const ctx = useContext(ApiTestGenContext);
    if (!ctx) throw new Error('useApiTestGen must be used within ApiTestGenProvider');
    return ctx;
}
