import * as XLSX from 'xlsx';
import * as FileSaverModule from 'file-saver';

const saveAs = FileSaverModule.saveAs || FileSaverModule.default || FileSaverModule || FileSaverModule.saveAs;

const TEXT_FORCE_KEYS = /phone|mobile|tel|zip|pin|postal|code|id|number/i;

/**
 * Displays a premium modal helping the user download files with their original filenames
 * when running inside a sandboxed iframe.
 */
const showDownloadHelperModal = (token, filename) => {
    const API_PREFIX = import.meta.env.BASE_URL.replace(/\/$/, '');
    
    // In development, point directly to backend port 3001 to bypass Vite proxy header issues
    let backendOrigin = window.location.origin;
    if (import.meta.env.DEV) {
        backendOrigin = 'http://localhost:3001';
    }
    const downloadUrl = `${backendOrigin}${API_PREFIX}/api/download/${token}`;
    
    // Create modal element
    const modal = document.createElement('div');
    modal.id = 'download-helper-modal';
    modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        background: rgba(15, 23, 42, 0.85);
        backdrop-filter: blur(8px);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 99999;
        font-family: system-ui, -apple-system, sans-serif;
        color: #f1f5f9;
        animation: fadeIn 0.25s ease-out;
    `;
    
    modal.innerHTML = `
        <div style="background: #1e293b; border: 1px solid #334155; border-radius: 12px; width: 90%; max-width: 480px; padding: 1.5rem; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5); position: relative;">
            <button id="dl-close-btn" style="position: absolute; top: 1rem; right: 1rem; background: none; border: none; color: #94a3b8; cursor: pointer; font-size: 1.25rem;">&times;</button>
            
            <div style="display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1rem;">
                <span style="font-size: 2rem;">📥</span>
                <div>
                    <h3 style="margin: 0; font-size: 1.2rem; font-weight: 600; color: #f8fafc;">File Ready to Download</h3>
                    <p style="margin: 0; font-size: 0.85rem; color: #cbd5e1; word-break: break-all; font-weight: 500;">${filename}</p>
                </div>
            </div>
            
            <p style="font-size: 0.85rem; line-height: 1.5; color: #cbd5e1; margin-bottom: 1.25rem; background: rgba(99, 102, 241, 0.08); padding: 0.75rem; border-radius: 6px; border-left: 3px solid #6366f1; margin-top: 0;">
                <strong>Iframe Sandbox Notice:</strong> Your portal's security prevents direct downloads from keeping their filenames. Please use one of the options below to save the file with its correct name:
            </p>
            
            <div style="display: flex; flex-direction: column; gap: 0.85rem;">
                <!-- Option 1: Copy Link -->
                <div style="display: flex; flex-direction: column; gap: 0.35rem;">
                    <button id="dl-copy-btn" style="background: #6366f1; color: white; border: none; padding: 0.65rem 1rem; border-radius: 6px; font-weight: 600; cursor: pointer; font-size: 0.85rem; display: flex; align-items: center; justify-content: center; gap: 0.5rem; transition: background 0.2s;">
                        📋 Copy Direct Download Link
                    </button>
                    <span style="font-size: 0.75rem; color: #94a3b8; text-align: center;">(Paste this link in a new browser tab and press Enter)</span>
                </div>
                
                <div style="border-top: 1px solid #334155; margin: 0.25rem 0;"></div>
                
                <!-- Option 2: Right-click link -->
                <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.85rem;">
                    <span style="color: #cbd5e1; font-weight: 500;">Alternative:</span>
                    <a href="${downloadUrl}" target="_blank" download="${filename}" style="color: #818cf8; text-decoration: underline; font-weight: 600; transition: color 0.2s;" id="dl-right-click-link">
                        Right-Click here & Save Link As...
                    </a>
                </div>
                
                <!-- Option 3: Fallback UUID download -->
                <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.85rem; margin-top: 0.25rem;">
                    <span style="color: #94a3b8;">Renaming later?</span>
                    <button id="dl-fallback-btn" style="background: none; border: none; color: #94a3b8; text-decoration: underline; cursor: pointer; padding: 0; font-size: 0.85rem;">
                        Download anyway (saves as UUID)
                    </button>
                </div>
            </div>
        </div>
        
        <style>
            @keyframes fadeIn {
                from { opacity: 0; }
                to { opacity: 1; }
            }
            #dl-copy-btn:hover { background: #4f46e5 !important; }
            #dl-close-btn:hover { color: #f8fafc !important; }
            #dl-right-click-link:hover { color: #a5b4fc !important; }
            #dl-fallback-btn:hover { color: #cbd5e1 !important; }
        </style>
    `;
    
    document.body.appendChild(modal);
    
    // Event listeners
    const closeBtn = modal.querySelector('#dl-close-btn');
    const copyBtn = modal.querySelector('#dl-copy-btn');
    const fallbackBtn = modal.querySelector('#dl-fallback-btn');
    
    const closeModal = () => {
        document.body.removeChild(modal);
    };
    
    closeBtn.addEventListener('click', closeModal);
    
    copyBtn.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(downloadUrl);
            copyBtn.textContent = '✅ Copied to Clipboard!';
            copyBtn.style.background = '#10b981';
            setTimeout(() => {
                copyBtn.textContent = '📋 Copy Direct Download Link';
                copyBtn.style.background = '#6366f1';
            }, 2000);
        } catch (e) {
            console.error('Clipboard copy failed:', e);
            alert('Link copied to clipboard: ' + downloadUrl);
        }
    });
    
    fallbackBtn.addEventListener('click', () => {
        // Trigger standard iframe download (saves as UUID)
        const form = document.createElement('form');
        form.method = 'GET';
        form.action = downloadUrl;
        document.body.appendChild(form);
        form.submit();
        document.body.removeChild(form);
        closeModal();
    });
};

/**
 * Downloads a Blob safely under sandboxed iframe environments (like Jira dashboards).
 * Converts the Blob to base64 and coordinates with the backend's transient file cache
 * to serve the file as a native HTTP attachment download. Falls back to standard saveAs
 * if the backend is down or unreachable.
 */
export const downloadBlob = async (blob, filename) => {
    const API_PREFIX = import.meta.env.BASE_URL.replace(/\/$/, '');
    
    // Helper to read Blob to base64 string
    const blobToBase64 = (b) => {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(b);
        });
    };

    try {
        const base64Data = await blobToBase64(blob);
        const response = await fetch(`${API_PREFIX}/api/download/prepare`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                filename,
                base64Data,
                contentType: blob.type || 'application/octet-stream'
            })
        });
        if (!response.ok) throw new Error('Prepare download failed');
        const { token } = await response.json();
        
        // Show the download helper modal to bypass iframe sandbox limits
        showDownloadHelperModal(token, filename);
    } catch (err) {
        console.warn('[HTTP Download] Failed preparing backend download, falling back to client-side Blob:', err);
        // Fallback to client-side FileSaver if backend is down or unreachable
        saveAs(blob, filename);
    }
};

export const exportToExcel = async (data, fileName = 'Functional_Test_Cases', sheetName = 'Sheet1') => {
    if (!data || data.length === 0) return;

    const processedData = data.map(row => {
        const formattedRow = {};
        for (const [key, value] of Object.entries(row)) {
            if (value !== null && typeof value === 'object') {
                formattedRow[key] = Array.isArray(value) ? value.join('\n') : JSON.stringify(value);
            } else {
                formattedRow[key] = value ?? '';
            }
        }
        return formattedRow;
    });

    const worksheet = XLSX.utils.json_to_sheet(processedData);
    const headers = Object.keys(processedData[0] || {});

    // Force text formatting for specific keys
    headers.forEach((key, colIdx) => {
        if (!TEXT_FORCE_KEYS.test(key)) return;
        processedData.forEach((_, rowIdx) => {
            const cellRef = XLSX.utils.encode_cell({ r: rowIdx + 1, c: colIdx });
            if (worksheet[cellRef]) {
                worksheet[cellRef].t = 's';
                worksheet[cellRef].z = '@';
            }
        });
    });

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);

    console.log(`[Export] Writing Excel workbook: ${fileName}.xlsx`);
    const wbout = XLSX.write(workbook, { bookType: 'xlsx', type: 'binary' });
    
    // Construct standard SheetJS binary ArrayBuffer to Blob conversion
    const s2ab = (s) => {
        const buf = new ArrayBuffer(s.length);
        const view = new Uint8Array(buf);
        for (let i = 0; i < s.length; i++) view[i] = s.charCodeAt(i) & 0xFF;
        return buf;
    };
    
    const blob = new Blob([s2ab(wbout)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    await downloadBlob(blob, `${fileName}.xlsx`);
};

export const exportToJSON = async (data, fileName = 'Functional_Test_Cases') => {
    if (!data || data.length === 0) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    await downloadBlob(blob, `${fileName}.json`);
};

export const exportToCSV = async (data, fileName = 'data') => {
    if (!data || data.length === 0) return;
    const headers = Object.keys(data[0]);
    const csv = [
        headers.join(','),
        ...data.map(row => headers.map(f => JSON.stringify(row[f] ?? '')).join(','))
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    await downloadBlob(blob, `${fileName}.csv`);
};
