import React from 'react';
import { Download, Puzzle, CheckCircle2, ArrowRight, X, ExternalLink } from 'lucide-react';

const ExtensionInstallModal = ({ isOpen, onClose }) => {
    if (!isOpen) return null;

    const handleDownload = () => {
        const baseUrl = import.meta.env.BASE_URL.replace(/\/$/, '');
        window.open(`${baseUrl}/api/extension/download`, '_blank');
    };

    return (
        <div className="modal-backdrop-extension" style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            background: 'rgba(15, 23, 42, 0.85)',
            backdropFilter: 'blur(12px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10000,
        }}>
            <div className="modal-content-extension animate-fade-in" style={{
                width: '100%',
                maxWidth: '560px',
                padding: '2rem',
                background: '#1e293b',
                borderRadius: 'var(--radius-lg, 16px)',
                border: '1px solid rgba(255, 255, 255, 0.15)',
                boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.7)',
                color: '#f8fafc',
            }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                        <div style={{
                            background: 'rgba(59, 130, 246, 0.15)',
                            color: '#60a5fa',
                            padding: '0.5rem',
                            borderRadius: '10px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center'
                        }}>
                            <Puzzle size={24} />
                        </div>
                        <div>
                            <h3 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 700, color: '#f8fafc' }}>
                                Install AAQUA Chrome Extension
                            </h3>
                            <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>
                                Required for Live DOM Auto-Healing & Session Cookie Capture
                            </span>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        style={{
                            background: 'none',
                            border: 'none',
                            color: '#94a3b8',
                            cursor: 'pointer',
                            padding: '0.35rem',
                            borderRadius: '6px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center'
                        }}
                    >
                        <X size={20} />
                    </button>
                </div>

                {/* Primary Download Button */}
                <div style={{
                    background: 'linear-gradient(135deg, rgba(59, 130, 246, 0.12), rgba(147, 51, 234, 0.12))',
                    border: '1px solid rgba(99, 102, 241, 0.3)',
                    borderRadius: '12px',
                    padding: '1.25rem',
                    textAlign: 'center',
                    marginBottom: '1.5rem'
                }}>
                    <button
                        onClick={handleDownload}
                        style={{
                            background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
                            color: '#ffffff',
                            border: 'none',
                            borderRadius: '10px',
                            padding: '0.85rem 1.75rem',
                            fontSize: '1rem',
                            fontWeight: 600,
                            cursor: 'pointer',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '0.65rem',
                            boxShadow: '0 4px 15px rgba(59, 130, 246, 0.4)',
                            transition: 'all 0.2s ease',
                            width: '100%',
                            justifyContent: 'center'
                        }}
                    >
                        <Download size={20} />
                        <span>Download AAQUA Extension (.zip)</span>
                    </button>
                    <span style={{ display: 'block', marginTop: '0.5rem', fontSize: '0.78rem', color: '#94a3b8' }}>
                        Includes <code>manifest.json</code>, <code>contentScript.js</code>, and installation guide
                    </span>
                </div>

                {/* Step by Step Guide */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
                    <h4 style={{ margin: 0, fontSize: '0.875rem', textTransform: 'uppercase', letterSpacing: '0.5px', color: '#cbd5e1' }}>
                        Quick 4-Step Setup Guide:
                    </h4>

                    <div style={{ display: 'flex', gap: '0.75rem', background: 'rgba(15, 23, 42, 0.5)', padding: '0.75rem 1rem', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)' }}>
                        <div style={{ background: '#3b82f6', color: '#fff', width: '22px', height: '22px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: 700, flexShrink: 0 }}>1</div>
                        <div style={{ fontSize: '0.85rem', color: '#e2e8f0' }}>
                            Click <strong>Download AAQUA Extension (.zip)</strong> above and extract the zip file to a folder on your computer.
                        </div>
                    </div>

                    <div style={{ display: 'flex', gap: '0.75rem', background: 'rgba(15, 23, 42, 0.5)', padding: '0.75rem 1rem', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)' }}>
                        <div style={{ background: '#3b82f6', color: '#fff', width: '22px', height: '22px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: 700, flexShrink: 0 }}>2</div>
                        <div style={{ fontSize: '0.85rem', color: '#e2e8f0' }}>
                            Open Chrome and go to <code style={{ background: 'rgba(255,255,255,0.1)', padding: '2px 6px', borderRadius: '4px' }}>chrome://extensions</code>
                        </div>
                    </div>

                    <div style={{ display: 'flex', gap: '0.75rem', background: 'rgba(15, 23, 42, 0.5)', padding: '0.75rem 1rem', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)' }}>
                        <div style={{ background: '#3b82f6', color: '#fff', width: '22px', height: '22px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: 700, flexShrink: 0 }}>3</div>
                        <div style={{ fontSize: '0.85rem', color: '#e2e8f0' }}>
                            Enable <strong>Developer mode</strong> (toggle switch in the top-right corner of Chrome).
                        </div>
                    </div>

                    <div style={{ display: 'flex', gap: '0.75rem', background: 'rgba(15, 23, 42, 0.5)', padding: '0.75rem 1rem', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)' }}>
                        <div style={{ background: '#10b981', color: '#fff', width: '22px', height: '22px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: 700, flexShrink: 0 }}>4</div>
                        <div style={{ fontSize: '0.85rem', color: '#e2e8f0' }}>
                            Click <strong>Load unpacked</strong> (top-left) and select your extracted extension folder.
                        </div>
                    </div>
                </div>

                <div style={{ marginTop: '1.5rem', display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                        onClick={onClose}
                        style={{
                            background: 'rgba(255, 255, 255, 0.08)',
                            color: '#cbd5e1',
                            border: '1px solid rgba(255, 255, 255, 0.1)',
                            borderRadius: '8px',
                            padding: '0.5rem 1.25rem',
                            fontSize: '0.875rem',
                            fontWeight: 600,
                            cursor: 'pointer'
                        }}
                    >
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
};

export default ExtensionInstallModal;
