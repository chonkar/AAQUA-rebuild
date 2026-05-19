import * as XLSX from 'xlsx';

const TEXT_FORCE_KEYS = /phone|mobile|tel|zip|pin|postal|code|id|number/i;

function triggerDownload(blob, filename) {
    console.log(`[Export] Triggering download for: ${filename}`);
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    // Delay revocation to ensure browser captures the filename
    setTimeout(() => {
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
    }, 5000);
}

export const exportToExcel = (data, fileName = 'Functional_Test_Cases', sheetName = 'Sheet1') => {
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

    const wbout = XLSX.write(workbook, { bookType: 'xlsx', type: 'array', cellStyles: true });
    const blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    triggerDownload(blob, `${fileName}.xlsx`);
};

export const exportToJSON = (data, fileName = 'Functional_Test_Cases') => {
    if (!data || data.length === 0) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    triggerDownload(blob, `${fileName}.json`);
};

export const exportToCSV = (data, fileName = 'data') => {
    if (!data || data.length === 0) return;
    const headers = Object.keys(data[0]);
    const csv = [
        headers.join(','),
        ...data.map(row => headers.map(f => JSON.stringify(row[f] ?? '')).join(','))
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    triggerDownload(blob, `${fileName}.csv`);
};
