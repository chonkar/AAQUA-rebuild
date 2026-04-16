const API_URL = "http://localhost:3001/api";

export const generateFramework = async (config) => {
    try {
        const response = await fetch(`${API_URL}/generate-framework`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(config)
        });

        if (!response.ok) {
            const text = await response.text();
            try {
                const errData = JSON.parse(text);
                throw new Error(errData.error || 'Framework generation failed');
            } catch (e) {
                throw new Error(`Server Error (${response.status}): ${text.substring(0, 100)}`);
            }
        }

        const blob = await response.blob();
        return blob;
    } catch (error) {
        console.error("Framework Generation Service Error:", error);
        throw error;
    }
};
